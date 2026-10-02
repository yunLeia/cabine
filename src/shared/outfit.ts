import type { Category, Garment, Outfit } from './types';

// Pure outfit rules, shared by the panel now and the render chain later.

// A dress covers both top and bottom, so it can't be worn with either.
const EXCLUDES: Partial<Record<Category, Category[]>> = {
  dress: ['top', 'bottom'],
  top: ['dress'],
  bottom: ['dress'],
};

// Put a garment in its slot, or take it off if it's already there.
export function toggleInOutfit(outfit: Outfit, g: Garment): Outfit {
  if (outfit[g.category] === g.id) {
    const { [g.category]: _removed, ...rest } = outfit;
    return rest;
  }
  const next: Outfit = { ...outfit, [g.category]: g.id };
  for (const c of EXCLUDES[g.category] ?? []) delete next[c];
  return next;
}

export function removeFromOutfit(outfit: Outfit, category: Category): Outfit {
  const { [category]: _removed, ...rest } = outfit;
  return rest;
}

// Order FASHN applies garments in: inner layers first, so each try-on dresses
// the result of the previous one. Owned-first / candidate-last ordering is a
// later optimization (D13).
export const CHAIN_ORDER: readonly Category[] = ['bottom', 'dress', 'top', 'outerwear', 'shoes'];

export function chainOrder(outfit: Outfit, byId: Map<string, Garment>): Garment[] {
  return CHAIN_ORDER.flatMap((c) => {
    const g = outfit[c] ? byId.get(outfit[c]!) : undefined;
    return g ? [g] : [];
  });
}

// Drop ids of garments that no longer exist (e.g. deleted from the library).
export function pruneOutfit(outfit: Outfit, byId: Map<string, Garment>): Outfit {
  return Object.fromEntries(Object.entries(outfit).filter(([, id]) => id && byId.has(id))) as Outfit;
}
