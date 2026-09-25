import { CAPTURE_KEY, type Capture } from '../shared/capture';
import { deleteImage, putImage } from '../shared/images';
import { normalizeImage } from './process';

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

  void startCapture(info, tab);
});

async function startCapture(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  const capture: Capture = {
    id: crypto.randomUUID(),
    srcUrl: info.srcUrl!,
    pageUrl: info.pageUrl,
    title: tab?.title || (info.pageUrl ? new URL(info.pageUrl).hostname : 'Captured item'),
    capturedAt: Date.now(),
    status: 'processing',
  };

  // Show it right away (the panel displays srcUrl while we process), and drop
  // the previous capture's image: only one candidate exists at a time.
  const prev = await getCapture();
  await chrome.storage.local.set({ [CAPTURE_KEY]: capture });
  if (prev?.imageId) void deleteImage(prev.imageId);

  try {
    const { blob, stats } = await normalizeImage(capture.srcUrl);
    await putImage(capture.id, blob);
    await updateIfCurrent(capture.id, { status: 'ready', imageId: capture.id, stats });
  } catch (err) {
    console.warn('[cabine] normalize failed', capture.srcUrl, err);
    await updateIfCurrent(capture.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
}

async function getCapture(): Promise<Capture | undefined> {
  return (await chrome.storage.local.get(CAPTURE_KEY))[CAPTURE_KEY] as Capture | undefined;
}

// While we were processing, the user may have picked a category (keep it), or
// captured/removed something else (then this result is stale: discard it).
async function updateIfCurrent(id: string, patch: Partial<Capture>): Promise<void> {
  const current = await getCapture();
  if (current?.id !== id) {
    if (patch.imageId) await deleteImage(patch.imageId);
    return;
  }
  await chrome.storage.local.set({ [CAPTURE_KEY]: { ...current, ...patch } });
}
