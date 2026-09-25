import type { Garment } from './types';

// Real closet items: dress-form product photos, pre-cut to transparent PNGs by
// scripts/seed-cleanup (Vision subject lift + dress-form removal).
export const SEED_CLOSET: Garment[] = [
  { id: 'sweater-puff-grey', source: 'closet', name: 'Grey puff-sleeve sweater', category: 'top', imageSrc: '/closet/sweater-puff-grey.png' },
  { id: 'top-asym-charcoal', source: 'closet', name: 'Charcoal asymmetric top', category: 'top', imageSrc: '/closet/top-asym-charcoal.png' },
  { id: 'tee-cream-cropped', source: 'closet', name: 'Cream cropped tee', category: 'top', imageSrc: '/closet/tee-cream-cropped.png', adjust: { scale: 0.86 } },
  { id: 'top-cowl-grey', source: 'closet', name: 'Grey cowl-neck top', category: 'top', imageSrc: '/closet/top-cowl-grey.png' },
  { id: 'knit-ruffle-blue', source: 'closet', name: 'Blue ruffle knit', category: 'top', imageSrc: '/closet/knit-ruffle-blue.png' },
  { id: 'skirt-black-mini', source: 'closet', name: 'Black mini skirt', category: 'bottom', imageSrc: '/closet/skirt-black-mini.png' },
  { id: 'jeans-dark-highrise', source: 'closet', name: 'Dark high-rise jeans', category: 'bottom', imageSrc: '/closet/jeans-dark-highrise.png' },
  { id: 'jeans-skinny-ripped', source: 'closet', name: 'Ripped skinny jeans', category: 'bottom', imageSrc: '/closet/jeans-skinny-ripped.png' },
  { id: 'jacket-boucle-black', source: 'closet', name: 'Black bouclé jacket', category: 'outerwear', imageSrc: '/closet/jacket-boucle-black.png' },
];

// Stand-ins for right-click capture (M1.2), so the candidate flow can be tested now.
export const SAMPLE_CANDIDATES: Garment[] = [
  { id: 'sample-cardigan', source: 'captured', name: 'Green cardigan', category: 'outerwear', imageSrc: '/samples/cardigan-green.svg' },
  { id: 'sample-cargo', source: 'captured', name: 'Olive cargo pants', category: 'bottom', imageSrc: '/samples/cargo-olive.svg' },
  { id: 'sample-knit', source: 'captured', name: 'Rust knit top', category: 'top', imageSrc: '/samples/knit-rust.svg' },
];
