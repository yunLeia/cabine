// FASHN try-on trial (dev tool, not shipped). Builds a few outfits by chaining
// single-garment try-ons (base person -> + bottom -> + top -> + outerwear) with
// two FASHN models, and writes a side-by-side report. See README.md.
//
//   node scripts/fashn-trial/trial.ts               dry run: plan + credit estimate, no network
//   node scripts/fashn-trial/trial.ts --mock        full run against a fake API, no credits
//   node scripts/fashn-trial/trial.ts --live --yes  real run, spends credits
//
// Options: --only v16|max   --max-credits N (default 30)   --base <image file>

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = join(HERE, 'out');
const CACHE = join(OUT, 'cache');
const INPUTS = join(HERE, 'inputs'); // white-background copies made by prep.py
const API = 'https://api.fashn.ai/v1';

// ---- What to test -----------------------------------------------------------

type Slot = 'bottom' | 'top' | 'outerwear';
const SLOT_ORDER: Slot[] = ['bottom', 'top', 'outerwear']; // try-on order = layering order

interface Garment {
  slot: Slot;
  src: string; // a file in inputs/, or an https:// product image URL (what the extension would send)
  prompt?: string; // styling instruction, Try-On Max only
}

const GARMENTS: Record<string, Garment> = {
  'sweater-puff-grey': { slot: 'top', src: 'sweater-puff-grey.jpg', prompt: 'tuck in the sweater' },
  'tee-cream-cropped': { slot: 'top', src: 'tee-cream-cropped.jpg' },
  'top-cowl-grey': { slot: 'top', src: 'top-cowl-grey.jpg' },
  'jeans-dark-highrise': { slot: 'bottom', src: 'jeans-dark-highrise.jpg' },
  'jeans-skinny-ripped': { slot: 'bottom', src: 'jeans-skinny-ripped.jpg' },
  'skirt-black-mini': { slot: 'bottom', src: 'skirt-black-mini.jpg' },
  'jacket-boucle-black': { slot: 'outerwear', src: 'jacket-boucle-black.jpg', prompt: 'wear the jacket open' },
  // On-model store photos: add entries with the image URL, e.g.
  // 'store-blazer': { slot: 'outerwear', src: 'https://.../blazer.jpg' },
};

const OUTFITS: { name: string; garments: string[] }[] = [
  { name: 'Sweater + high-rise jeans', garments: ['jeans-dark-highrise', 'sweater-puff-grey'] },
  { name: 'Cropped tee + mini skirt + bouclé jacket', garments: ['skirt-black-mini', 'tee-cream-cropped', 'jacket-boucle-black'] },
  { name: 'Cowl top + ripped jeans + bouclé jacket', garments: ['jeans-skinny-ripped', 'top-cowl-grey', 'jacket-boucle-black'] },
];

// The fixed "mannequin": one generated person every outfit is tried on.
// Plain fitted base clothes so each try-on has something simple to replace.
const BASE = {
  model: 'model-create',
  credits: 1,
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
};

interface Variant {
  id: string;
  label: string;
  model: string;
  credits: number; // per step
  inputs: (g: Garment, modelImage: string, garmentImage: string) => Record<string, unknown>;
}

const VARIANTS: Variant[] = [
  {
    id: 'v16',
    label: 'Try-On v1.6 (balanced)',
    model: 'tryon-v1.6',
    credits: 1,
    inputs: (g, modelImage, garmentImage) => ({
      model_image: modelImage,
      garment_image: garmentImage,
      category: g.slot === 'bottom' ? 'bottoms' : 'tops', // v1.6 has no outerwear category
      mode: 'balanced',
    }),
  },
  {
    id: 'max',
    label: 'Try-On Max (fast, 1k)',
    model: 'tryon-max',
    credits: 1,
    inputs: (g, modelImage, garmentImage) => ({
      model_image: modelImage,
      product_image: garmentImage,
      generation_mode: 'fast',
      resolution: '1k',
      ...(g.prompt ? { prompt: g.prompt } : {}),
    }),
  },
];

// ---- CLI and environment -------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const MODE: 'dry' | 'mock' | 'live' = flag('live') ? 'live' : flag('mock') ? 'mock' : 'dry';
const MAX_CREDITS = Number(option('max-credits') ?? 30);
const ONLY = option('only');
const BASE_FILE = option('base');
const variants = VARIANTS.filter((v) => !ONLY || v.id === ONLY);

