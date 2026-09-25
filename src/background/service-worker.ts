// Background service worker: the extension's event hub. Chrome starts it when an
// event it listens for fires and stops it when idle, so it must not hold state
// in memory. In M1.2 it will also handle the "Try in Cabine" context menu.

console.log('[cabine] service worker started');

// Make the toolbar icon open the side panel. There is no manifest key for this;
// it has to be set through the API. Chrome persists it, but setting it on every
// startup is cheap and keeps it true after updates.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .then(() => console.log('[cabine] panel opens on toolbar click'))
  .catch((err) => console.error('[cabine] setPanelBehavior failed', err));

// Fallback: this only fires if the behavior above is NOT in effect (Chrome
// skips onClicked when openPanelOnActionClick is true). The click counts as a
// user gesture, which sidePanel.open() requires, as long as we call it right
// away, before any await.
chrome.action.onClicked.addListener((tab) => {
  console.log('[cabine] action clicked, opening panel via fallback');
  if (tab.windowId !== undefined) {
    chrome.sidePanel
      .open({ windowId: tab.windowId })
      .catch((err) => console.error('[cabine] sidePanel.open failed', err));
  }
});
