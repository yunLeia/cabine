// One function, two routes (a dynamic route so both share this code):
//   POST /api/style    render an outfit in one call (docs/decisions.md D13, D14, D16)
//   POST /api/extract  clean product photo of one garment, for My Closet (D18, D19)
//
// The extension sends original garment images, categories and titles. This
// function owns everything that costs money: which providers and settings, the
// caches, and the daily spending limit. Both routes stream a small NDJSON feed
// (plan, then result) so the panel knows right away whether it was cached, and
// the connection stays alive while the model works.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BlobPreconditionFailedError, get, put } from '@vercel/blob';
import sharp from 'sharp';

export type Category = 'top' | 'bottom' | 'dress' | 'outerwear' | 'shoes';
const LAYER_ORDER: readonly Category[] = ['bottom', 'dress', 'top', 'outerwear', 'shoes']; // inner layers first

const MAX_ITEMS = 5;
const MAX_IMAGE_BYTES = 3_000_000; // after base64 decoding; the extension downsizes before sending
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const EXCLUSIVE: [Category, Category][] = [['dress', 'top'], ['dress', 'bottom']];

// ---- The render provider abstraction -------------------------------------------------
// Everything model-specific lives behind this interface: swapping FASHN for another
// model means writing a new provider, not touching validation, cache or limits.

export interface Item {
  category: Category;
  title?: string; // product name, tells the model which garment to take from a busy photo
  bytes: Uint8Array;
  mime: string;
  hash: string;
}

export interface RenderProvider {
  // Identifies the model, settings and prompt version. Part of the cache key, so
  // changing any of them never serves a render made the old way.
  id: string;
  credits: number; // per look
  render(items: Item[]): Promise<Uint8Array>; // JPEG bytes of the styled look
}

// Cleans up one garment's photo into a product shot, for My Closet thumbnails only.
// Renders always use the original photo.
export interface ExtractProvider {
  id: string;
  credits: number; // per garment
  extract(item: Item): Promise<Uint8Array>; // JPEG bytes
}

// ---- Other dependencies (swapped for fakes in tests) ------------------------------------

export interface Stored {
  bytes: Uint8Array;
  etag: string;
}

export interface Store {
  read(path: string): Promise<Stored | null>;
  // ifMatch: an etag (update only if unchanged), null (create only if missing), or undefined (overwrite).
  write(path: string, bytes: Uint8Array, contentType: string, ifMatch?: string | null): Promise<void>;
}

export class ConflictError extends Error {}

export interface Deps {
  store: Store;
  provider: RenderProvider;
  extractor: ExtractProvider;
  clientKey: string;
  dailyCreditLimit: number;
  today?: () => string;
}

// ---- Request validation ----------------------------------------------------------------

class RequestError extends Error {}

const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

