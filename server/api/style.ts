// POST /api/style: render an outfit by chaining FASHN try-ons (docs/decisions.md D13, D14).
//
// The extension sends the selected garments' original images and categories.
// This function owns everything that costs money: the FASHN model and settings,
// the layering order, the step cache, and the spending limits. It streams
// progress as newline-delimited JSON so the panel can show each step.

import { createHash, timingSafeEqual } from 'node:crypto';
import { BlobPreconditionFailedError, get, put } from '@vercel/blob';

// ---- Render configuration (bump PROMPT_VERSION to invalidate cached steps) ----

type Category = 'top' | 'bottom' | 'dress' | 'outerwear' | 'shoes';
const CHAIN_ORDER: readonly Category[] = ['bottom', 'dress', 'top', 'outerwear', 'shoes']; // inner layers first
const TRYON = { model: 'tryon-max', generation_mode: 'fast', resolution: '1k' } as const;
const PROMPT_VERSION = 1;
const PROMPTS: Partial<Record<Category, string>> = {}; // e.g. { top: 'tuck in the top' }

// The fixed base every outfit is tried on (generated once, then cached forever).
const BASE = {
  model: 'model-create',
  inputs: {
    prompt:
      'Full-body studio fashion photo of a woman standing straight, facing the camera, arms relaxed slightly away from the body, ' +
      'wearing a plain fitted white tank top and plain fitted light grey leggings, white sneakers, neutral expression, ' +
      'plain light grey seamless background, soft even lighting, entire body in frame from head to feet',
    aspect_ratio: '2:3',
    resolution: '1k',
    generation_mode: 'fast',
    seed: 42,
  },
} as const;

const MAX_ITEMS = 5;
const MAX_IMAGE_BYTES = 3_000_000; // after base64 decoding; the extension downsizes before sending
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']); // what FASHN accepts
const EXCLUSIVE: [Category, Category][] = [['dress', 'top'], ['dress', 'bottom']];

// ---- Dependencies (swapped for fakes in tests) ---------------------------------

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

export interface Fashn {
  run(model: string, inputs: Record<string, unknown>): Promise<Uint8Array>; // resolves to JPEG bytes
}

export interface Deps {
  store: Store;
  fashn: Fashn;
  clientKey: string;
  dailyCreditLimit: number;
  today?: () => string;
}

// ---- Request validation ---------------------------------------------------------

interface Item {
  category: Category;
  bytes: Uint8Array;
  mime: string;
  hash: string;
}

class RequestError extends Error {}

const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

function parseItems(body: unknown): Item[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0) throw new RequestError('items must be a non-empty array');
  if (items.length > MAX_ITEMS) throw new RequestError(`at most ${MAX_ITEMS} items`);

  const parsed = items.map((raw, i): Item => {
    const { category, image } = (raw ?? {}) as { category?: unknown; image?: unknown };
    if (typeof category !== 'string' || !CHAIN_ORDER.includes(category as Category)) {
      throw new RequestError(`items[${i}].category is invalid`);
    }
    const match = typeof image === 'string' ? /^data:([^;,]+);base64,(.+)$/.exec(image) : null;
    if (!match || !IMAGE_TYPES.has(match[1])) throw new RequestError(`items[${i}].image must be a JPEG, PNG or WebP data URI`);
    const bytes = new Uint8Array(Buffer.from(match[2], 'base64'));
    if (bytes.length > MAX_IMAGE_BYTES) throw new RequestError(`items[${i}].image is larger than ${MAX_IMAGE_BYTES} bytes`);
    return { category: category as Category, bytes, mime: match[1], hash: sha(bytes) };
  });

  const categories = parsed.map((p) => p.category);
  if (new Set(categories).size !== categories.length) throw new RequestError('one garment per category');
  for (const [a, b] of EXCLUSIVE) {
    if (categories.includes(a) && categories.includes(b)) throw new RequestError(`${a} can't be combined with ${b}`);
  }
  return parsed.sort((x, y) => CHAIN_ORDER.indexOf(x.category) - CHAIN_ORDER.indexOf(y.category));
}

// ---- The chain --------------------------------------------------------------------

// Each step is content-addressed by everything that affects its output, including
// the previous step's key. So a cached step is valid whenever its key matches,
// and changing only the last garment reuses every step before it.
const baseKey = sha(JSON.stringify(BASE));
const stepKey = (prevKey: string, item: Item) =>
  sha(JSON.stringify([prevKey, item.category, item.hash, TRYON, PROMPT_VERSION, PROMPTS[item.category] ?? '']));
const stepPath = (key: string) => `steps/${key}.jpg`;

type Event =
  | { type: 'plan'; steps: { category: Category | 'base'; cached: boolean }[]; credits: number }
  | { type: 'step'; index: number; category: Category | 'base'; status: 'running' | 'done'; seconds?: number }
  | { type: 'result'; image: string; credits: number }
  | { type: 'error'; code: string; message: string };

