import type { Draft, Garment, Outfit, SavedLook } from './types';

// Lightweight state in chrome.storage.local (D2): garment records, the look
// being built, and the pending draft. Image bytes live in IndexedDB (images.ts).
// Both the service worker and the panel write here; the panel re-renders from
// storage.onChanged, so it never matters which side made the change.
export const KEYS = { garments: 'garments', outfit: 'outfit', draft: 'draft', savedLooks: 'savedLooks' } as const;

export interface StoredState {
  garments: Garment[];
  outfit: Outfit;
  draft: Draft | null;
  savedLooks: SavedLook[];
}

export async function loadState(): Promise<StoredState> {
  const s = await chrome.storage.local.get([KEYS.garments, KEYS.outfit, KEYS.draft, KEYS.savedLooks]);
  return {
    // Garments saved before locations existed: store captures were in the Fitting Room.
    garments: ((s[KEYS.garments] as Garment[] | undefined) ?? []).map((g) =>
      g.location ? g : { ...g, location: g.sourceType === 'shopping' ? 'fittingRoom' : 'closet' },
    ),
    outfit: (s[KEYS.outfit] as Outfit | undefined) ?? {},
    draft: (s[KEYS.draft] as Draft | undefined) ?? null,
    savedLooks: (s[KEYS.savedLooks] as SavedLook[] | undefined) ?? [],
  };
}

export async function addGarments(add: Garment[]): Promise<void> {
  const { garments } = await loadState();
  await chrome.storage.local.set({ [KEYS.garments]: [...garments, ...add] });
}

export async function updateGarment(id: string, patch: Partial<Garment>): Promise<void> {
  const { garments } = await loadState();
  await chrome.storage.local.set({ [KEYS.garments]: garments.map((g) => (g.id === id ? { ...g, ...patch } : g)) });
}

export async function removeGarment(id: string): Promise<void> {
  const { garments } = await loadState();
  await chrome.storage.local.set({ [KEYS.garments]: garments.filter((g) => g.id !== id) });
}

export async function updateGarments(ids: string[], patch: Partial<Garment>): Promise<void> {
  const { garments } = await loadState();
  await chrome.storage.local.set({ [KEYS.garments]: garments.map((g) => (ids.includes(g.id) ? { ...g, ...patch } : g)) });
}

export const setSavedLooks = (looks: SavedLook[]) => chrome.storage.local.set({ [KEYS.savedLooks]: looks });

export const setOutfit = (outfit: Outfit) => chrome.storage.local.set({ [KEYS.outfit]: outfit });

export const setDraft = (draft: Draft | null) =>
  draft ? chrome.storage.local.set({ [KEYS.draft]: draft }) : chrome.storage.local.remove(KEYS.draft);

export async function getDraft(): Promise<Draft | null> {
  return (await loadState()).draft;
}
