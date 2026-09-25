export type Category = 'bottom' | 'top' | 'outerwear';

// Bottom-to-top drawing order on the mannequin.
export const CATEGORIES: readonly Category[] = ['bottom', 'top', 'outerwear'];

// Optional per-garment nudges on top of the category slot, for images whose crop
// or proportions don't fit the slot well. Fractions of the slot box.
export interface PlacementAdjust {
  scale?: number; // 1 = fill the slot
  dx?: number; // shift right, as a fraction of slot width
  dy?: number; // shift down, as a fraction of slot height
}

// A captured shopping item and a closet item are the same shape once processed,
// so Compose never needs to care where a garment came from.
export interface Garment {
  id: string;
  source: 'closet' | 'captured';
  name: string;
  category: Category;
  // M1.1: a URL packaged with the extension. From M1.5 this becomes a reference
  // to a processed image blob in IndexedDB.
  imageSrc: string;
  adjust?: PlacementAdjust;
}
