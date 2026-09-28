// One function, several routes (a dynamic route, so they share this code):
//   POST /api/style           render an outfit in one call (docs/decisions.md D13, D14, D16)
//   POST /api/extract         clean product photo of one garment, for My Closet (D18, D19)
//   POST /api/upload-session  QR token for adding clothes from a phone (D21)
//   POST /api/inbox           the extension pulls phone uploads for its token
//   POST /api/inbox-ack       ...and deletes them once saved locally
//   POST /api/inbox-session   the phone page checks its token (token only, no client key)
//   POST /api/inbox-upload    the phone page uploads one photo (token only, no client key)
//   POST /api/events          the extension's product-analytics events (D23)
//   GET  /api/cleanup         daily cron: deletes expired sessions and unclaimed photos
//
// The extension sends original garment images, categories and titles. This
// function owns everything that costs money: which providers and settings, the
// caches, and the daily spending limit. Both routes stream a small NDJSON feed
// (plan, then result) so the panel knows right away whether it was cached, and
// the connection stays alive while the model works.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BlobPreconditionFailedError, del, get, list, put } from '@vercel/blob';
import { neon } from '@neondatabase/serverless';
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
  list(prefix: string): Promise<string[]>; // pathnames
  remove(paths: string[]): Promise<void>;
}

export class ConflictError extends Error {}

// Analytics rows (D23): no photos, titles or URLs; the install id is hashed.
export interface EventRow {
  userHash: string;
  name: string;
  props: Record<string, EventValue>;
  at: number; // ms since epoch, when it happened
}
export type EventValue = string | number | boolean | string[];
export interface EventSink {
  record(rows: EventRow[]): Promise<void>;
  countSince(userHash: string, sinceMs: number): Promise<number>; // events received for this install
}

export interface Deps {
  store: Store;
  events: EventSink;
  provider: RenderProvider;
  extractor: ExtractProvider;
  clientKey: string;
  dailyCreditLimit: number; // across everyone: the global budget
  userLimits: { looks: number; cleanups: number }; // per person per day
  today?: () => string;
  now?: () => number;
  lockWaitMs?: number; // how long a duplicate request waits for the first one's result
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

async function renderLook(items: Item[], userId: string, deps: Deps, emit: (e: Event) => void): Promise<void> {
  const started = Date.now();
  const path = lookPath(lookKey(items, deps.provider));
  const { image, cached, credits } = await paidWork('looks', path, deps.provider.credits, userId, deps, emit, () => deps.provider.render(items));
  console.log(JSON.stringify({ event: 'look', provider: deps.provider.id, pieces: items.length, cached, credits, seconds: (Date.now() - started) / 1000 }));
  emit({ type: 'result', image: dataUri(image, 'image/jpeg'), credits });
}

// ---- Extraction: one garment → a clean product photo, cached per photo + category ----------

const cleanPath = (item: Item, extractor: ExtractProvider) =>
  `clean/${sha(JSON.stringify([extractor.id, item.category, item.hash, item.title ?? '']))}.jpg`;

async function extractGarment(item: Item, userId: string, deps: Deps, emit: (e: Event) => void): Promise<void> {
  const started = Date.now();
  const path = cleanPath(item, deps.extractor);
  const { image, cached, credits } = await paidWork('cleanups', path, deps.extractor.credits, userId, deps, emit, () => deps.extractor.extract(item));
  console.log(JSON.stringify({ event: 'extract', provider: deps.extractor.id, category: item.category, cached, credits, seconds: (Date.now() - started) / 1000 }));
  emit({ type: 'result', image: dataUri(image, 'image/jpeg'), credits });
}

const dataUri = (bytes: Uint8Array, mime: string) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

// ---- Paid work: cache, duplicate protection, then per-user and global limits --------------

type Kind = 'looks' | 'cleanups';

async function paidWork(
  kind: Kind,
  path: string,
  credits: number,
  userId: string,
  deps: Deps,
  emit: (e: Event) => void,
  produce: () => Promise<Uint8Array>,
): Promise<{ image: Uint8Array; cached: boolean; credits: number }> {
  const hit = await deps.store.read(path);
  if (hit) {
    emit({ type: 'plan', cached: true, credits: 0 }); // cached results are free and don't count
    return { image: hit.bytes, cached: true, credits: 0 };
  }

  // The same look or photo already being made (a second window, a retry mid-render):
  // wait for that result instead of paying twice.
  const lock = await takeLock(path, deps);
  if (!lock) {
    emit({ type: 'plan', cached: true, credits: 0 });
    const waited = await waitFor(path, deps);
    if (waited) return { image: waited, cached: true, credits: 0 };
    throw new Error('Still working on this one from another request.');
  }
  try {
    emit({ type: 'plan', cached: false, credits });
    await reserve(kind, credits, userId, deps);
    const image = await produce();
    await deps.store.write(path, image, 'image/jpeg');
    return { image, cached: false, credits };
  } finally {
    await deps.store.remove([lock]).catch(() => {});
  }
}

const LOCK_STALE_MS = 3 * 60_000; // a crashed request's lock expires; a render takes ~15 s

async function takeLock(path: string, deps: Deps): Promise<string | null> {
  const lock = `locks/${sha(path)}.json`;
  const body = new TextEncoder().encode(JSON.stringify({ at: now(deps) }));
  try {
    await deps.store.write(lock, body, 'application/json', null); // create only if missing
    return lock;
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
  }
  const held = await deps.store.read(lock);
  const at = held ? (JSON.parse(Buffer.from(held.bytes).toString()) as { at: number }).at : 0;
  if (held && now(deps) - at < LOCK_STALE_MS) return null;
  try {
    await deps.store.write(lock, body, 'application/json', held ? held.etag : null); // take over a stale lock
    return lock;
  } catch (err) {
    if (err instanceof ConflictError) return null;
    throw err;
  }
}

async function waitFor(path: string, deps: Deps): Promise<Uint8Array | null> {
  const until = Date.now() + (deps.lockWaitMs ?? 100_000);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.min(2000, deps.lockWaitMs ?? 2000)));
    const done = await deps.store.read(path);
    if (done) return done.bytes;
  }
  return null;
}

