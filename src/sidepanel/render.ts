import { chainOrder } from '../shared/outfit';
import { getImage, putImage } from '../shared/images';
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
  await putImage(await lookKey(outfit, byId), blob);
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

// Both routes answer with newline-delimited JSON: a plan right away, then the result.
async function postForImage(route: 'style' | 'extract', body: unknown, onEvent: (e: RenderEvent) => void): Promise<Blob> {
  if (!KEY) throw new RenderError('not_configured', 'This build of Cabine has no render key. Add VITE_CABINE_CLIENT_KEY to .env.local and rebuild.');
  let res: Response;
  try {
    res = await fetch(`${API}/${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RenderError('offline', "Can't reach Cabine's server. Check your connection and try again.");
  }
  if (res.status === 401) throw new RenderError('not_configured', "Cabine's server didn't accept this build's key.");
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new RenderError('rejected', `The server couldn't do this (${res.status}). ${detail}`.trim());
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let image: string | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value;
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line) as RenderEvent;
      if (event.type === 'error') {
        throw event.code === 'daily_limit'
          ? new RenderError('daily_limit', "You've reached today's styling limit. Try again tomorrow.")
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

// ---- Does this photo need cleaning up? --------------------------------------------
// Skips the extraction credit for photos that are already product shots: a plain,
// light border and almost no skin tones in the middle. Calibrated on model shots,
// dress-form photos, clean cutouts and extraction outputs (D19). It errs toward
// skipping dress forms hidden by dark garments (free; "Clean up photo" is still
// there) and toward cleaning brown or camel garments that read as skin (1 credit).
export async function needsCleanup(g: Garment): Promise<boolean> {
  const blob = await getImage(g.imageId);
  if (!blob) return false;
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(8, Math.round(bitmap.width * scale));
  const h = Math.max(8, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff'; // transparent PNG cutouts count as white, not black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const px = ctx.getImageData(0, 0, w, h).data;
  const at = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return [px[i], px[i + 1], px[i + 2]] as const;
  };

  const border: (readonly [number, number, number])[] = [];
  for (let x = 0; x < w; x++) border.push(at(x, 0), at(x, h - 1));
  for (let y = 1; y < h - 1; y++) border.push(at(0, y), at(w - 1, y));
  const median = [0, 1, 2].map((c) => border.map((p) => p[c]).sort((a, b) => a - b)[border.length >> 1]);
  const plain = border.filter((p) => Math.max(...p.map((v, c) => Math.abs(v - median[c]))) <= 18).length / border.length;
  const light = Math.min(...median) >= 200;

  let skin = 0;
  let total = 0;
  for (let y = Math.floor(h / 10); y < h - Math.floor(h / 10); y++) {
    for (let x = Math.floor(w / 10); x < w - Math.floor(w / 10); x++) {
      const [r, g, b] = at(x, y);
      const Y = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      if (cr >= 138 && cr <= 173 && cb >= 77 && cb <= 127 && Y > 60) skin++;
      total++;
    }
  }
  return !(plain >= 0.85 && light && skin / total < 0.06);
}
