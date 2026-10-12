import { pruneOutfit } from './outfit.ts';
import type { Category, Garment, Outfit, SavedLook } from './types';

// "Try a Different Look" (D36): keep some pieces, explore another way to wear
// them with clothes you own. The choices here are rules; the AI stylist on the
// server only picks among the pieces this sends, and the server checks its answer.

export const VIBES = [
  { key: 'casual', label: 'More casual' },
  { key: 'polished', label: 'More polished' },
  { key: 'minimal', label: 'More minimal' },
  { key: 'feminine', label: 'More feminine' },
  { key: 'edgy', label: 'More edgy' },
  { key: 'like-me', label: 'More like me' },
] as const;

export interface LookPlan {
  understood: string; // what the stylist understood, in a sentence
  direction: string; // "More casual, more everyday"
  outfit: Outfit; // the whole new look
  kept: string[];
  changes: { category: Category; from?: string; to?: string; why?: string }[]; // `to` missing: taken off
}

const MAIN_FIRST: Category[] = ['outerwear', 'dress', 'top', 'bottom', 'shoes'];
const MAX_CANDIDATES = 24;
const MAX_PER_KIND = 8;

// What to keep unless the shopper says otherwise: the store pieces (the point of
// the exercise). A look made only of their own clothes keeps its main piece.
export function defaultKeep(worn: Garment[]): string[] {
  const store = worn.filter((g) => g.location === 'fittingRoom');
  if (store.length) return store.map((g) => g.id);
  const main = [...worn].sort((a, b) => MAIN_FIRST.indexOf(a.category) - MAIN_FIRST.indexOf(b.category))[0];
  return main ? [main.id] : [];
}

// A dress is never worn with a top or bottom.
const clashes = (a: Category, b: Category) => (a === 'dress' && (b === 'top' || b === 'bottom')) || (b === 'dress' && (a === 'top' || a === 'bottom'));

// Closet pieces that could join the kept ones: not already in the look, of a kind
// the kept pieces leave free, and not clashing with them. Pieces of the kinds
// being moved away from come first, then favorites, then what was used lately.
export function pickCandidates(garments: Garment[], worn: Garment[], keep: string[], favorites: string[]): Garment[] {
  const kept = worn.filter((g) => keep.includes(g.id));
  const inLook = new Set(worn.map((g) => g.id));
  const keptKinds = new Set(kept.map((g) => g.category));
  const replacing = new Set(worn.filter((g) => !keep.includes(g.id)).map((g) => g.category));
  const rank = (g: Garment) => [replacing.has(g.category) ? 0 : 1, favorites.includes(g.id) ? 0 : 1, -(g.lastUsedAt ?? 0), -g.createdAt];
  const byRank = (a: Garment, b: Garment) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  };
  const usable = garments
    .filter((g) => g.location === 'closet' && g.decision !== 'pass' && !inLook.has(g.id))
    .filter((g) => !keptKinds.has(g.category) && !kept.some((k) => clashes(k.category, g.category)))
    .sort(byRank);
  const perKind = new Map<Category, number>();
  return usable
    .filter((g) => {
      const n = perKind.get(g.category) ?? 0;
      perKind.set(g.category, n + 1);
      return n < MAX_PER_KIND;
    })
    .slice(0, MAX_CANDIDATES);
}

// Closet pieces the shopper keeps choosing for looks they saved: their taste, for "More like me".
export function favoriteIds(savedLooks: SavedLook[], byId: Map<string, Garment>): string[] {
  const counts = new Map<string, number>();
  for (const look of savedLooks.filter((l) => l.saved !== false)) {
    for (const id of Object.values(look.outfit)) {
      if (id && byId.get(id)?.location === 'closet') counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
}

// Why there's nothing to try, or null when there is.
export function nothingToTry(worn: Garment[], keep: string[], candidates: Garment[]): string | null {
  if (!keep.length) return 'Keep at least one piece.';
  if (worn.every((g) => keep.includes(g.id)) && !candidates.length) return 'Choose a piece to change.';
  if (!candidates.length) return 'There are no other pieces in your closet to try with these. Add a few more.';
  return null;
}

// The server's plan must still fit what's here now (a piece may have been deleted
// or changed kind while it was thinking); otherwise it can't be shown.
export function usablePlan(plan: LookPlan, byId: Map<string, Garment>): boolean {
  const slots = Object.entries(plan.outfit) as [Category, string | undefined][];
  if (!slots.length) return false;
  // Every piece must still be here and still the kind it was chosen as.
  if (slots.some(([category, id]) => !id || byId.get(id)?.category !== category)) return false;
  const ids = slots.map(([, id]) => id!);
  return Object.keys(pruneOutfit(plan.outfit, byId)).length === ids.length && plan.kept.every((id) => ids.includes(id));
}