class LimitError extends Error {} // the global daily budget
class UserLimitError extends Error {} // this person's daily allowance

const today = (deps: Deps) => (deps.today ?? (() => new Date().toISOString().slice(0, 10)))();
// The anonymous id is hashed in storage paths too.
const userUsagePath = (userId: string, deps: Deps) => `usage/${today(deps)}/users/${sha(`user:${userId}`)}.json`;

async function reserve(kind: Kind, credits: number, userId: string, deps: Deps): Promise<void> {
  const limit = deps.userLimits[kind];
  const noun = kind === 'looks' ? 'looks' : 'photo clean-ups';
  await bump(userUsagePath(userId, deps), kind, 1, limit, () => new UserLimitError(`You've used today's ${limit} ${noun}. Try again tomorrow.`), deps);
  try {
    await bump(`usage/${today(deps)}.json`, 'credits', credits, deps.dailyCreditLimit, () => new LimitError("Cabine has reached today's limit. Try again tomorrow."), deps);
  } catch (err) {
    // Out of global budget: give the person's allowance back.
    await bump(userUsagePath(userId, deps), kind, -1, null, () => new Error(), deps).catch(() => {});
    throw err;
  }
}

// A JSON counter file updated with optimistic concurrency (ifMatch + retry).
async function bump(
  path: string,
  field: string,
  delta: number,
  limit: number | null,
  overLimit: () => Error,
  deps: Deps,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const existing = await deps.store.read(path);
    const counts = existing ? (JSON.parse(Buffer.from(existing.bytes).toString()) as Record<string, number>) : {};
    const next = (counts[field] ?? 0) + delta;
    if (limit !== null && next > limit) throw overLimit();
    try {
      const body = new TextEncoder().encode(JSON.stringify({ ...counts, [field]: Math.max(0, next) }));
      await deps.store.write(path, body, 'application/json', existing ? existing.etag : null);
      return;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err; // someone else updated it: re-read and retry
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150 * (attempt + 1))); // spread out retries
    }
  }
  throw new Error('Could not update the usage counter');
}

// ---- Upload inbox: phone → extension (D21) -----------------------------------------
// My Closet stays in the extension (IndexedDB). The server only bridges photos
// taken on a phone: a QR token opens an inbox, the phone drops photos in, the
// extension pulls them into its closet and deletes them here.

const SESSION_MINUTES = 30;
const MAX_SESSION_UPLOADS = 20;
const PULL_BATCH = 4; // photos per pull, keeping each response well under the 4.5 MB limit

interface Session {
  userId: string; // the extension's anonymous id; never in the URL
  createdAt: number;
  expiresAt: number;
  uploads: number;
}

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const USER_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only a hash of the token is stored, so a storage listing never reveals a usable token.
const sessionId = (token: string) => sha(`upload-session:${token}`);
const sessionPath = (id: string) => `sessions/${id}.json`;
const inboxPrefix = (id: string) => `inbox/${id}/`;

