import { deleteImage, putImage } from '../shared/images';
import { SEED_CLOSET, SEED_VERSION } from '../shared/seed';
import { KEYS, addGarments, getDraft, setDraft } from '../shared/store';
import type { Draft, Garment } from '../shared/types';

// Background service worker: the extension's event hub. Chrome starts it when an
// event it listens for fires and stops it when idle, so it must not hold state
// in memory.

const MENU_ID = 'try-in-cabine';

// Make the toolbar icon open the side panel. There is no manifest key for this;
// it has to be set through the API. Chrome persists it, but setting it on every
// startup is cheap and keeps it true after updates.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[cabine] setPanelBehavior failed', err));

// Fallback: fires only if the behavior above is NOT in effect (Chrome skips
// onClicked when openPanelOnActionClick is true).
chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});

// Context menu items persist across service worker restarts, so create them once
// per install/update. Creating them at top level would run on every wake-up and
// fail with a duplicate-id error.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Try in Cabine',
    contexts: ['image'], // only shown when right-clicking an <img>
  });
  void seedCloset();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return;

  // sidePanel.open() needs a user gesture, and the gesture only lasts for the
  // synchronous part of this handler. So open first, before any await.
  if (tab?.windowId !== undefined) {
    chrome.sidePanel
      .open({ windowId: tab.windowId })
      .catch((err) => console.error('[cabine] sidePanel.open failed', err));
  }
  void capture(info.srcUrl, info.pageUrl, tab?.title);
});

// Save a copy of the original image (retailer URLs expire or block other
// sites) as a draft; the panel asks for the category. No processing: the
// original is the source of truth (D13).
async function capture(srcUrl: string, pageUrl?: string, pageTitle?: string): Promise<void> {
  const draft: Draft = {
    id: crypto.randomUUID(),
    sourceType: 'shopping',
    title: pageTitle || (pageUrl ? new URL(pageUrl).hostname : undefined),
    sourcePageUrl: pageUrl,
    sourceImageUrl: srcUrl,
    status: 'downloading',
    createdAt: Date.now(),
  };
  const prev = await getDraft();
  await setDraft(draft);
  if (prev?.imageId) void deleteImage(prev.imageId); // an unsaved draft is replaced

  try {
    const res = await fetch(srcUrl); // any origin, thanks to host_permissions
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error(`not an image (${blob.type || 'unknown type'})`);
    await putImage(draft.id, blob);
    await updateDraftIfCurrent(draft.id, { status: 'ready', imageId: draft.id });
  } catch (err) {
    console.warn('[cabine] capture failed', srcUrl, err);
    await updateDraftIfCurrent(draft.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}

// The user may have captured something else or discarded this draft while it
// downloaded; then this result is stale.
async function updateDraftIfCurrent(id: string, patch: Partial<Draft>): Promise<void> {
  const current = await getDraft();
  if (current?.id !== id) {
    if (patch.imageId) await deleteImage(patch.imageId);
    return;
  }
  await setDraft({ ...current, ...patch });
}

// Copy the packaged closet into the library once. Missing files are skipped:
// the seed photos are git-ignored, so a fresh clone starts with an empty closet.
async function seedCloset(): Promise<void> {
  const { [KEYS.seedVersion]: seeded } = await chrome.storage.local.get(KEYS.seedVersion);
  if (seeded === SEED_VERSION) return;

  const added: Garment[] = [];
  for (const item of SEED_CLOSET) {
    const res = await fetch(chrome.runtime.getURL(item.file)).catch(() => null);
    if (!res?.ok) continue;
    const id = crypto.randomUUID();
    await putImage(id, await res.blob());
    added.push({
      id,
      location: 'closet',
      sourceType: 'closet',
      category: item.category,
      title: item.title,
      imageId: id,
      imageVersion: 1,
      createdAt: Date.now(),
    });
  }
  await addGarments(added);
  await chrome.storage.local.set({ [KEYS.seedVersion]: SEED_VERSION });
}