async function renderChain(items: Item[], deps: Deps, emit: (e: Event) => void): Promise<void> {
  const keys = [baseKey];
  for (const item of items) keys.push(stepKey(keys[keys.length - 1], item));

  // Find the furthest step that's already rendered; everything after it must be made.
  let from = -1;
  let current: Uint8Array | null = null;
  for (let i = keys.length - 1; i >= 0; i--) {
    const hit = await deps.store.read(stepPath(keys[i]));
    if (hit) {
      from = i;
      current = hit.bytes;
      break;
    }
  }

  const labels: (Category | 'base')[] = ['base', ...items.map((it) => it.category)];
  const credits = keys.length - 1 - from; // one credit per missing step (fast, 1k)
  emit({ type: 'plan', steps: labels.map((category, i) => ({ category, cached: i <= from })), credits });

  if (credits > 0) await reserveCredits(credits, deps);

  for (let i = from + 1; i < keys.length; i++) {
    emit({ type: 'step', index: i, category: labels[i], status: 'running' });
    const started = Date.now();
    current =
      i === 0
        ? await deps.fashn.run(BASE.model, { ...BASE.inputs, output_format: 'jpeg', return_base64: true })
        : await deps.fashn.run(TRYON.model, {
            model_image: dataUri(current!, 'image/jpeg'),
            product_image: dataUri(items[i - 1].bytes, items[i - 1].mime),
            generation_mode: TRYON.generation_mode,
            resolution: TRYON.resolution,
            output_format: 'jpeg',
            return_base64: true,
            ...(PROMPTS[items[i - 1].category] ? { prompt: PROMPTS[items[i - 1].category] } : {}),
          });
    await deps.store.write(stepPath(keys[i]), current, 'image/jpeg');
    emit({ type: 'step', index: i, category: labels[i], status: 'done', seconds: (Date.now() - started) / 1000 });
  }

  emit({ type: 'result', image: dataUri(current!, 'image/jpeg'), credits });
}

const dataUri = (bytes: Uint8Array, mime: string) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

// ---- Spending limit: a daily credit counter with optimistic concurrency ----------

class LimitError extends Error {}

async function reserveCredits(n: number, deps: Deps): Promise<void> {
  const path = `usage/${(deps.today ?? (() => new Date().toISOString().slice(0, 10)))()}.json`;
  for (let attempt = 0; attempt < 5; attempt++) {
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
    }
  }
  throw new Error('Could not update the usage counter');
}

// ---- HTTP handler --------------------------------------------------------------------

function authorized(request: Request, clientKey: string): boolean {
  const given = Buffer.from(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(clientKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createHandler(getDeps: () => Deps) {
  return async function POST(request: Request): Promise<Response> {
    const deps = getDeps();
    if (!authorized(request, deps.clientKey)) return Response.json({ error: 'unauthorized' }, { status: 401 });

    let items: Item[];
    try {
      items = parseItems(await request.json());
    } catch (err) {
      const message = err instanceof RequestError ? err.message : 'invalid JSON body';
      return Response.json({ error: message }, { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (e: Event) => controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
        try {
          await renderChain(items, deps, emit);
        } catch (err) {
          const code = err instanceof LimitError ? 'daily_limit' : 'render_failed';
          console.error('[style]', code, err);
          emit({ type: 'error', code, message: err instanceof Error ? err.message : String(err) });
        } finally {
          controller.close();
        }
      },
    });
    // Streamed so the client sees progress during the ~10 s per step, and so an
    // idle connection isn't dropped mid-render.
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
  };
}

// ---- Production wiring: private Vercel Blob + the real FASHN API ---------------------

const blobStore: Store = {
  async read(path) {
    const r = await get(path, { access: 'private' });
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
      // Precondition failures (etag changed, or the file was created meanwhile) mean "retry".
      if (err instanceof BlobPreconditionFailedError || (ifMatch === null && /already exists/i.test(String(err)))) {
        throw new ConflictError(String(err));
      }
      throw err;
    }
  },
};

export function fashnClient(apiKey: string): Fashn {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  return {
    async run(model, inputs) {
      const res = await fetch('https://api.fashn.ai/v1/run', { method: 'POST', headers, body: JSON.stringify({ model_name: model, inputs }) });
      const body = (await res.json()) as { id?: string; error?: unknown };
      if (!res.ok || !body.id) throw new Error(`FASHN run ${res.status}: ${JSON.stringify(body.error ?? body)}`);
      for (const deadline = Date.now() + 120_000; Date.now() < deadline; ) {
        await new Promise((r) => setTimeout(r, 2000));
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
    },
  };
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const POST = createHandler(() => ({
  store: blobStore,
  // Read the key only when rendering, so auth and validation work (and can be
  // checked after deploying) before a FASHN key is configured.
  fashn: { run: (model, inputs) => fashnClient(env('FASHN_API_KEY')).run(model, inputs) },
  clientKey: env('CABINE_CLIENT_KEY'),
  dailyCreditLimit: Number(process.env.DAILY_CREDIT_LIMIT ?? 30),
}));
