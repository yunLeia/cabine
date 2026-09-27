// Small FASHN experiments (dev tool, not shipped). Spends credits; see README.md.
//
//   node scripts/fashn-trial/experiment.ts bases
//       Model Create: headless mannequin candidates on white → out/exp/base-<seed>.jpg
//   node scripts/fashn-trial/experiment.ts collage <base.jpg> <collage.jpg> "<prompt>" <name>
//       One Try-On Max call with every garment in one product image → out/exp/<name>.jpg

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out', 'exp');
mkdirSync(OUT, { recursive: true });

function apiKey(): string {
  const line = readFileSync(join(HERE, '../../.env.local'), 'utf8').split('\n').find((l) => l.startsWith('FASHN_API_KEY='));
  const key = line?.slice('FASHN_API_KEY='.length).trim();
  if (!key) throw new Error('FASHN_API_KEY missing from .env.local');
  return key;
}

const headers = { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' };

async function run(model: string, inputs: Record<string, unknown>): Promise<{ bytes: Buffer; seconds: number }> {
  const t = Date.now();
  const res = await fetch('https://api.fashn.ai/v1/run', { method: 'POST', headers, body: JSON.stringify({ model_name: model, inputs }) });
  const body = (await res.json()) as { id?: string; error?: unknown };
  if (!body.id) throw new Error(`run ${res.status}: ${JSON.stringify(body.error ?? body)}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = (await (await fetch(`https://api.fashn.ai/v1/status/${body.id}`, { headers })).json()) as {
      status: string;
      output?: string[];
      error?: { message: string };
    };
    if (s.status === 'failed') throw new Error(s.error?.message);
    if (s.status === 'completed') {
      const out = s.output![0];
      const bytes = out.startsWith('data:') ? Buffer.from(out.split(',')[1], 'base64') : Buffer.from(await (await fetch(out)).arrayBuffer());
      return { bytes, seconds: (Date.now() - t) / 1000 };
    }
  }
}

const dataUri = (file: string) =>
  `data:${extname(file) === '.png' ? 'image/png' : extname(file) === '.webp' ? 'image/webp' : 'image/jpeg'};base64,${readFileSync(file).toString('base64')}`;

const BASE_PROMPT =
  'Full-body studio product photo of a white matte fiberglass store display mannequin, not a person. ' +
  'The mannequin is headless: it has NO head at all, the neck is cut off flat just above the shoulders. ' +
  'Standing straight facing the camera, arms relaxed slightly away from the body, legs straight, no clothing, no shoes. ' +
  'Pure white #FFFFFF background, no shadow, no floor, no horizon line, flat even lighting. The whole mannequin in frame from neck to feet.';

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'bases') {
  await Promise.all(
    [7, 11].map(async (seed) => {
      const file = join(OUT, `base-${seed}.jpg`);
      if (existsSync(file)) return console.log(`cached ${file}`);
      const { bytes, seconds } = await run('model-create', {
        prompt: BASE_PROMPT, aspect_ratio: '2:3', resolution: '1k', generation_mode: 'fast', seed, output_format: 'jpeg', return_base64: true,
      });
      writeFileSync(file, bytes);
      console.log(`base seed ${seed}: ${seconds.toFixed(1)}s → ${file}`);
    }),
  );
} else if (cmd === 'collage') {
  const [base, collage, prompt, name] = rest;
  const file = join(OUT, `${name}.jpg`);
  if (existsSync(file)) {
    console.log(`cached ${file}`);
  } else {
    const { bytes, seconds } = await run('tryon-max', {
      model_image: dataUri(resolve(base)), product_image: dataUri(resolve(collage)), prompt,
      generation_mode: 'fast', resolution: '1k', output_format: 'jpeg', return_base64: true,
    });
    writeFileSync(file, bytes);
    console.log(`${name}: ${seconds.toFixed(1)}s → ${file}`);
  }
} else {
  console.log('usage: experiment.ts bases | collage <base> <collage> "<prompt>" <name>');
}
