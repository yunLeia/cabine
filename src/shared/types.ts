export type Category = 'top' | 'bottom' | 'dress' | 'outerwear' | 'shoes';

export const CATEGORIES: readonly Category[] = ['top', 'bottom', 'dress', 'outerwear', 'shoes'];

export const CATEGORY_LABEL: Record<Category, string> = {
  top: 'Top',
  bottom: 'Bottom',
  dress: 'Dress',
  outerwear: 'Outerwear',
  shoes: 'Shoes',
};

// A garment in the library. Captured and uploaded garments are the same shape:
// the original image plus a category the user picked (docs/decisions.md D13).
export interface Garment {
  id: string;
  sourceType: 'shopping' | 'closet';
  category: Category;
  title?: string;
  sourcePageUrl?: string; // the product page, for shopping captures
  sourceImageUrl?: string; // the retailer's image URL at capture time (reference only; it may expire)
  imageId: string; // IndexedDB key of the original image
  imageVersion: number; // bumped if the image is replaced; part of the render cache key
  previewCrop?: import('./preview').PreviewCrop; // thumbnail band for full-body store photos (D17)
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
