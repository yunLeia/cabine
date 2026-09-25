import type { Category } from '../shared/types';

// Fixed geometry per category, as percentages of the mannequin stage. These are
// tuned to public/mannequin.svg (viewBox 200x500); change both together.
//
// A slot is a box, not a point + width: product photos have very different
// aspect ratios (shorts vs trousers), so the image is scaled to fit *inside*
// the box and pinned to its top edge (shoulders for tops, waist for bottoms).
export interface Slot {
  left: number;
  top: number;
  width: number;
  height: number;
  z: number;
}

export const SLOTS: Record<Category, Slot> = {
  // Tall enough that tops are limited by width, so a tee and a long-sleeve
  // sweater come out equally wide instead of the longer one shrinking.
  bottom: { left: 26, top: 46.5, width: 48, height: 49, z: 1 },
  top: { left: 15, top: 17, width: 70, height: 46, z: 2 },
  outerwear: { left: 11, top: 16, width: 78, height: 52, z: 3 },
};
