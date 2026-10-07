import { recoverInterruptedCleanups } from '../shared/cleanup.ts';
import { withStorageLock } from '../shared/storage-lock.ts';
import '@fontsource-variable/inter';
import { domainOf } from '../shared/analytics';
import { deleteImage, pruneRenderCache, putImage } from '../shared/images';
import { inferCategory } from '../shared/infer';
import { chainOrder, pruneOutfit, removeFromOutfit, toggleInOutfit } from '../shared/outfit';
import { KEYS, addGarments, loadState, removeGarment, setDraft, setOutfit, setSavedLooks, updateGarment, updateGarments } from '../shared/store';
import { isSaved, type Category, type Draft, type Garment } from '../shared/types';
import { syncImageUrls } from './image-urls';
import { startFlushing, trackPanel } from './analytics';
import { pullPhoneUploads, startPhoneSession } from './phone';
import { RenderError, cleanUpPhoto, getSavedRender, lookKey, styleOutfit } from './render';
import { cabineView, candidateOf, draftView, headerView, lookPickers, lookView, savedView, type Actions, type RenderState, type ViewState } from './views';

// Stored state (garments, outfit, draft, saved looks) mirrors chrome.storage.local
// and only changes through storage writes + onChanged. The rest is UI state.
const state: ViewState = {
  garments: [],
  byId: new Map(),
  outfit: {},
  draft: null,
  savedLooks: [],
  lookKey: null,
  render: null,
  view: 'look',
  filter: 'all',
  menuFor: null,
  typeFor: null,
  cleared: false,
  notice: null,
  phone: null,
  uploadOpen: false,
  savedEdit: false,
};

const $ = (id: string) => document.getElementById(id)!;

