import type { Draft, Garment, Outfit } from './types';

// Lightweight state in chrome.storage.local (D2): garment records, the look
// being built, and the pending draft. Image bytes live in IndexedDB (images.ts).
// Both the service worker and the panel write here; the panel re-renders from
// storage.onChanged, so it never matters which side made the change.
export const KEYS = { garments: 'garments', outfit: 'outfit', draft: 'draft', seedVersion: 'seedVersion' } as const;

export interface StoredState {
  garments: Garment[];
  outfit: Outfit;
  draft: Draft | null;
}

export async function loadState(): Promise<StoredState> {
  const s = await chrome.storage.local.get([KEYS.garments, KEYS.outfit, KEYS.draft]);
  return {
    garments: (s[KEYS.garments] as Garment[] | undefined) ?? [],
    outfit: (s[KEYS.outfit] as Outfit | undefined) ?? {},
    draft: (s[KEYS.draft] as Draft | undefined) ?? null,
  };
}

export async function addGarments(add: Garment[]): Promise<void> {
  const { garments } = await loadState();
  await chrome.storage.local.set({ [KEYS.garments]: [...garments, ...add] });
}

export const setOutfit = (outfit: Outfit) => chrome.storage.local.set({ [KEYS.outfit]: outfit });

export const setDraft = (draft: Draft | null) =>
  draft ? chrome.storage.local.set({ [KEYS.draft]: draft }) : chrome.storage.local.remove(KEYS.draft);

export async function getDraft(): Promise<Draft | null> {
  return (await loadState()).draft;
}