export function parseItems(body: unknown): Item[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0) throw new RequestError('items must be a non-empty array');
  if (items.length > MAX_ITEMS) throw new RequestError(`at most ${MAX_ITEMS} items`);

  const parsed = items.map((raw, i): Item => {
    const { category, image, title } = (raw ?? {}) as { category?: unknown; image?: unknown; title?: unknown };
    if (typeof category !== 'string' || !LAYER_ORDER.includes(category as Category)) {
      throw new RequestError(`items[${i}].category is invalid`);
    }
    const match = typeof image === 'string' ? /^data:([^;,]+);base64,(.+)$/.exec(image) : null;
    if (!match || !IMAGE_TYPES.has(match[1])) throw new RequestError(`items[${i}].image must be a JPEG, PNG or WebP data URI`);
    const bytes = new Uint8Array(Buffer.from(match[2], 'base64'));
    if (bytes.length > MAX_IMAGE_BYTES) throw new RequestError(`items[${i}].image is larger than ${MAX_IMAGE_BYTES} bytes`);
    // The title comes from a store page: keep it short and plain before it goes in a prompt.
    const cleanTitle = typeof title === 'string' ? title.replace(/[^\p{L}\p{N} .,'&/-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    return { category: category as Category, title: cleanTitle || undefined, bytes, mime: match[1], hash: sha(bytes) };
  });

  const categories = parsed.map((p) => p.category);
  if (new Set(categories).size !== categories.length) throw new RequestError('one garment per category');
  for (const [a, b] of EXCLUSIVE) {
    if (categories.includes(a) && categories.includes(b)) throw new RequestError(`${a} can't be combined with ${b}`);
  }
  return parsed.sort((x, y) => LAYER_ORDER.indexOf(x.category) - LAYER_ORDER.indexOf(y.category));
}

// ---- The render: whole-look cache, then one provider call -----------------------------

// A look is identified by its garments (content hashes, so a replaced image is a
// new look) plus the provider id. The same look again is free and instant.
const lookKey = (items: Item[], provider: RenderProvider) =>
  sha(JSON.stringify([provider.id, items.map((it) => [it.category, it.hash, it.title ?? ''])]));
const lookPath = (key: string) => `looks/${key}.jpg`;

type Event =
  | { type: 'plan'; cached: boolean; credits: number }
  | { type: 'result'; image: string; credits: number }
  | { type: 'error'; code: string; message: string };

async function renderLook(items: Item[], deps: Deps, emit: (e: Event) => void): Promise<void> {
  const started = Date.now();
  const path = lookPath(lookKey(items, deps.provider));
  const hit = await deps.store.read(path);
  const credits = hit ? 0 : deps.provider.credits;
  emit({ type: 'plan', cached: !!hit, credits });

  let image = hit?.bytes;
  if (!image) {
    await reserveCredits(credits, deps);
    image = await deps.provider.render(items);
    await deps.store.write(path, image, 'image/jpeg');
  }
  console.log(JSON.stringify({ event: 'look', provider: deps.provider.id, pieces: items.length, cached: !!hit, credits, seconds: (Date.now() - started) / 1000 }));
  emit({ type: 'result', image: dataUri(image, 'image/jpeg'), credits });
}

// ---- Extraction: one garment → a clean product photo, cached per photo + category ----------

const cleanPath = (item: Item, extractor: ExtractProvider) =>
  `clean/${sha(JSON.stringify([extractor.id, item.category, item.hash, item.title ?? '']))}.jpg`;

async function extractGarment(item: Item, deps: Deps, emit: (e: Event) => void): Promise<void> {
  const started = Date.now();
  const path = cleanPath(item, deps.extractor);
  const hit = await deps.store.read(path);
  const credits = hit ? 0 : deps.extractor.credits;
  emit({ type: 'plan', cached: !!hit, credits });

  let image = hit?.bytes;
  if (!image) {
    await reserveCredits(credits, deps);
    image = await deps.extractor.extract(item);
    await deps.store.write(path, image, 'image/jpeg');
  }
  console.log(JSON.stringify({ event: 'extract', provider: deps.extractor.id, category: item.category, cached: !!hit, credits, seconds: (Date.now() - started) / 1000 }));
  emit({ type: 'result', image: dataUri(image, 'image/jpeg'), credits });
}

const dataUri = (bytes: Uint8Array, mime: string) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

// ---- Spending limit: a daily credit counter with optimistic concurrency ----------------

class LimitError extends Error {}

async function reserveCredits(n: number, deps: Deps): Promise<void> {
  const path = `usage/${(deps.today ?? (() => new Date().toISOString().slice(0, 10)))()}.json`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const existing = await deps.store.read(path);
    const used = existing ? (JSON.parse(Buffer.from(existing.bytes).toString()) as { credits: number }).credits : 0;
    if (used + n > deps.dailyCreditLimit) {
      throw new LimitError(`Daily limit reached (${used}/${deps.dailyCreditLimit} credits used today; this look needs ${n}).`);
    }
    try {
      const body = new TextEncoder().encode(JSON.stringify({ credits: used + n }));
      await deps.store.write(path, body, 'application/json', existing ? existing.etag : null);
      return;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err; // someone else updated it: re-read and retry
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150 * (attempt + 1))); // spread out retries
    }
  }
  throw new Error('Could not update the usage counter');
}

// ---- HTTP handler ---------------------------------------------------------------------------