const actions: Actions = {
  async saveDraft(category: Category) {
    const d = state.draft;
    if (!d?.imageId) return;
    await saveFromDraft(d, category, false);
  },

  async discardDraft() {
    const d = state.draft;
    await setDraft(null);
    if (d?.imageId) await deleteImage(d.imageId);
  },

  pick(g: Garment) {
    state.menuFor = null;
    if (state.outfit[g.category] !== g.id) {
      void trackPanel(g.location === 'fittingRoom' ? 'fitting_room_item_selected' : 'closet_item_selected', { itemId: g.id, category: g.category, viaSlot: false });
    }
    const on = state.outfit[g.category] !== g.id;
    void setOutfit(toggleInOutfit(state.outfit, g)); // a new piece of the same kind replaces the old one
    // Away from Your Look, say what the tap did (it changes a look you can't see).
    if (state.view !== 'look') notify(on ? 'Added to your look' : 'Taken off your look');
  },

  takeOff(g: Garment) {
    void setOutfit(removeFromOutfit(state.outfit, g.category));
  },

  setView(v) {
    state.view = v;
    state.savedEdit = false;
    state.menuFor = null;
    state.typeFor = null;
    state.filter = 'all';
    render();
    window.scrollTo({ top: 0 });
  },

  async seeTogether() {
    const garments = chainOrder(state.outfit, state.byId);
    const key = state.lookKey;
    if (!garments.length || !key) return;

    state.cleared = false;
    // Seen this exact look already (e.g. "Try another", then no change): show it again.
    if (state.render?.key === key && state.render.status === 'done') return render();
    setRender({ key, count: garments.length, status: 'running' });
    void updateGarments(garments.map((g) => g.id), { lastUsedAt: Date.now() });
    const fromStore = garments.filter((g) => g.location === 'fittingRoom');
    void trackPanel('outfit_render_requested', {
      pieces: garments.length,
      fromFittingRoom: fromStore.length,
      fromCloset: garments.length - fromStore.length,
      categories: garments.map((g) => g.category),
      candidateIds: fromStore.map((g) => g.id),
    });
    const started = Date.now();
    let cached = false;
    // The render keeps going if the look changes meanwhile; its result is saved
    // either way and shown if the user comes back to this look.
    try {
      const blob = await styleOutfit(state.outfit, state.byId, (e) => {
        if (e.type === 'plan') cached = e.cached;
        if (e.type === 'plan' && state.render?.key === key) {
          state.render.cached = e.cached;
          render();
        }
      });
      void trackPanel('outfit_render_completed', { seconds: (Date.now() - started) / 1000, cached, pieces: garments.length });
      if (state.render?.key === key) setRender({ key, count: garments.length, status: 'done', imageUrl: URL.createObjectURL(blob) });
    } catch (err) {
      if (!(err instanceof RenderError)) console.error('[cabine] render failed', err);
      const message = err instanceof RenderError ? err.message : 'Something went wrong. Please try again.';
      void trackPanel('outfit_render_failed', { code: err instanceof RenderError ? err.code : 'unexpected' });
      if (state.render?.key === key) setRender({ key, count: garments.length, status: 'error', error: message });
    }
  },

  tryAnother() {
    // Back to the empty mannequin; the chosen pieces stay in their boxes.
    state.cleared = true;
    void trackPanel('try_another_look', { pieces: chainOrder(state.outfit, state.byId).length });
    render();
  },

  async toggleSave() {
    const key = state.lookKey;
    if (!key) return;
    const entry = state.savedLooks.find((l) => l.key === key);
    const saved = !!entry && isSaved(entry);
    const rest = state.savedLooks.filter((l) => l.key !== key);
    await setSavedLooks([...rest, { key, outfit: { ...state.outfit }, createdAt: entry?.createdAt ?? Date.now(), saved: !saved }]);
    if (!saved) void trackPanel('look_saved', { pieces: chainOrder(state.outfit, state.byId).length, candidateIds: chainOrder(state.outfit, state.byId).filter((g) => g.location === 'fittingRoom').map((g) => g.id) });
  },

  openSavedLook(l) {
    state.view = 'look';
    void setOutfit(pruneOutfit(l.outfit, state.byId));
    render();
  },

  openOriginal(g: Garment, from) {
    state.menuFor = null;
    render();
    if (!g.sourcePageUrl || !/^https?:\/\//.test(g.sourcePageUrl)) return;
    void trackPanel('original_page_opened', { itemId: g.id, from });
    void chrome.tabs.create({ url: g.sourcePageUrl });
  },

  toggleMenu(id) {
    state.menuFor = id;
    render();
  },

  editType(id) {
    state.menuFor = null;
    state.typeFor = id;
    render();
  },

  async changeType(g: Garment, c: Category) {
    state.typeFor = null;
    if (c === g.category) return render();
    void trackPanel('category_edited', { itemId: g.id, from: g.category, to: c, location: g.location });
    const wasOn = state.outfit[g.category] === g.id;
    if (state.filter === g.category) state.filter = c; // follow the piece to its new tab
    const nextOutfit = toggleInOutfit(removeFromOutfit(state.outfit, g.category), { ...g, category: c });
    await updateGarment(g.id, { category: c });
    if (wasOn) await setOutfit(nextOutfit);
  },

  async addToCloset(g: Garment) {
    state.menuFor = null;
    await updateGarment(g.id, { location: 'closet' });
    notify('Added to My Closet');
    // Yours now: its photo becomes a clean product shot (1 credit), shown with a
    // turning hanger until it's ready. Renders keep using the original.
    void trackPanel('item_moved_to_closet', { itemId: g.id, category: g.category, via: 'menu' });
    void cleanUp(g, 'auto');
  },

  cleanUp(g: Garment) {
    state.menuFor = null;
    void cleanUp(g, 'manual');
  },

  async useOriginal(g: Garment) {
    // A generated product shot might not match the real item; the original is always one tap away.
    state.menuFor = null;
    const old = g.cleanImageId;
    await updateGarment(g.id, { cleanImageId: undefined, cleanStatus: undefined });
    if (old) await deleteImage(old);
  },

  filter(f) {
    state.filter = f;
    // On the main page only the pieces below the look change; redraw just that part.
    const part = document.getElementById('pickers');
    if (state.view === 'look' && part) part.replaceWith(lookPickers(state, actions));
    else render();
  },

  toggleUpload(open) {
    state.uploadOpen = open;
    render();
  },

  toggleSavedEdit(on) {
    state.savedEdit = on;
    render();
  },

  async deleteSavedLook(l) {
    await setSavedLooks(state.savedLooks.filter((x) => x.key !== l.key));
    await withStorageLock('render-cache', () => deleteImage(l.key));
    if (!state.savedLooks.some((x) => x.key !== l.key && isSaved(x))) state.savedEdit = false; // nothing left to edit
  },

  chooseFile() {
    // Open the file picker first, while this click still counts as the user's
    // gesture, then close the menu. (A <label for> here didn't work: closing the
    // menu redraws the panel and removes the label before it can open the picker.)
    ($('upload-input') as HTMLInputElement).click();
    state.uploadOpen = false;
    render();
  },

  async usePhone() {
    state.uploadOpen = false;
    stopPolling();
    state.phone = null;
    render();
    try {
      state.phone = await startPhoneSession();
      void trackPanel('closet_upload_session_created');
      pollTimer = setInterval(() => void pollPhone(), POLL_MS);
    } catch (err) {
      state.phone = { token: '', url: '', expiresAt: 0, added: 0, status: 'error', error: err instanceof RenderError ? err.message : undefined };
    }
    render();
  },

  closePhone() {
    const p = state.phone;
    stopPolling();
    state.phone = null;
    render();
    // One last pull, in case the phone finished just before Done.
    if (p?.token) {
      void pullPhoneUploads(p.token)
        .then(({ added }) => added.forEach((g) => phoneArrived(g)))
        .catch(() => {});
    }
  },

  async removeGarment(g: Garment) {
    state.menuFor = null;
    if (!confirm(`Remove "${g.title ?? 'this piece'}" from Cabine?`)) return render();
    await removeGarment(g.id);
    await setOutfit(pruneOutfit(state.outfit, new Map(state.garments.filter((x) => x.id !== g.id).map((x) => [x.id, x]))));
    await Promise.all([deleteImage(g.imageId), g.cleanImageId ? deleteImage(g.cleanImageId) : null]);
  },
};

// A draft becomes a piece. A store piece starts a fresh look around it; your own
// piece joins the current look if there's a store piece to wear it with.
async function saveFromDraft(d: Draft, category: Category, inferred: boolean): Promise<void> {
  const g: Garment = {
    id: d.id,
    location: d.sourceType === 'shopping' ? 'fittingRoom' : 'closet',
    sourceType: d.sourceType,
    category,
    title: d.title,
    sourcePageUrl: d.sourcePageUrl,
    sourceImageUrl: d.sourceImageUrl,
    imageId: d.imageId!,
    imageVersion: 1,
    createdAt: Date.now(),
  };
  await addGarments([g]);
  if (g.location === 'fittingRoom') {
    void trackPanel('store_item_category_selected', { itemId: g.id, category, inferred });
    await setOutfit(toggleInOutfit(state.outfit, g)); // straight into the look, in its kind
  } else {
    void trackPanel('closet_item_uploaded', { itemId: g.id, category, source: 'device' });
    if (candidateOf(state)) await setOutfit(toggleInOutfit(state.outfit, g));
    notify('Added to My Closet');
    void cleanUp(g, 'auto'); // your own photos get a clean product shot too
  }
  await setDraft(null);
}

function phoneArrived(g: Garment): void {
  void trackPanel('closet_item_uploaded', { itemId: g.id, category: g.category, source: 'phone' });
  void cleanUp(g, 'auto');
}

// Clean-ups wait their turn, two at a time: a phone session can bring in a
// dozen photos at once. Each tile shows the hanger from the moment it's queued.
const CLEANUP_PARALLEL = 2;
let cleanupsRunning = 0;
const cleanupQueue: (() => void)[] = [];
async function cleanUp(g: Garment, trigger: 'auto' | 'manual'): Promise<void> {
  await withStorageLock(`cleanup:${g.id}`, async () => {
    const current = (await loadState()).garments.find((item) => item.id === g.id);
    if (!current) return;
    await updateGarment(g.id, { cleanStatus: 'pending' });
    if (cleanupsRunning >= CLEANUP_PARALLEL) await new Promise<void>((go) => cleanupQueue.push(go));
    cleanupsRunning++;
    try {
      await runCleanUp(current, trigger);
    } finally {
      cleanupsRunning--;
      cleanupQueue.shift()?.();
    }
  });
}

async function runCleanUp(g: Garment, trigger: 'auto' | 'manual'): Promise<void> {
  void trackPanel('photo_cleanup_requested', { itemId: g.id, category: g.category, trigger });
  const started = Date.now();
  try {
    const clean = await cleanUpPhoto(g);
    const current = (await loadState()).garments.find((item) => item.id === g.id);
    if (!current) return;
    if (current.category !== g.category || current.imageVersion !== g.imageVersion) {
      await updateGarment(g.id, { cleanStatus: 'failed' });
      return;
    }
    const cleanImageId = `clean-${g.id}-${crypto.randomUUID()}`;
    await putImage(cleanImageId, clean);
    await updateGarment(g.id, { cleanImageId, cleanStatus: undefined });
    if (current.cleanImageId) await deleteImage(current.cleanImageId);
    void trackPanel('photo_cleanup_completed', { itemId: g.id, seconds: (Date.now() - started) / 1000 });
  } catch (err) {
    if (!(err instanceof RenderError)) console.error('[cabine] clean-up failed', err);
    void trackPanel('photo_cleanup_failed', { itemId: g.id, code: err instanceof RenderError ? err.code : 'unexpected' });
    await updateGarment(g.id, { cleanStatus: 'failed' });
  }
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function notify(text: string): void {
  state.notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    state.notice = null;
    render();
  }, 3000);
  render();
}

