export type Category = 'top' | 'bottom' | 'dress' | 'outerwear' | 'shoes';

export const CATEGORIES: readonly Category[] = ['top', 'bottom', 'dress', 'outerwear', 'shoes'];

export const CATEGORY_LABEL: Record<Category, string> = {
  top: 'Top',
  bottom: 'Bottom',
  dress: 'Dress',
  outerwear: 'Outerwear',
  shoes: 'Shoes',
};

// Where a garment lives (D18): the Fitting Room holds store pieces you're
// considering, as their original photos; My Closet holds what you own.
export type Location = 'fittingRoom' | 'closet';

// A garment. Captured and uploaded garments are the same shape: the original
// image plus a category the user picked (docs/decisions.md D13).
export interface Garment {
  id: string;
  location: Location;
  sourceType: 'shopping' | 'closet'; // where it came from (a store capture, or your upload)
  category: Category;
  title?: string;
  sourcePageUrl?: string; // the product page, for shopping captures
  sourceImageUrl?: string; // the retailer's image URL at capture time (reference only; it may expire)
  imageId: string; // IndexedDB key of the original image
  imageVersion: number; // bumped if the image is replaced; part of the render cache key
  cleanImageId?: string; // extracted product shot, for My Closet thumbnails only (renders use the original)
  cleanStatus?: 'pending' | 'failed'; // a clean-up in progress, or the last one failed
  // The shopper's call on a Fitting Room piece after seeing it styled. Pass keeps
  // the record (hidden from the drawers) so decisions can be counted later.
  decision?: 'buy' | 'save' | 'pass';
  decidedAt?: number;
  createdAt: number;
}

// A garment waiting for its category: just captured or uploaded, not yet in the library.
export interface Draft {
  id: string;
  sourceType: 'shopping' | 'closet';
  title?: string;
  sourcePageUrl?: string;
  sourceImageUrl?: string;
  imageId?: string; // set once the original is saved
  status: 'downloading' | 'ready' | 'failed';
  error?: string;
  createdAt: number;
}

// Which garment fills each slot of the look being built.
export type Outfit = Partial<Record<Category, string>>;