// The key comes from the environment or a git-ignored .env.local; never from the command line.
function apiKey(): string | undefined {
  if (process.env.FASHN_API_KEY) return process.env.FASHN_API_KEY;
  const env = join(ROOT, '.env.local');
  if (!existsSync(env)) return undefined;
  const line = readFileSync(env, 'utf8').split('\n').find((l) => l.startsWith('FASHN_API_KEY='));
  return line?.slice('FASHN_API_KEY='.length).trim().replace(/^["']|["']$/g, '') || undefined;
}

// ---- Images ------------------------------------------------------------------

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const EXT: Record<string, string> = Object.fromEntries(Object.entries(MIME).map(([e, m]) => [m, e]));

function garmentPath(g: Garment): string {
  return g.src.startsWith('https://') ? g.src : join(INPUTS, g.src);
}

function dataUri(file: string): string {
  return `data:${MIME[extname(file).toLowerCase()] ?? 'image/png'};base64,${readFileSync(file).toString('base64')}`;
}

// Local files are sent as data URIs; URLs are passed through for FASHN to fetch.
function asInput(pathOrUrl: string): string {
  return pathOrUrl.startsWith('https://') ? pathOrUrl : dataUri(pathOrUrl);
}

async function download(src: string, base: string): Promise<string> {
  let bytes: Buffer;
  let mime: string;
  if (src.startsWith('data:')) {
    const [head, b64] = src.split(',');
    mime = head.slice(5).split(';')[0];
    bytes = Buffer.from(b64, 'base64');
  } else {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`download ${res.status}`);
    mime = res.headers.get('content-type')?.split(';')[0] ?? 'image/png';
    bytes = Buffer.from(await res.arrayBuffer());
  }
  const file = `${base}${EXT[mime] ?? '.png'}`;
  writeFileSync(file, bytes);
  return file;
}

// ---- FASHN client (real and mock share one interface) ------------------------

interface Api {
  run(model: string, inputs: Record<string, unknown>): Promise<string>; // resolves to the output image URL
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function liveApi(key: string): Api {
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  return {
    async run(model, inputs) {
      const res = await fetch(`${API}/run`, { method: 'POST', headers, body: JSON.stringify({ model_name: model, inputs }) });
      const body = (await res.json()) as { id?: string; error?: unknown };
      if (!res.ok || !body.id) throw new Error(`run ${res.status}: ${JSON.stringify(body.error ?? body)}`);
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        await sleep(2500);
        const s = (await (await fetch(`${API}/status/${body.id}`, { headers })).json()) as {
          status: string;
          output?: string[];
          error?: { name: string; message: string } | null;
        };
        if (s.status === 'completed' && s.output?.[0]) return s.output[0];
        if (s.status === 'failed') throw new Error(`${s.error?.name}: ${s.error?.message}`);
      }
      throw new Error('timed out after 240 s');
    },
  };
}

// Echoes the model image back (base = the extension's mannequin drawing), so the
// orchestration, caching and report can be checked without spending credits.
const mockApi: Api = {
  async run(model, inputs) {
    await sleep(150);
    if (model === 'model-create') return dataUri(join(ROOT, 'public/mannequin.svg'));
    return String(inputs.model_image);
  },
};

async function balance(key: string): Promise<number> {
  const res = await fetch(`${API}/credits`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`credits ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { credits: { total: number } }).credits.total;
}

// ---- Plan: every step is content-addressed, so reruns reuse finished steps ----

interface Step {
  key: string;
  label: string;
  model: string;
  credits: number;
  garment?: string;
  prev?: Step;
  buildInputs?: (modelImage: string) => Record<string, unknown>;
}

interface Result {
  file: string; // local copy
  remote: string; // FASHN CDN URL (valid ~3 days) or data URI
  seconds: number;
  credits: number;
  createdAt: number;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const cacheMeta = (key: string) => join(CACHE, `${key}.json`);
const cached = (key: string): Result | undefined =>
  existsSync(cacheMeta(key)) ? (JSON.parse(readFileSync(cacheMeta(key), 'utf8')) as Result) : undefined;

// Separate caches per mode: mock results must never stand in for real ones.
const baseStep: Step = BASE_FILE
  ? { key: hash(`file:${resolve(BASE_FILE)}`), label: 'Base (your file)', model: 'file', credits: 0 }
  : { key: hash(`${MODE === 'mock' ? 'mock:' : ''}${JSON.stringify(BASE)}`), label: 'Base person', model: BASE.model, credits: BASE.credits };

const chains = OUTFITS.flatMap((outfit) =>
  variants.map((variant) => {
    const ordered = [...outfit.garments].sort(
      (a, b) => SLOT_ORDER.indexOf(GARMENTS[a].slot) - SLOT_ORDER.indexOf(GARMENTS[b].slot),
    );
    let prev = baseStep;
    const steps = ordered.map((id) => {
      const g = GARMENTS[id];
      const src = garmentPath(g);
      const step: Step = {
        key: hash(`${prev.key}|${variant.model}|${id}|${src}|${g.prompt ?? ''}`),
        label: `+ ${id}`,
        model: variant.model,
        credits: variant.credits,
        garment: id,
        prev,
        buildInputs: (modelImage) => variant.inputs(g, modelImage, asInput(src)),
      };
      prev = step;
      return step;
    });
    return { outfit, variant, steps };
  }),
);

// ---- Run ------------------------------------------------------------------------

async function main() {
  mkdirSync(CACHE, { recursive: true });

  const missing = Object.values(GARMENTS)
    .map(garmentPath)
    .filter((p) => !p.startsWith('https://') && !existsSync(p));
  if (missing.length) throw new Error(`Missing inputs (run prep.py first):\n  ${missing.join('\n  ')}`);
  if (BASE_FILE && !existsSync(BASE_FILE)) throw new Error(`--base file not found: ${BASE_FILE}`);

  const unique = new Map<string, Step>();
  for (const s of [baseStep, ...chains.flatMap((c) => c.steps)]) unique.set(s.key, s);
  const todo = [...unique.values()].filter((s) => !cached(s.key) && s.model !== 'file');
  const estimate = todo.reduce((n, s) => n + s.credits, 0);

  console.log(`Mode: ${MODE}. ${OUTFITS.length} outfits × ${variants.length} models = ${chains.length} chains, ${unique.size} steps.`);
  for (const c of chains) console.log(`  ${c.variant.id.padEnd(4)} ${c.outfit.name}: ${c.steps.map((s) => s.garment).join(' → ')}`);
  console.log(`To run: ${todo.length} steps (${unique.size - todo.length} cached). Estimate: ${estimate} credits ≈ $${(estimate * 0.075).toFixed(2)}.`);

  if (MODE === 'dry') {
    console.log('\nDry run only. Use --mock to test without credits, or --live --yes to spend credits.');
    return;
  }

  let api = mockApi;
  if (MODE === 'live') {
    const key = apiKey();
    if (!key) throw new Error('FASHN_API_KEY not set (export it, or put it in .env.local at the repo root).');
    const have = await balance(key);
    console.log(`Balance: ${have} credits.`);
    if (estimate > have) throw new Error(`Needs ${estimate} credits, balance is ${have}.`);
    if (estimate > MAX_CREDITS) throw new Error(`Estimate ${estimate} exceeds --max-credits ${MAX_CREDITS}.`);
    if (!flag('yes')) throw new Error('Add --yes to confirm spending credits.');
    api = liveApi(key);
  }

  // One in-flight promise per step, so chains that share a prefix (like the base) run it once.
  const inflight = new Map<string, Promise<Result>>();
  const execute = (step: Step): Promise<Result> => {
    const done = cached(step.key);
    if (done) return Promise.resolve(done);
    if (!inflight.has(step.key)) inflight.set(step.key, runStep(step));
    return inflight.get(step.key)!;
  };

  async function runStep(step: Step): Promise<Result> {
    if (step.model === 'file') {
      const file = await download(dataUri(resolve(BASE_FILE!)), join(CACHE, step.key));
      return save(step, { file, remote: dataUri(resolve(BASE_FILE!)), seconds: 0, credits: 0, createdAt: Date.now() });
    }
    const prev = step.prev ? await execute(step.prev) : undefined;
    // FASHN's CDN URLs expire after ~3 days; fall back to the local copy after that.
    const modelImage = prev && Date.now() - prev.createdAt < 2.5 * 86_400_000 ? prev.remote : prev ? dataUri(prev.file) : '';
    const inputs = step.buildInputs ? step.buildInputs(modelImage) : BASE.inputs;
    const t = Date.now();
    const remote = await api.run(step.model, inputs);
    const seconds = (Date.now() - t) / 1000;
    const file = await download(remote, join(CACHE, step.key));
    console.log(`  ✓ ${step.label.padEnd(26)} ${step.model.padEnd(12)} ${seconds.toFixed(1)}s`);
    return save(step, { file, remote, seconds, credits: step.credits, createdAt: Date.now() });
  }

  function save(step: Step, r: Result): Result {
    writeFileSync(cacheMeta(step.key), JSON.stringify(r, null, 2));
    return r;
  }

  // FASHN allows 6 concurrent requests; chains run in parallel, steps within a chain in order.
  const errors = new Map<string, string>();
  await Promise.all(
    chains.map(async (c) => {
      for (const s of c.steps) {
        try {
          await execute(s);
        } catch (err) {
          errors.set(s.key, err instanceof Error ? err.message : String(err));
          console.log(`  ✗ ${c.variant.id} ${s.label}: ${errors.get(s.key)}`);
          return; // later steps depend on this one
        }
      }
    }),
  );

  writeReport(errors);
  const spent = [...unique.values()].reduce((n, s) => n + (cached(s.key) && todo.includes(s) ? s.credits : 0), 0);
  console.log(`\nDone. Credits used this run: ${MODE === 'live' ? spent : 0}. Report: ${relative(ROOT, join(OUT, 'report.html'))}`);
}

// ---- Report ---------------------------------------------------------------------

function writeReport(errors: Map<string, string>) {
  const rel = (f: string) => relative(OUT, f);
  const img = (src: string, cls = '') => `<img class="${cls}" src="${src}" loading="lazy">`;
  const cell = (s: Step) => {
    const r = cached(s.key);
    if (r) return `<figure>${img(rel(r.file))}<figcaption>${s.label}<br>${r.seconds.toFixed(1)}s · ${r.credits} cr</figcaption></figure>`;
    const e = errors.get(s.key);
    return `<figure class="missing"><div>${e ? `✗ ${escape(e)}` : 'not run'}</div><figcaption>${s.label}</figcaption></figure>`;
  };
  const base = cached(baseStep.key);

  const sections = OUTFITS.map((outfit) => {
    const garments = outfit.garments
      .map((id) => {
        const p = garmentPath(GARMENTS[id]);
        return `<figure>${img(p.startsWith('https://') ? p : rel(p), 'garment')}<figcaption>${id}</figcaption></figure>`;
      })
      .join('');
    const rows = chains
      .filter((c) => c.outfit === outfit)
      .map((c) => {
        const total = c.steps.map((s) => cached(s.key)).filter(Boolean) as Result[];
        const secs = total.reduce((n, r) => n + r.seconds, 0);
        const cr = total.reduce((n, r) => n + r.credits, 0);
        return `<div class="row"><h3>${c.variant.label}<small>${secs.toFixed(0)}s · ${cr} cr ≈ $${(cr * 0.075).toFixed(2)}</small></h3>
          <div class="steps">${c.steps.map(cell).join('')}</div></div>`;
      })
      .join('');
    return `<section><h2>${outfit.name}</h2><div class="steps garments">${garments}</div>${rows}</section>`;
  }).join('');

  writeFileSync(
    join(OUT, 'report.html'),
    `<!doctype html><meta charset="utf-8"><title>FASHN trial</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; color: #1c1b19; background: #fff; }
  h2 { margin: 32px 0 8px; } h3 { margin: 12px 0 6px; font-size: 14px; } h3 small { font-weight: 400; color: #6f6b64; margin-left: 8px; }
  .steps { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
  figure { margin: 0; } figcaption { font-size: 12px; color: #6f6b64; max-width: 220px; }
  img { height: 330px; border-radius: 8px; background: #f5f2ec; display: block; }
  img.garment { height: 130px; }
  .missing div { width: 220px; height: 330px; display: grid; place-items: center; text-align: center; background: #f7e9e6; border-radius: 8px; padding: 8px; }
  .meta { color: #6f6b64; }
</style>
<h1>FASHN trial <span class="meta">(${MODE})</span></h1>
<p class="meta">Judge each final image: natural? faithful to the garments? consistent person across outfits? time and cost acceptable?</p>
${base ? `<figure>${img(rel(base.file))}<figcaption>${baseStep.label}</figcaption></figure>` : ''}
${sections}`,
  );
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
