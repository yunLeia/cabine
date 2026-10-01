import '@fontsource-variable/inter-tight';
import { domainOf } from '../shared/analytics';
import { deleteImage, putImage } from '../shared/images';
import { inferCategory } from '../shared/infer';
import { chainOrder, pruneOutfit, removeFromOutfit, toggleInOutfit } from '../shared/outfit';
import { KEYS, addGarments, loadState, removeGarment, setDraft, setOutfit, setSavedLooks, updateGarment, updateGarments } from '../shared/store';
import type { Category, Draft, Garment } from '../shared/types';
import { syncImageUrls } from './image-urls';
import { startFlushing, trackPanel } from './analytics';
import { pullPhoneUploads, startPhoneSession } from './phone';
import { RenderError, cleanUpPhoto, getSavedRender, lookKey, needsCleanup, styleOutfit } from './render';
import { candidateOf, closetView, draftView, fittingRoomView, headerView, lookView, type Actions, type RenderState, type ViewState } from './views';

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
  editing: false,
  showAll: false,
  filter: 'all',
  menuFor: null,
  typeFor: null,
  notice: null,
  phone: null,
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

  consider(g: Garment) {
    // A store piece from the Fitting Room: start a fresh look around it.
    state.menuFor = null;
    void trackPanel('fitting_room_item_selected', { itemId: g.id, category: g.category, viaSlot: false });
    state.view = 'look';
    void setOutfit({ [g.category]: g.id });
    render();
  },

  takeOff(g: Garment) {
    void setOutfit(removeFromOutfit(state.outfit, g.category));
  },

  setView(v) {
    state.view = v;
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

    state.editing = false;
    state.showAll = false;
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
    // Keep the picture; open the closet again under it.
    state.editing = true;
    void trackPanel('try_another_look', { pieces: chainOrder(state.outfit, state.byId).length });
    render();
  },

  backToLook() {
    state.editing = false;
    render();
  },

  async toggleSave() {
    const key = state.lookKey;
    if (!key) return;
    const saved = state.savedLooks.some((l) => l.key === key);
    if (saved) {
      await setSavedLooks(state.savedLooks.filter((l) => l.key !== key));
    } else {
      await setSavedLooks([...state.savedLooks, { key, outfit: { ...state.outfit }, createdAt: Date.now() }]);
      void trackPanel('look_saved', { pieces: chainOrder(state.outfit, state.byId).length, candidateIds: chainOrder(state.outfit, state.byId).filter((g) => g.location === 'fittingRoom').map((g) => g.id) });
    }
  },

  openSavedLook(l) {
    state.view = 'look';
    state.editing = false;
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
    await updateGarment(g.id, { category: c });
    // Still in the look, now in its right place.
    if (wasOn) await setOutfit(toggleInOutfit(removeFromOutfit(state.outfit, g.category), { ...g, category: c }));
  },

  async addToCloset(g: Garment) {
    state.menuFor = null;
    await updateGarment(g.id, { location: 'closet' });
    notify('Added to My Closet');
    const needed = await needsCleanup(g);
    void trackPanel('item_moved_to_closet', { itemId: g.id, category: g.category, via: 'menu', needsCleanup: needed });
    if (needed) void cleanUp(g, 'auto');
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

  setShowAll(on) {
    state.showAll = on;
    state.filter = 'all';
    render();
  },

  filter(f) {
    state.filter = f;
    render();
  },

  async usePhone() {
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
        .then(({ added }) => added.forEach((g) => void trackPanel('closet_item_uploaded', { itemId: g.id, category: g.category, source: 'phone' })))
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
    await setOutfit({ [category]: g.id });
    state.view = 'look';
  } else {
    void trackPanel('closet_item_uploaded', { itemId: g.id, category, source: 'device' });
    if (candidateOf(state)) await setOutfit(toggleInOutfit(state.outfit, g));
    notify('Added to My Closet');
  }
  await setDraft(null);
}

async function cleanUp(g: Garment, trigger: 'auto' | 'manual'): Promise<void> {
  await updateGarment(g.id, { cleanStatus: 'pending' });
  void trackPanel('photo_cleanup_requested', { itemId: g.id, category: g.category, trigger });
  const started = Date.now();
  try {
    const clean = await cleanUpPhoto(g);
    const cleanImageId = `clean-${g.id}`;
    await putImage(cleanImageId, clean);
    await updateGarment(g.id, { cleanImageId, cleanStatus: undefined });
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
    for (const g of added) void trackPanel('closet_item_uploaded', { itemId: g.id, category: g.category, source: 'phone' });
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
  const page = state.view === 'fittingRoom' ? fittingRoomView(state, actions) : state.view === 'closet' ? closetView(state, actions) : lookView(state, actions);
  $('main').replaceChildren(page);
  $('notice').replaceChildren(...(state.notice ? [state.notice] : []));
  $('notice').hidden = !state.notice;
}

let lastCandidate: string | undefined;

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

  // A new store piece in the look (just captured, or picked in the Fitting Room):
  // go to it and ask what goes with it.
  const candidate = candidateOf(state)?.id;
  if (candidate && candidate !== lastCandidate) {
    state.view = 'look';
    state.editing = false;
    state.showAll = false;
    state.typeFor = null;
  }
  lastCandidate = candidate;

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

// Close an open ⋯ menu when clicking anywhere else.
document.addEventListener('click', (e) => {
  if (state.menuFor && !(e.target as Element).closest('.tile-wrap')) actions.toggleMenu(null);
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (KEYS.garments in changes || KEYS.outfit in changes || KEYS.draft in changes || KEYS.savedLooks in changes) void refresh();
});

void refresh();
void trackPanel('extension_opened');
startFlushing();