// While the QR card is open, check the inbox every few seconds. After the QR
// expires, keep pulling briefly: the phone may still be finishing uploads it
// started in time.
const POLL_MS = 3000;
const GRACE_MS = 2 * 60_000;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let polling = false;
let pollFailures = 0;

function stopPolling(): void {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

async function pollPhone(): Promise<void> {
  const p = state.phone;
  if (!p || polling) return;
  if (Date.now() > p.expiresAt + GRACE_MS) return stopPolling();
  polling = true;
  try {
    const { added } = await pullPhoneUploads(p.token);
    pollFailures = 0;
    added.forEach(phoneArrived);
    if (state.phone !== p) return;
    if (added.length) p.added += added.length;
    if (Date.now() > p.expiresAt) p.status = 'expired';
    render();
  } catch (err) {
    // Network blips are expected on a laptop; only give up after several in a row.
    if (++pollFailures >= 5 && state.phone === p) {
      p.status = 'error';
      p.error = err instanceof RenderError ? err.message : "Can't reach Cabine's server.";
      stopPolling();
      render();
    }
  } finally {
    polling = false;
  }
}

function setRender(r: RenderState | null): void {
  if (state.render?.imageUrl && state.render.imageUrl !== r?.imageUrl) URL.revokeObjectURL(state.render.imageUrl);
  state.render = r;
  render();
}

async function upload(file: File): Promise<void> {
  // A store capture that failed: this upload is its screenshot, so it keeps the
  // store details and goes to the Fitting Room like any capture.
  const failed = state.draft?.status === 'failed' && state.draft.sourceType === 'shopping' ? state.draft : null;
  if (failed) {
    await putImage(failed.id, file);
    void trackPanel('store_item_captured', { itemId: failed.id, domain: domainOf(failed.sourcePageUrl), ok: true, via: 'screenshot' });
    const ready: Draft = { ...failed, imageId: failed.id, status: 'ready', error: undefined };
    const category = inferCategory(failed.title);
    if (category) return saveFromDraft(ready, category, true);
    await setDraft(ready);
    return;
  }
  const id = crypto.randomUUID();
  await putImage(id, file);
  await setDraft({
    id,
    sourceType: 'closet',
    title: file.name.replace(/\.[^.]+$/, ''),
    imageId: id,
    status: 'ready',
    createdAt: Date.now(),
  });
}

function render(): void {
  $('header').replaceChildren(headerView(state, actions));
  $('draft').replaceChildren(...(state.draft ? [draftView(state.draft, actions)] : []));
  const page = state.view === 'cabine' ? cabineView(state, actions) : state.view === 'saved' ? savedView(state, actions) : lookView(state, actions);
  $('main').replaceChildren(page);
  $('notice').replaceChildren(...(state.notice ? [state.notice] : []));
  $('notice').hidden = !state.notice;
  // A ⋯ menu opens leftwards from its tile; on the first column, flip it so it isn't cut off.
  const menu = document.querySelector<HTMLElement>('.menu');
  if (menu && menu.getBoundingClientRect().left < 8) menu.classList.add('flip');
}

let knownIds: Set<string> | undefined;

async function refresh(): Promise<void> {
  const stored = await loadState();
  state.garments = stored.garments;
  state.byId = new Map(stored.garments.map((g) => [g.id, g]));
  state.outfit = pruneOutfit(stored.outfit, state.byId);
  state.draft = stored.draft;
  state.savedLooks = stored.savedLooks;
  state.lookKey = chainOrder(state.outfit, state.byId).length ? await lookKey(state.outfit, state.byId) : null;
  await syncImageUrls([
    ...stored.garments.flatMap((g) => (g.cleanImageId ? [g.imageId, g.cleanImageId] : [g.imageId])),
    ...(stored.draft?.imageId ? [stored.draft.imageId] : []),
    ...stored.savedLooks.map((l) => l.key),
  ]);

  // A store piece just arrived (captured): show the main page on its kind, so
  // it's right there next to what you own. Its category is a guess; "⋯ → Edit
  // category" fixes it.
  const arrived = knownIds ? stored.garments.filter((g) => !knownIds!.has(g.id) && g.location === 'fittingRoom') : [];
  knownIds = new Set(stored.garments.map((g) => g.id));
  if (arrived.length) {
    state.view = 'look';
    state.filter = 'all';
    state.typeFor = null;
    window.scrollTo({ top: 0 });
  }

  // Show a look's saved render when coming back to it; keep an older render
  // (faded) while the look is being changed; clear it when the look is empty.
  if (!state.lookKey) setRender(null);
  else if (state.render?.key !== state.lookKey) {
    const saved = await getSavedRender(state.lookKey);
    if (saved) setRender({ key: state.lookKey, count: chainOrder(state.outfit, state.byId).length, status: 'done', imageUrl: URL.createObjectURL(saved) });
  }
  render();
}

const input = $('upload-input') as HTMLInputElement;
input.addEventListener('change', () => {
  const file = input.files?.[0];
  if (file) void upload(file);
  input.value = ''; // allow picking the same file again
});

// Paste an image (e.g. a screenshot copied with Cmd+Ctrl+Shift+4) anywhere in the panel.
document.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  void upload(file);
});

// Close an open ⋯ menu or the Upload menu when clicking anywhere else.
document.addEventListener('click', (e) => {
  const target = e.target as Element;
  if (state.menuFor && !target.closest('.tile-wrap')) actions.toggleMenu(null);
  if (state.uploadOpen && !target.closest('.upload-wrap')) actions.toggleUpload(false);
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (KEYS.garments in changes || KEYS.outfit in changes || KEYS.draft in changes || KEYS.savedLooks in changes) void refresh();
});

void (async () => {
  await recoverInterruptedCleanups();
  await refresh();
  await withStorageLock('render-cache', async () => {
    const stored = await loadState();
    const byId = new Map(stored.garments.map((g) => [g.id, g]));
    const key = await lookKey(pruneOutfit(stored.outfit, byId), byId);
    await pruneRenderCache(new Set([key, ...stored.savedLooks.filter(isSaved).map((l) => l.key)]));
  });
})().catch((err) => console.error('[cabine] initialization failed', err));
void trackPanel('extension_opened');
startFlushing();
