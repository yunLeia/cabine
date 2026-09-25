// Pure pixel functions on RGBA data: no DOM or chrome APIs, so they run in the
// service worker and in Node for testing.

const TOLERANCE = 24; // max per-channel distance from the background colour
const MIN_LIGHTNESS = 200; // only light, studio-style backgrounds are removed

type RGB = [number, number, number];

// Estimate the background from the image border. Returns null unless the border
// is mostly one light colour, which is our "clean product image" assumption.
function borderColor(px: Uint8ClampedArray, w: number, h: number): RGB | null {
  const idx: number[] = [];
  for (let x = 0; x < w; x++) idx.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) idx.push(y * w, y * w + w - 1);

  const median = (c: number) => {
    const v = idx.map((p) => px[p * 4 + c]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const bg: RGB = [median(0), median(1), median(2)];
  if (Math.min(...bg) < MIN_LIGHTNESS) return null;

  const matching = idx.filter((p) => distance(px, p, bg) <= TOLERANCE).length;
  return matching / idx.length >= 0.6 ? bg : null;
}

function distance(px: Uint8ClampedArray, p: number, c: RGB): number {
  const i = p * 4;
  return Math.max(Math.abs(px[i] - c[0]), Math.abs(px[i + 1] - c[1]), Math.abs(px[i + 2] - c[2]));
}

// Flood fill from the border through background-coloured pixels and make them
// transparent. Filling from the edges (instead of keying out every white pixel)
// keeps white garments intact, since their inside isn't connected to the border.
// Returns the number of pixels removed.
export function removeBackground(px: Uint8ClampedArray, w: number, h: number): number {
  const bg = borderColor(px, w, h);
  if (!bg) return 0;

  const removed = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const visit = (p: number) => {
    if (!removed[p] && distance(px, p, bg) <= TOLERANCE) {
      removed[p] = 1;
      stack[top++] = p;
    }
  };
  for (let x = 0; x < w; x++) (visit(x), visit((h - 1) * w + x));
  for (let y = 0; y < h; y++) (visit(y * w), visit(y * w + w - 1));

  while (top) {
    const p = stack[--top];
    const x = p % w;
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p < w * (h - 1)) visit(p + w);
  }

  let count = 0;
  for (let p = 0; p < w * h; p++) {
    if (removed[p]) {
      px[p * 4 + 3] = 0;
      count++;
    }
  }

  // Soften the cut: garment pixels touching the removed area get partial alpha
  // depending on how close they are to the background colour (anti-aliasing).
  for (let p = 0; p < w * h; p++) {
    if (removed[p]) continue;
    const x = p % w;
    const edge =
      (x > 0 && removed[p - 1]) || (x < w - 1 && removed[p + 1]) || (p >= w && removed[p - w]) || (p < w * (h - 1) && removed[p + w]);
    if (edge) px[p * 4 + 3] = Math.min(255, Math.round((distance(px, p, bg) / (TOLERANCE * 3)) * 255));
  }
  return count;
}

// Drop small disconnected blobs (leftover text, badges, dust) that are under
// `minFraction` of the largest piece.
export function dropSpecks(px: Uint8ClampedArray, w: number, h: number, minFraction = 0.02): void {
  const label = new Int32Array(w * h);
  const sizes = [0];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (label[start] || px[start * 4 + 3] === 0) continue;
    const id = sizes.length;
    let size = 0;
    let top = 0;
    label[start] = id;
    stack[top++] = start;
    while (top) {
      const p = stack[--top];
      size++;
      const x = p % w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < w * h && !label[q] && px[q * 4 + 3] !== 0) {
          label[q] = id;
          stack[top++] = q;
        }
      }
    }
    sizes.push(size);
  }
  const min = Math.max(...sizes) * minFraction;
  for (let p = 0; p < w * h; p++) if (label[p] && sizes[label[p]] < min) px[p * 4 + 3] = 0;
}

// Bounding box of the visible pixels, or null if nothing is left.
export function alphaBounds(px: Uint8ClampedArray, w: number, h: number) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