class GoneError extends Error {}

async function readSession(token: unknown, deps: Deps) {
  if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) throw new RequestError('invalid token');
  const id = sessionId(token);
  const stored = await deps.store.read(sessionPath(id));
  if (!stored) throw new GoneError('This upload link is not valid.');
  return { id, etag: stored.etag, session: JSON.parse(Buffer.from(stored.bytes).toString()) as Session };
}

const now = (deps: Deps) => (deps.now ?? Date.now)();

async function createUploadSession(request: Request, deps: Deps) {
  const userId = request.headers.get('x-cabine-user') ?? '';
  if (!USER_FORMAT.test(userId)) throw new RequestError('missing or invalid x-cabine-user');
  const token = randomBytes(32).toString('base64url');
  const session: Session = { userId, createdAt: now(deps), expiresAt: now(deps) + SESSION_MINUTES * 60_000, uploads: 0 };
  await deps.store.write(sessionPath(sessionId(token)), new TextEncoder().encode(JSON.stringify(session)), 'application/json', null);
  const origin = new URL(request.url).origin;
  return { token, url: `${origin}/add/${token}`, expiresAt: session.expiresAt, maxUploads: MAX_SESSION_UPLOADS };
}

async function sessionStatus(body: Record<string, unknown>, deps: Deps) {
  const { session } = await readSession(body.token, deps);
  if (session.expiresAt < now(deps)) throw new GoneError('This upload session expired. Generate a new QR code from Cabine.');
  return { expiresAt: session.expiresAt, remaining: MAX_SESSION_UPLOADS - session.uploads };
}

async function uploadToInbox(body: Record<string, unknown>, deps: Deps) {
  const [item] = parseItems({ items: [{ category: body.category, image: body.image }] });
  // Count the upload first (with the usual etag retry), so the cap can't be raced past.
  for (let attempt = 0; attempt < 10; attempt++) {
    const { id, etag, session } = await readSession(body.token, deps);
    if (session.expiresAt < now(deps)) throw new GoneError('This upload session expired. Generate a new QR code from Cabine.');
    if (session.uploads >= MAX_SESSION_UPLOADS) throw new RequestError(`This link already has ${MAX_SESSION_UPLOADS} photos. Make a new QR code to add more.`);
    try {
      const next = { ...session, uploads: session.uploads + 1 };
      await deps.store.write(sessionPath(id), new TextEncoder().encode(JSON.stringify(next)), 'application/json', etag);
      const itemId = randomUUID();
      const ext = item.mime === 'image/png' ? 'png' : item.mime === 'image/webp' ? 'webp' : 'jpg';
      await deps.store.write(`${inboxPrefix(id)}${itemId}.${item.category}.${ext}`, item.bytes, item.mime);
      return { id: itemId, remaining: MAX_SESSION_UPLOADS - next.uploads };
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 150 * (attempt + 1)));
    }
  }
  throw new Error('Could not record the upload');
}

const INBOX_NAME = /\/([0-9a-f-]{36})\.(top|bottom|dress|outerwear|shoes)\.(jpg|png|webp)$/;
const MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// The extension may pull leftovers after the session expires (it was open when
// the phone finished); only uploading stops at expiry.
async function pullInbox(body: Record<string, unknown>, deps: Deps) {
  const { id, session } = await readSession(body.token, deps);
  const paths = (await deps.store.list(inboxPrefix(id))).filter((p) => INBOX_NAME.test(p)).sort();
  const items = [];
  for (const path of paths.slice(0, PULL_BATCH)) {
    const [, itemId, category, ext] = INBOX_NAME.exec(path)!;
    const stored = await deps.store.read(path);
    if (stored) items.push({ id: itemId, category, image: dataUri(stored.bytes, MIME[ext]) });
  }
  return { items, more: paths.length > PULL_BATCH, expiresAt: session.expiresAt, uploads: session.uploads };
}

async function ackInbox(body: Record<string, unknown>, deps: Deps) {
  const { id } = await readSession(body.token, deps);
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
  const paths = (await deps.store.list(inboxPrefix(id))).filter((p) => ids.includes(INBOX_NAME.exec(p)?.[1] ?? ''));
  if (paths.length) await deps.store.remove(paths);
  return { deleted: paths.length };
}

// Photos the extension never pulled (it was closed, say) must not stay on the
// server: a daily cron deletes each session and its inbox a day after expiry.
const CLEANUP_AFTER_MS = 24 * 60 * 60_000;

