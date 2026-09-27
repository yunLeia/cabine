import type { Category } from './types';

// Your real closet, packaged with the extension (public/closet/, git-ignored)
// and copied into the library once. Bump SEED_VERSION to re-seed.
export const SEED_VERSION = 1;

export const SEED_CLOSET: { file: string; category: Category; title: string }[] = [
  { file: 'closet/sweater-puff-grey.png', category: 'top', title: 'Grey puff-sleeve sweater' },
  { file: 'closet/top-asym-charcoal.png', category: 'top', title: 'Charcoal asymmetric top' },
  { file: 'closet/tee-cream-cropped.png', category: 'top', title: 'Cream cropped tee' },
  { file: 'closet/top-cowl-grey.png', category: 'top', title: 'Grey cowl-neck top' },
  { file: 'closet/knit-ruffle-blue.png', category: 'top', title: 'Blue ruffle knit' },
  { file: 'closet/skirt-black-mini.png', category: 'bottom', title: 'Black mini skirt' },
  { file: 'closet/jeans-dark-highrise.png', category: 'bottom', title: 'Dark high-rise jeans' },
  { file: 'closet/jeans-skinny-ripped.png', category: 'bottom', title: 'Ripped skinny jeans' },
  { file: 'closet/jacket-boucle-black.png', category: 'outerwear', title: 'Black bouclé jacket' },
];
