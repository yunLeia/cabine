import { chainOrder } from '../shared/outfit';
import { getImage, putImage } from '../shared/images';
import type { Category, Garment, Outfit } from '../shared/types';

// "See the outfit": send the look to the render proxy (server/api/style.ts) and
// stream its progress. The proxy owns the model, order, cache and spending
// limits; this side only prepares images and shows what's happening.

const API = import.meta.env.VITE_CABINE_API ?? 'https://cabine-server.vercel.app/api/style';
const KEY = import.meta.env.VITE_CABINE_CLIENT_KEY ?? '';

// Bump when the server's render settings change, so locally saved results made
// with the old settings aren't shown again.
const RENDER_VERSION = 2;

export type StepStatus = 'waiting' | 'running' | 'done';
export interface ProgressStep {
  category: Category | 'base';
  status: StepStatus;
}

export type RenderEvent =
  | { type: 'plan'; steps: { category: Category | 'base'; cached: boolean }[]; credits: number }
  | { type: 'step'; index: number; category: Category | 'base'; status: 'running' | 'done'; seconds?: number }
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
// The proxy already caches every step, so a repeat costs no credits; this also
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
  if (!KEY) throw new RenderError('not_configured', 'This build of Cabine has no render key. Add VITE_CABINE_CLIENT_KEY to .env.local and rebuild.');

  const garments = chainOrder(outfit, byId);
  const items = await Promise.all(
    garments.map(async (g) => {
      const blob = await getImage(g.imageId);
      if (!blob) throw new RenderError('rejected', `The image for "${g.title ?? g.category}" is missing.`);
      return { category: g.category, title: usefulTitle(g.title), image: await toJpegDataUri(blob) };
    }),
  );

  let res: Response;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
  } catch {
    throw new RenderError('offline', "Can't reach Cabine's server. Check your connection and try again.");
  }
  if (res.status === 401) throw new RenderError('not_configured', "Cabine's server didn't accept this build's key.");
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new RenderError('rejected', `The server couldn't style this look (${res.status}). ${detail}`.trim());
  }

  // The response is newline-delimited JSON, streamed as each step finishes.
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
          : new RenderError('render_failed', "Couldn't style this look. Please try again.");
      }
      if (event.type === 'result') image = event.image;
      onEvent(event);
    }
    if (done) break;
  }
  if (!image) throw new RenderError('render_failed', 'The server stopped before the look was ready. Please try again.');

  const blob = await (await fetch(image)).blob(); // data URI → Blob
  await putImage(await lookKey(outfit, byId), blob);
  return blob;
}