export async function cleanupSessions(deps: Deps): Promise<{ sessions: number; photos: number }> {
  let sessions = 0;
  let photos = 0;
  for (const path of await deps.store.list('sessions/')) {
    const stored = await deps.store.read(path);
    const session = stored ? (JSON.parse(Buffer.from(stored.bytes).toString()) as Session) : null;
    if (session && session.expiresAt + CLEANUP_AFTER_MS > now(deps)) continue;
    const id = path.slice('sessions/'.length, -'.json'.length);
    const inbox = await deps.store.list(inboxPrefix(id));
    await deps.store.remove([...inbox, path]);
    sessions++;
    photos += inbox.length;
  }
  return { sessions, photos };
}

// ---- Analytics: accept a batch of known events, drop anything malformed ------------------------

export const EVENT_NAMES = new Set([
  'extension_opened',
  'store_item_captured',
  'store_item_category_selected',
  'closet_upload_session_created',
  'closet_item_uploaded',
  'fitting_room_item_selected',
  'closet_item_selected',
  'outfit_render_requested',
  'outfit_render_completed',
  'outfit_render_failed',
  'decision_buy',
  'decision_save',
  'decision_pass',
  'item_moved_to_closet',
  'photo_cleanup_requested',
  'photo_cleanup_completed',
  'photo_cleanup_failed',
]);
const MAX_EVENTS = 50;
// Normal use is a few dozen events a session. A runaway client (a bug that
// once sent ~100 a second) must not be able to flood the table.
const MAX_EVENTS_PER_HOUR = 1000;
const PROP_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,29}$/;

function cleanProps(raw: unknown): Record<string, EventValue> | null {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 12) return null;
  const out: Record<string, EventValue> = {};
  for (const [k, v] of entries) {
    if (!PROP_KEY.test(k)) return null;
    if (typeof v === 'string' && v.length <= 120) out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.length <= 10 && v.every((x) => typeof x === 'string' && x.length <= 60)) out[k] = v as string[];
    else return null;
  }
  return out;
}

async function recordEvents(request: Request, body: Record<string, unknown>, deps: Deps) {
  const userId = request.headers.get('x-cabine-user') ?? '';
  if (!USER_FORMAT.test(userId)) throw new RequestError('missing or invalid x-cabine-user');
  if (!Array.isArray(body.events)) throw new RequestError('events must be an array');
  if (body.events.length > MAX_EVENTS) throw new RequestError(`at most ${MAX_EVENTS} events per request`);
  const userHash = sha(`user:${userId}`);
  const t = now(deps);
  const rows: EventRow[] = [];
  for (const e of body.events as Record<string, unknown>[]) {
    const props = cleanProps(e?.props);
    if (typeof e?.name !== 'string' || !EVENT_NAMES.has(e.name) || !props) continue;
    // Trust the extension's clock within a week (offline queues), otherwise use ours.
    const at = typeof e.at === 'number' && Math.abs(e.at - t) < 7 * 86_400_000 ? e.at : t;
    rows.push({ userHash, name: e.name, props, at });
  }
  if (rows.length && (await deps.events.countSince(userHash, t - 3_600_000)) + rows.length > MAX_EVENTS_PER_HOUR) {
    console.log(JSON.stringify({ event: 'events_rate_limited', dropped: body.events.length }));
    return { recorded: 0, dropped: body.events.length, limited: true };
  }
  if (rows.length) await deps.events.record(rows);
  return { recorded: rows.length, dropped: body.events.length - rows.length };
}

// ---- HTTP handler ---------------------------------------------------------------------------

