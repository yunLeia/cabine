import type { Category } from './types';

// Thumbnail crop for store photos of a whole person (docs/decisions.md D17).
// The saved image and what's sent to the renderer are always the full original;
// this only decides which horizontal band of the photo a thumbnail shows, so a
// top saved from a full-body shot doesn't look like a whole outfit in the closet.

export interface PreviewCrop {
  top: number; // fraction of the image height hidden above
  bottom: number; // fraction hidden below
}

// Full-body e-commerce shots are tall (about 2:3). Product-only shots and
// waist-up model shots are closer to square, and cropping them would cut the
// garment, so they're left alone.
const FULL_BODY_MIN_RATIO = 1.4; // height / width

// Where each kind of garment usually sits in a full-body shot, as [top, bottom] fractions shown.
const BANDS: Partial<Record<Category, [number, number]>> = {
  top: [0.1, 0.58],
  outerwear: [0.08, 0.78],
  bottom: [0.4, 1],
  shoes: [0.78, 1],
  // dress: the whole figure is the garment, show it all
};

export function previewCrop(category: Category, width: number, height: number): PreviewCrop | undefined {
  const band = BANDS[category];
  if (!band || height / width < FULL_BODY_MIN_RATIO) return undefined;
  return { top: band[0], bottom: Math.round((1 - band[1]) * 1000) / 1000 };
}

// CSS for an <img>: object-view-box shows only the band; object-fit then fits it.
export const cropStyle = (c?: PreviewCrop) =>
  c ? `object-view-box: inset(${(c.top * 100).toFixed(1)}% 0% ${(c.bottom * 100).toFixed(1)}% 0%)` : undefined;
