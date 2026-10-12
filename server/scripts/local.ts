// Local dev server (dev tool): the real handler with an in-memory store and fake
// providers, plus the phone page. No Vercel, no Blob, no FASHN credits.
//
//   node scripts/local.ts            → http://localhost:8787
//   CABINE_CLIENT_KEY=... (optional; defaults to "dev-key")
//
// Try the phone flow: POST /api/upload-session with the key, open the returned
// /add/<token> URL, upload, then POST /api/inbox with the key and token.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { ConflictError, createHandler, type Deps, type Store } from '../api/[action].ts';

const PORT = Number(process.env.PORT ?? 8787);
const files = new Map<string, { bytes: Uint8Array; etag: string; at: number }>();
let n = 0;

const store: Store = {
  async read(path) {
    return files.get(path) ?? null;
  },
  async write(path, bytes, _type, ifMatch) {
    const cur = files.get(path);
    if (ifMatch === null && cur) throw new ConflictError('exists');
    if (ifMatch && cur?.etag !== ifMatch) throw new ConflictError('etag changed');
    files.set(path, { bytes, etag: `e${++n}`, at: Date.now() });
  },
  async list(prefix) {
    return [...files.keys()].filter((k) => k.startsWith(prefix));
  },
  async listOlder(prefix, beforeMs) {
    return [...files].filter(([k, f]) => k.startsWith(prefix) && f.at < beforeMs).map(([k]) => k);
  },
  async remove(paths) {
    for (const p of paths) files.delete(p);
  },
};

// Fakes: a render/extract "result" is just the first garment's own image.
const deps: Deps = {
  store,
  events: { record: async (rows) => console.log('events', rows.map((r) => r.name).join(', ')), countSince: async () => 0, forget: async () => {} },
  provider: { id: 'local-fake', credits: 1, render: async (items) => items[0].bytes },
  extractor: { id: 'local-fake', credits: 1, extract: async (item) => item.bytes },
  clientKey: process.env.CABINE_CLIENT_KEY ?? 'dev-key',
  dailyCreditLimit: 1000,
  userLimits: { looks: 100, cleanups: 100, plans: 100 },
  // "Try a Different Look": a stand-in stylist that takes the first candidate of each
  // kind being moved away from (or of any free kind), so the whole flow works offline.
  planner: {
    id: 'local-fake',
    async plan(input, feedback) {
      const freeKinds = input.current.map((p) => p.category);
      const pool = input.candidates.filter((c) => !input.avoid.some((a) => a.includes(c.id)) || feedback);
      const picks = freeKinds.flatMap((kind) => pool.filter((c) => c.category === kind).slice(0, 1));
      const pieces = (picks.length ? picks : pool.slice(0, 1)).map((c) => ({ id: c.id, why: 'a different feel' }));
      const keptName = input.keep[0]?.title ?? 'piece';
      return { understood: `Got it. I'll keep the ${keptName}${input.vibes.length ? ` and aim for something ${input.vibes.join(' and ')}` : ''}, and try something else from your closet.`, direction: input.vibes.length ? input.vibes.join(', ') : 'A different direction', pieces };
    },
  },
};
const handle = createHandler(() => deps);
const page = new URL('../public/add.html', import.meta.url);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname.startsWith('/add/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(await readFile(page));
  }
  if (req.method === 'GET' && url.pathname === '/_debug/files') {
    // Paths only, and hashes of contents: handy for checking what the server holds.
    const list = [...files.entries()].map(([p, f]) => ({ path: p, bytes: f.bytes.length, sha: createHash('sha256').update(f.bytes).digest('hex').slice(0, 8) }));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(list, null, 2));
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const response = await handle(
      new Request(url, { method: 'POST', headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    return res.end(Buffer.from(await response.arrayBuffer()));
  }
  // Also serve the extension's built panel (../dist), so a test page can call
  // this server from the same origin (the real extension has host permissions).
  if (req.method === 'GET') {
    try {
      const root = resolve(process.env.STATIC_DIR ?? fileURLToPath(new URL('../../dist', import.meta.url)));
      const path = resolve(join(root, url.pathname));
      if (!path.startsWith(root + '/')) throw new Error('outside the static root');
      const file = await readFile(path);
      const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
      res.writeHead(200, { 'content-type': types[extname(url.pathname)] ?? 'application/octet-stream' });
      return res.end(file);
    } catch {
      /* fall through */
    }
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`Cabine local server on http://localhost:${PORT} (key: ${deps.clientKey})`));