function authorized(request: Request, clientKey: string): boolean {
  const given = Buffer.from(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
  const expected = Buffer.from(clientKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const STREAMING = new Set(['style', 'extract']); // paid work: NDJSON progress + result
const WITH_KEY = new Set(['style', 'extract', 'upload-session', 'inbox', 'inbox-ack', 'events']); // the extension
const TOKEN_ONLY = new Set(['inbox-session', 'inbox-upload']); // the phone page: its token is the credential

export function createHandler(getDeps: () => Deps) {
  return async function POST(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split('/').pop() ?? '';
    if (!WITH_KEY.has(action) && !TOKEN_ONLY.has(action)) return Response.json({ error: 'not found' }, { status: 404 });
    const deps = getDeps();
    if (WITH_KEY.has(action) && !authorized(request, deps.clientKey)) return Response.json({ error: 'unauthorized' }, { status: 401 });

    let body: Record<string, unknown>;
    try {
      body = action === 'upload-session' ? {} : ((await request.json()) as Record<string, unknown>);
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }

    if (!STREAMING.has(action)) {
      try {
        const result =
          action === 'upload-session' ? await createUploadSession(request, deps)
          : action === 'inbox-session' ? await sessionStatus(body, deps)
          : action === 'inbox-upload' ? await uploadToInbox(body, deps)
          : action === 'inbox' ? await pullInbox(body, deps)
          : action === 'events' ? await recordEvents(request, body, deps)
          : await ackInbox(body, deps);
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
      } catch (err) {
        if (err instanceof RequestError) return Response.json({ error: err.message }, { status: 400 });
        if (err instanceof GoneError) return Response.json({ error: err.message }, { status: 410 });
        console.error(`[${action}]`, err);
        return Response.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
      }
    }

    // /api/style takes { items: [...] }; /api/extract takes one garment { category, image, title? }.
    let items: Item[];
    try {
      items = parseItems(action === 'style' ? body : { items: [body] });
    } catch (err) {
      const message = err instanceof RequestError ? err.message : 'invalid JSON body';
      return Response.json({ error: message }, { status: 400 });
    }
    // Paid work counts against this install's daily allowance, so it needs the anonymous id.
    const userId = request.headers.get('x-cabine-user') ?? '';
    if (!USER_FORMAT.test(userId)) return Response.json({ error: 'missing or invalid x-cabine-user' }, { status: 400 });
    const work = (emit: (e: Event) => void) =>
      action === 'style' ? renderLook(items, userId, deps, emit) : extractGarment(items[0], userId, deps, emit);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (e: Event) => controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
        try {
          await work(emit);
        } catch (err) {
          const code = err instanceof UserLimitError ? 'user_limit' : err instanceof LimitError ? 'daily_limit' : 'render_failed';
          if (code === 'render_failed') console.error(`[${action}]`, code, err);
          else console.log(JSON.stringify({ event: code, action }));
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
  async list(prefix) {
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      paths.push(...page.blobs.map((b) => b.pathname));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return paths;
  },
  async remove(paths) {
    await del(paths);
  },
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

// Neon Postgres, provisioned through the Vercel Marketplace (DATABASE_URL). One
// insert per batch via jsonb_to_recordset. Created lazily so routes that don't
// record events work without the database.
let sqlClient: ReturnType<typeof neon> | undefined;
const neonEvents: EventSink = {
  async record(rows) {
    sqlClient ??= neon(env('DATABASE_URL'));
    const payload = rows.map((r) => ({ user_hash: r.userHash, name: r.name, props: r.props, client_at: new Date(r.at).toISOString() }));
    await sqlClient.query(
      `insert into events (user_hash, name, props, client_at)
       select user_hash, name, props, client_at
       from jsonb_to_recordset($1::jsonb) as x(user_hash text, name text, props jsonb, client_at timestamptz)`,
      [JSON.stringify(payload)],
    );
  },
  async countSince(userHash, sinceMs) {
    sqlClient ??= neon(env('DATABASE_URL'));
    const rows = (await sqlClient.query('select count(*)::int as n from events where user_hash = $1 and received_at > $2', [
      userHash,
      new Date(sinceMs).toISOString(),
    ])) as { n: number }[];
    return rows[0].n;
  },
};

const productionDeps = (): Deps => ({
  store: blobStore,
  events: neonEvents,
  // The FASHN key is read only when rendering, so auth and validation work without it.
  provider: fashnProvider(() => env('FASHN_API_KEY'), loadBase),
  extractor: fashnExtractor(() => env('FASHN_API_KEY')),
  clientKey: env('CABINE_CLIENT_KEY'),
  dailyCreditLimit: Number(process.env.DAILY_CREDIT_LIMIT ?? 60),
  userLimits: { looks: Number(process.env.USER_DAILY_LOOKS ?? 10), cleanups: Number(process.env.USER_DAILY_CLEANUPS ?? 10) },
});

export const POST = createHandler(productionDeps);

// Vercel Cron calls GET /api/cleanup with "Authorization: Bearer $CRON_SECRET".
export async function GET(request: Request): Promise<Response> {
  if (new URL(request.url).pathname.split('/').pop() !== 'cleanup') return Response.json({ error: 'not found' }, { status: 404 });
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const result = await cleanupSessions(productionDeps());
  console.log(JSON.stringify({ event: 'cleanup', ...result }));
  return Response.json(result);
}