function authorized(request: Request, clientKey: string): boolean {
  const given = Buffer.from(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(clientKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createHandler(getDeps: () => Deps) {
  return async function POST(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split('/').pop();
    if (action !== 'style' && action !== 'extract') return Response.json({ error: 'not found' }, { status: 404 });
    const deps = getDeps();
    if (!authorized(request, deps.clientKey)) return Response.json({ error: 'unauthorized' }, { status: 401 });

    // /api/style takes { items: [...] }; /api/extract takes one garment { category, image, title? }.
    let items: Item[];
    try {
      const body = (await request.json()) as Record<string, unknown>;
      items = parseItems(action === 'style' ? body : { items: [body] });
    } catch (err) {
      const message = err instanceof RequestError ? err.message : 'invalid JSON body';
      return Response.json({ error: message }, { status: 400 });
    }
    const work = (emit: (e: Event) => void) => (action === 'style' ? renderLook(items, deps, emit) : extractGarment(items[0], deps, emit));

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (e: Event) => controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
        try {
          await work(emit);
        } catch (err) {
          const code = err instanceof LimitError ? 'daily_limit' : 'render_failed';
          console.error(`[${action}]`, code, err);
          emit({ type: 'error', code, message: err instanceof Error ? err.message : String(err) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
  };
}

// ---- FASHN provider: every garment in one Try-On Max call ------------------------------
// Try-On Max takes one product image per call, so the garments are placed side by
// side on white in a single image, and the prompt says which is which and how to
// wear them. Tested against chaining one call per garment (scripts/fashn-trial):
// ~15 s instead of ~40 s, 1 credit per look, and more faithful (D16).

const FASHN = { model: 'tryon-max', generation_mode: 'fast', resolution: '1k' } as const;
const PROMPT_VERSION = 4;

const KEEP_MANNEQUIN =
  'Keep the mannequin exactly as it is: a white matte headless store mannequin with no skin, no head and no hair. Do not turn it into a person. Keep the plain white background with no shadows.';
const FAITHFUL =
  'Reproduce every garment exactly: color, material, texture, silhouette, length, sleeves, neckline, buttons, pockets and collar. Keep full sleeves even over another layer. Do not add, remove or redesign any details.';
// What each category means, and what else a store photo may show that must be left out.
const KIND: Record<Category, { noun: string; examples: string; others: string }> = {
  top: { noun: 'top', examples: 'shirt, blouse, knit, tee or camisole', others: 'bottoms, outerwear, dresses and shoes' },
  bottom: { noun: 'bottom', examples: 'trousers, jeans, shorts or skirt', others: 'tops, sweaters, outerwear and shoes' },
  dress: { noun: 'dress', examples: 'dress or jumpsuit', others: 'outerwear, shoes and accessories' },
  outerwear: { noun: 'outerwear', examples: 'coat, jacket or blazer', others: 'the clothes worn under it, bottoms and shoes' },
  shoes: { noun: 'shoes', examples: 'shoes, boots or sneakers', others: 'all clothing' },
};
const WEAR: Record<Category, string> = {
  bottom: 'the bottom',
  dress: 'the dress',
  top: 'the top worn over the bottom',
  outerwear: 'the outerwear worn open over everything else',
  shoes: "the shoes on the mannequin's feet",
};
const POSITIONS = ['first', 'second', 'third', 'fourth', 'fifth'];

// Store photos often show a whole outfit on a model. Each panel therefore says
// which single garment to take and what to leave out, and the whole prompt says
// the mannequin wears nothing else: a bottom picked from a full-body shot must
// not bring the model's top along with it (seen in production).
export function fashnPrompt(items: Item[]): string {
  const panels = items
    .map((it, i) => {
      const k = KIND[it.category];
      // The title is the store's product name, which may be a different garment
      // than the one the shopper picked from the photo; the category wins.
      const hint = it.title ? ` The store calls this product "${it.title}"; if that names a different garment, still take the ${k.noun}.` : '';
      return `Panel ${i + 1} (${POSITIONS[i]} from the left): use ONLY the ${k.noun}, meaning the ${k.examples}. Ignore ${k.others} and anything else in that panel.${hint}`;
    })
    .join(' ');
  const bare = (['top', 'bottom', 'outerwear', 'shoes'] as const)
    .filter((c) => !items.some((it) => it.category === c || (it.category === 'dress' && (c === 'top' || c === 'bottom'))))
    .map((c) => (c === 'outerwear' ? 'no outerwear' : c === 'shoes' ? 'bare feet' : `no ${c}, leave that part of the mannequin bare`));
  return (
    `The reference image shows ${items.length === 1 ? 'one panel' : `${items.length} panels side by side`}, each with one garment to use. ` +
    `Some panels are store photos of a person wearing several clothes. ${panels} ` +
    `Dress the mannequin in exactly ${items.length === 1 ? 'this one garment' : `these ${items.length} garments`} and nothing else: ${items.map((it) => WEAR[it.category]).join(', ')}.` +
    (bare.length ? ` Everything not listed stays off the mannequin: ${bare.join('; ')}.` : '') +
    ` ${FAITHFUL} ${KEEP_MANNEQUIN}`
  );
}

// Garments left to right in layering order, each scaled to the same height on white.
export async function composeGarments(items: Item[], height = 900, gap = 40): Promise<Buffer> {
  const tiles = await Promise.all(
    items.map((it) => sharp(it.bytes).flatten({ background: '#ffffff' }).resize({ height }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true })),
  );
  const width = tiles.reduce((w, t) => w + t.info.width, 0) + gap * (tiles.length + 1);
  let left = gap;
  const composite = tiles.map((t) => {
    const placed = { input: t.data, left, top: gap };
    left += t.info.width + gap;
    return placed;
  });
  return sharp({ create: { width, height: height + 2 * gap, channels: 3, background: '#ffffff' } })
    .composite(composite)
    .jpeg({ quality: 92 })
    .toBuffer();
}

// The mannequin sits small in FASHN's frame; trim the white margin so the look
// fills the panel, keeping a little breathing room.
async function fillFrame(jpeg: Uint8Array): Promise<Uint8Array> {
  try {
    const { data, info } = await sharp(jpeg).trim({ background: '#ffffff', threshold: 12 }).toBuffer({ resolveWithObject: true });
    const pad = Math.round(Math.max(info.width, info.height) * 0.05);
    return new Uint8Array(
      await sharp(data).extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer(),
    );
  } catch {
    return jpeg; // nothing to trim
  }
}

export function fashnProvider(apiKey: () => string, base: () => Promise<Uint8Array>): RenderProvider {
  return {
    id: `fashn:${FASHN.model}:${FASHN.generation_mode}:${FASHN.resolution}:base-mannequin-v1:prompt-v${PROMPT_VERSION}`,
    credits: 1,
    async render(items) {
      const t = Date.now();
      const collage = await composeGarments(items);
      const out = await fashnRun(apiKey(), FASHN.model, {
        model_image: dataUri(await base(), 'image/jpeg'),
        product_image: dataUri(collage, 'image/jpeg'),
        prompt: fashnPrompt(items),
        generation_mode: FASHN.generation_mode,
        resolution: FASHN.resolution,
        output_format: 'jpeg',
        return_base64: true,
      });
      console.log(JSON.stringify({ event: 'fashn', model: FASHN.model, pieces: items.length, seconds: (Date.now() - t) / 1000 }));
      return fillFrame(out);
    },
  };
}

// FASHN Edit turns a store photo (often a model wearing a whole outfit) into a
// product shot of the one garment the shopper picked. Tested in
// scripts/fashn-trial (D19): faithful for a lace cami, a trench coat, and the
// trousers under that coat; one call per garment (batching them in a grid
// skipped panels).
const EDIT = { model: 'edit', generation_mode: 'fast', resolution: '1k' } as const;
const EXTRACT_PROMPT_VERSION = 1;

export function extractPrompt(item: Item): string {
  const k = KIND[item.category];
  const hint = item.title ? ` The store calls this product "${item.title}"; if that names a different garment, still take the ${k.noun}.` : '';
  return (
    `Turn this photo into a clean e-commerce product photo of only the ${k.noun} (the ${k.examples}) shown in it. Ignore ${k.others}.${hint} ` +
    'Show that garment alone, front view, ghost-mannequin style, centered on a pure white #FFFFFF background. ' +
    'No person, body, skin, hair, mannequin or hanger, no other clothing, and no icons, badges, logos or text from the web page. ' +
    'Keep the garment exactly as it is: color, fabric, texture, pattern, length, neckline, sleeves, buttons, lace, ties, belts, straps and every other detail. ' +
    'Do not add, remove or redesign anything.'
  );
}

export function fashnExtractor(apiKey: () => string): ExtractProvider {
  return {
    id: `fashn:${EDIT.model}:${EDIT.generation_mode}:${EDIT.resolution}:prompt-v${EXTRACT_PROMPT_VERSION}`,
    credits: 1,
    async extract(item) {
      const t = Date.now();
      const out = await fashnRun(apiKey(), EDIT.model, {
        image: dataUri(item.bytes, item.mime),
        prompt: extractPrompt(item),
        generation_mode: EDIT.generation_mode,
        resolution: EDIT.resolution,
        output_format: 'jpeg',
        return_base64: true,
      });
      console.log(JSON.stringify({ event: 'fashn', model: EDIT.model, category: item.category, seconds: (Date.now() - t) / 1000 }));
      return fillFrame(out);
    },
  };
}

async function fashnRun(apiKey: string, model: string, inputs: Record<string, unknown>): Promise<Uint8Array> {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const res = await fetch('https://api.fashn.ai/v1/run', { method: 'POST', headers, body: JSON.stringify({ model_name: model, inputs }) });
  const body = (await res.json()) as { id?: string; error?: unknown };
  if (!res.ok || !body.id) throw new Error(`FASHN run ${res.status}: ${JSON.stringify(body.error ?? body)}`);
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 1000)); // FASHN allows 50 status checks per 10 s
    const s = (await (await fetch(`https://api.fashn.ai/v1/status/${body.id}`, { headers })).json()) as {
      status: string;
      output?: string[];
      error?: { name: string; message: string } | null;
    };
    if (s.status === 'failed') throw new Error(`FASHN ${s.error?.name}: ${s.error?.message}`);
    if (s.status === 'completed' && s.output?.[0]) {
      const out = s.output[0];
      if (out.startsWith('data:')) return new Uint8Array(Buffer.from(out.split(',')[1], 'base64'));
      return new Uint8Array(await (await fetch(out)).arrayBuffer());
    }
  }
  throw new Error('FASHN timed out after 120 s');
}

// ---- Production wiring: private Vercel Blob + FASHN ---------------------------------------

const blobStore: Store = {
  async read(path) {
    // Bypass the CDN cache: a cached copy of the usage counter has a stale etag,
    // so every ifMatch update would fail (seen in production as "Could not update
    // the usage counter"). Looks are read fresh too; they're small and read rarely.
    const r = await get(path, { access: 'private', useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return { bytes: new Uint8Array(await new Response(r.stream).arrayBuffer()), etag: r.blob.etag };
  },
  async write(path, bytes, contentType, ifMatch) {
    try {
      await put(path, Buffer.from(bytes), {
        access: 'private',
        contentType,
        addRandomSuffix: false,
        allowOverwrite: ifMatch !== null,
        ...(ifMatch ? { ifMatch } : {}),
      });
    } catch (err) {
      // All of these mean "someone else wrote it first, re-read and retry": the etag
      // changed, the file was created meanwhile, or Blob rejected a write racing
      // another one ("conflicting operation", seen when two renders overlap).
      if (
        err instanceof BlobPreconditionFailedError ||
        /conflicting operation/i.test(String(err)) ||
        (ifMatch === null && /already exists/i.test(String(err)))
      ) {
        throw new ConflictError(String(err));
      }
      throw err;
    }
  },
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

// The pinned base: one reviewed headless mannequin on white (scripts/fashn-trial,
// seed 11), so every look uses the same figure. Bundled via vercel.json includeFiles.
let baseImage: Promise<Uint8Array> | undefined;
const loadBase = () => (baseImage ??= readFile(new URL('../assets/base-mannequin.jpg', import.meta.url)).then((b) => new Uint8Array(b)));

export const POST = createHandler(() => ({
  store: blobStore,
  // The FASHN key is read only when rendering, so auth and validation work without it.
  provider: fashnProvider(() => env('FASHN_API_KEY'), loadBase),
  extractor: fashnExtractor(() => env('FASHN_API_KEY')),
  clientKey: env('CABINE_CLIENT_KEY'),
  dailyCreditLimit: Number(process.env.DAILY_CREDIT_LIMIT ?? 30),
}));
