import { loadState } from '../shared/store';
import { isSaved } from '../shared/types';
import { withStorageLock } from '../shared/storage-lock.ts';
import { chainOrder, pruneOutfit } from '../shared/outfit';
import { getUserId } from '../shared/identity';
import { sessionToken } from './auth';
import { getImage, pruneRenderCache, putImage } from '../shared/images';
import type { Garment, Outfit } from '../shared/types';

// "See the outfit" and photo clean-up: calls to the proxy (server/api/[action].ts). The
// proxy owns the render provider, the whole-look cache and the spending limits;
// this side only prepares images and shows what's happening.

const API = (import.meta.env.VITE_CABINE_API ?? 'https://cabine-server.vercel.app/api').replace(/\/$/, '');
const KEY = import.meta.env.VITE_CABINE_CLIENT_KEY ?? '';

// Bump when the server's render settings change, so locally saved results made
// with the old settings aren't shown again.
const RENDER_VERSION = 3;

// One render call per look (D16): the server says whether it's cached, then sends the image.
export type RenderEvent =
  | { type: 'plan'; cached: boolean; credits: number }
  | { type: 'result'; image: string; credits: number }
  | { type: 'error'; code: string; message: string };

export class RenderError extends Error {
  constructor(
    readonly code: 'daily_limit' | 'render_failed' | 'offline' | 'not_configured' | 'rejected',
    message: string,
  ) {
    super(message);
  }
}

// ---- Images ------------------------------------------------------------------

const MAX_SIDE = 1280; // plenty for FASHN's 1K output, keeps each request well under a few MB

// JPEG on white: transparent closet PNGs would otherwise turn black, and FASHN
// only accepts JPEG/PNG/WebP (captured images can be AVIF).
async function toJpegDataUri(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  return blobToDataUri(jpeg);
}

// A local photo as the account's copy (D32 sync): as it is when the server takes
// it, otherwise the same JPEG the renders get.
export async function uploadableImage(blob: Blob): Promise<string> {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(blob.type) && blob.size < 2_500_000 ? blobToDataUri(blob) : toJpegDataUri(blob);
}

const blobToDataUri = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

// Camera and screenshot file names say nothing about the garment; leave them out of the prompt.
const usefulTitle = (title?: string) => (title && !/^(img|dsc|pxl|photo|screenshot|image)[\s_-]?\d/i.test(title) ? title : undefined);

// ---- Local result cache ---------------------------------------------------------
// The proxy already caches whole looks, so a repeat costs no credits; this also
// skips the upload and the wait when reopening a look rendered before.

export async function lookKey(outfit: Outfit, byId: Map<string, Garment>): Promise<string> {
  const parts = chainOrder(outfit, byId).map((g) => [g.category, g.id, g.imageVersion]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([RENDER_VERSION, parts])));
  return `render-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)}`;
}

export const getSavedRender = (key: string) => getImage(key);

// ---- The request ----------------------------------------------------------------

export async function styleOutfit(
  outfit: Outfit,
  byId: Map<string, Garment>,
  onEvent: (e: RenderEvent) => void,
): Promise<Blob> {
  const garments = chainOrder(outfit, byId);
  const items = await Promise.all(garments.map(prepare));
  const blob = await postForImage('style', { items }, onEvent);
  const key = await lookKey(outfit, byId);
  await withStorageLock('render-cache', async () => {
    await putImage(key, blob);
    const stored = await loadState();
    const currentById = new Map(stored.garments.map((g) => [g.id, g]));
    const currentKey = await lookKey(pruneOutfit(stored.outfit, currentById), currentById);
    await pruneRenderCache(new Set([key, currentKey, ...stored.savedLooks.filter(isSaved).map((l) => l.key)]))
      .catch((err) => console.warn('[cabine] cache cleanup failed', err));
  });
  return blob;
}

// A clean product photo of one garment, for My Closet (D19). Renders keep using the original.
export function cleanUpPhoto(g: Garment): Promise<Blob> {
  return prepare(g).then((item) => postForImage('extract', item, () => {}));
}

async function prepare(g: Garment) {
  const blob = await getImage(g.imageId);
  if (!blob) throw new RenderError('rejected', `The image for "${g.title ?? g.category}" is missing.`);
  return { category: g.category, title: usefulTitle(g.title), image: await toJpegDataUri(blob) };
}

// The client key, the install id, and, when signed in, the Clerk session token
// (the server uses the account then, and falls back to the install if it doesn't verify).
async function requestHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Cabine-User': await getUserId() };
  const token = await sessionToken();
  if (token) headers['X-Cabine-Session'] = token;
  return headers;
}

// A look or a clean-up takes about 15 s; past this the server has stalled, and the
// panel should say so instead of showing the hanger forever.
const WORK_TIMEOUT_MS = 200_000;
const TOOK_TOO_LONG = 'That took too long. Please try again.';
const timedOut = (err: unknown) => err instanceof DOMException && err.name === 'TimeoutError';

async function send(route: string, body: unknown, timeoutMs?: number): Promise<Response> {
  if (!KEY) throw new RenderError('not_configured', 'This build of Cabine has no server key. Add VITE_CABINE_CLIENT_KEY to .env.local and rebuild.');
  let res: Response;
  try {
    res = await fetch(`${API}/${route}`, {
      method: 'POST',
      headers: await requestHeaders(),
      body: JSON.stringify(body),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
  } catch (err) {
    if (timedOut(err)) throw new RenderError('render_failed', TOOK_TOO_LONG);
    throw new RenderError('offline', "Can't reach Cabine's server. Check your connection and try again.");
  }
  if (res.status === 401) throw new RenderError('not_configured', "Cabine's server didn't accept this build's key.");
  return res;
}

// Plain JSON routes (upload sessions and the phone inbox).
export async function postJson<T>(route: string, body: unknown): Promise<T> {
  const res = await send(route, body);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new RenderError(res.status === 410 ? 'rejected' : 'render_failed', data.error ?? `The server couldn't do this (${res.status}).`);
  return data;
}

// Both routes answer with newline-delimited JSON: a plan right away, then the result.
async function postForImage(route: 'style' | 'extract', body: unknown, onEvent: (e: RenderEvent) => void): Promise<Blob> {
  const res = await send(route, body, WORK_TIMEOUT_MS);
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new RenderError('rejected', `The server couldn't do this (${res.status}). ${detail}`.trim());
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let image: string | null = null;
  for (;;) {
    const { value, done } = await reader.read().catch((err: unknown) => {
      throw timedOut(err) ? new RenderError('render_failed', TOOK_TOO_LONG) : err;
    });
    if (value) buffer += value;
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line) as RenderEvent;
      if (event.type === 'error') {
        // Limits come with a message written for people ("You've used today's 10 looks…").
        throw event.code === 'user_limit' || event.code === 'daily_limit' || event.code === 'paused'
          ? new RenderError('daily_limit', event.message)
          : new RenderError('render_failed', route === 'style' ? "Couldn't style this look. Please try again." : "Couldn't clean up this photo. Please try again.");
      }
      if (event.type === 'result') image = event.image;
      onEvent(event);
    }
    if (done) break;
  }
  if (!image) throw new RenderError('render_failed', 'The server stopped before it was done. Please try again.');
  return (await fetch(image)).blob(); // data URI → Blob
}
