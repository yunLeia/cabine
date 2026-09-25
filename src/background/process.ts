import type { NormalizeStats } from '../shared/capture';
import { alphaBounds, dropSpecks, removeBackground } from './normalize';

const MAX_SIDE = 1000; // px; plenty for a ~200px-wide mannequin, keeps storage small

// Download a retailer image and turn it into a trimmed, transparent garment.
// Runs in the service worker: it can fetch any origin thanks to host_permissions,
// and has OffscreenCanvas/createImageBitmap for pixel work (no DOM needed).
export async function normalizeImage(srcUrl: string): Promise<{ blob: Blob; stats: NormalizeStats }> {
  const res = await fetch(srcUrl);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const bitmap = await createImageBitmap(await res.blob()); // decodes JPEG/PNG/WebP/AVIF

  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const img = ctx.getImageData(0, 0, w, h);
  const removed = removeBackground(img.data, w, h);
  if (removed) dropSpecks(img.data, w, h);
  const box = alphaBounds(img.data, w, h);
  if (!box) throw new Error('Nothing left after background removal');

  const out = new OffscreenCanvas(box.w, box.h);
  out.getContext('2d')!.putImageData(img, -box.x, -box.y); // offset = crop
  const blob = await out.convertToBlob({ type: 'image/webp', quality: 0.9 });
  return { blob, stats: { bgRemoved: removed / (w * h), width: box.w, height: box.h } };
}
