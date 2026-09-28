import { deleteImage, putImage } from '../shared/images';
import { chainOrder, pruneOutfit, removeFromOutfit, toggleInOutfit } from '../shared/outfit';
import { KEYS, addGarments, loadState, removeGarment, setDraft, setOutfit, updateGarment } from '../shared/store';
import type { Category, Garment } from '../shared/types';
import { syncImageUrls } from './image-urls';
import { startFlushing, trackPanel } from './analytics';
import { pullPhoneUploads, startPhoneSession } from './phone';
import { RenderError, cleanUpPhoto, getSavedRender, lookKey, needsCleanup, styleOutfit } from './render';
import { draftView, drawersView, lookView, type Actions, type RenderState, type ViewState } from './views';

// Stored state (garments, outfit, draft) mirrors chrome.storage.local and only
// changes through storage writes + onChanged. The rest is UI state.
const state: ViewState = {
  garments: [],
  byId: new Map(),
  outfit: {},
  draft: null,
  lookKey: null,
  render: null,
  drawer: 'closet',
  filter: 'all',
  choosing: null,
  menuFor: null,
  confirmBuy: null,
  phone: null,
};

const $ = (id: string) => document.getElementById(id)!;

const actions: Actions = {
  async saveDraft(category: Category) {
    const d = state.draft;
    if (!d?.imageId) return;
    const garment: Garment = {
      id: d.id,
      // Store captures wait in the Fitting Room; your own uploads are yours already.
      location: d.sourceType === 'shopping' ? 'fittingRoom' : 'closet',
      sourceType: d.sourceType,
      category,
      title: d.title,
      sourcePageUrl: d.sourcePageUrl,
      sourceImageUrl: d.sourceImageUrl,
      imageId: d.imageId,
      imageVersion: 1,
      createdAt: Date.now(),
    };
    await addGarments([garment]);
    if (garment.location === 'fittingRoom') void trackPanel('store_item_category_selected', { itemId: garment.id, category });
    else void trackPanel('closet_item_uploaded', { itemId: garment.id, category, source: 'device' });
    // A store capture is the piece being considered, so it goes straight into the look.
    if (garment.location === 'fittingRoom') await setOutfit(toggleInOutfit(state.outfit, garment));
    state.drawer = garment.location;
    state.filter = 'all';
    await setDraft(null);
  },

  async discardDraft() {
    const d = state.draft;
    await setDraft(null);
    if (d?.imageId) await deleteImage(d.imageId);
  },

  pick(g: Garment) {
    state.menuFor = null;
    if (state.outfit[g.category] !== g.id) {
      void trackPanel(g.location === 'fittingRoom' ? 'fitting_room_item_selected' : 'closet_item_selected', {
        itemId: g.id,
        category: g.category,
        viaSlot: !!state.choosing,
      });
    }
    if (state.choosing) {
      // Picking for a slot: wear it (even if it already was) and go back to the look.
      if (state.outfit[g.category] !== g.id) void setOutfit(toggleInOutfit(state.outfit, g));
      state.choosing = null;
      state.filter = 'all';
      render();
      $('look').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    void setOutfit(toggleInOutfit(state.outfit, g)); // browsing: tap puts it on or takes it off
  },

  takeOff(category: Category) {
    void setOutfit(removeFromOutfit(state.outfit, category));
  },

  choose(slot: Category) {
    // Pieces to wear with a candidate usually come from what you own, so start
    // in My Closet (the Fitting Room tab is still one tap away).
    state.choosing = slot;
    state.drawer = 'closet';
    state.filter = slot;
    state.menuFor = null;
    render();
    $('drawers').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  cancelChoose() {
    state.choosing = null;
    state.filter = 'all';
    render();
  },

  filter(filter) {
    state.filter = filter;
    render();
  },

  openDrawer(drawer) {
    state.drawer = drawer;
    // Keep a slot filter while choosing; otherwise start the other drawer unfiltered.
    if (!state.choosing) state.filter = 'all';
    state.menuFor = null;
    render();
  },

  async seeOutfit() {
    const garments = chainOrder(state.outfit, state.byId);
    const key = state.lookKey;
    if (!garments.length || !key) return;

    setRender({ key, count: garments.length, status: 'running' });
    const candidates = garments.filter((g) => g.location === 'fittingRoom');
    void trackPanel('outfit_render_requested', {
      pieces: garments.length,
      fromFittingRoom: candidates.length,
      fromCloset: garments.length - candidates.length,
      categories: garments.map((g) => g.category),
      candidateIds: candidates.map((g) => g.id),
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

  toggleMenu(id) {
    state.menuFor = id;
    render();
  },

  async addToCloset(g: Garment) {
    state.menuFor = null;
    state.drawer = 'closet'; // follow it, so the clean-up is visible
    state.filter = 'all';
    await moveToCloset(g, {}, 'menu');
  },

  async decide(g: Garment, decision: 'buy' | 'save' | 'pass') {
    state.confirmBuy = null;
    const decided = { decision, decidedAt: Date.now() };
    void trackPanel(`decision_${decision}`, { itemId: g.id, category: g.category });
    if (decision === 'buy') {
      await moveToCloset(g, decided, 'buy'); // bought: it's yours now
    } else if (decision === 'save') {
      await updateGarment(g.id, decided); // stays in the Fitting Room, marked Saved
    } else {
      // Pass: out of the look and the drawers, but the record stays for counting.
      await updateGarment(g.id, decided);
      await setOutfit(removeFromOutfit(state.outfit, g.category));
    }
  },

  async usePhone() {
    stopPolling();
    state.drawer = 'closet';
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

  askBuy(id) {
    state.confirmBuy = id;
    render();
  },

  openOriginal(g: Garment) {
    state.menuFor = null;
    render();
    if (g.sourcePageUrl && /^https?:\/\//.test(g.sourcePageUrl)) void chrome.tabs.create({ url: g.sourcePageUrl });
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

  async removeGarment(g: Garment) {
    state.menuFor = null;
    if (!confirm(`Remove "${g.title ?? 'this item'}" from Cabine?`)) return render();
    await removeGarment(g.id);
    await setOutfit(pruneOutfit(state.outfit, new Map(state.garments.filter((x) => x.id !== g.id).map((x) => [x.id, x]))));
    await Promise.all([deleteImage(g.imageId), g.cleanImageId ? deleteImage(g.cleanImageId) : null]);
  },
};

// Owned now: move it right away, then clean up its photo in the background if
// it's a model shot or busy photo (1 credit). Clean product shots are skipped.
async function moveToCloset(g: Garment, patch: Partial<Garment>, via: 'buy' | 'menu'): Promise<void> {
  await updateGarment(g.id, { ...patch, location: 'closet' });
  const needed = await needsCleanup(g);
  void trackPanel('item_moved_to_closet', { itemId: g.id, category: g.category, via, needsCleanup: needed });
  if (needed) void cleanUp(g, 'auto');
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
    if (added.length) {
      p.added += added.length;
      state.drawer = 'closet';
      state.filter = 'all';
    }
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
  $('draft').replaceChildren(...(state.draft ? [draftView(state.draft, actions)] : []));
  $('look').replaceChildren(lookView(state, actions));
  $('drawers').replaceChildren(...drawersView(state, actions).childNodes);
}

async function refresh(): Promise<void> {
  const stored = await loadState();
  state.garments = stored.garments;
  state.byId = new Map(stored.garments.map((g) => [g.id, g]));
  state.outfit = pruneOutfit(stored.outfit, state.byId);
  state.draft = stored.draft;
  state.lookKey = chainOrder(state.outfit, state.byId).length ? await lookKey(state.outfit, state.byId) : null;
  await syncImageUrls([
    ...stored.garments.flatMap((g) => (g.cleanImageId ? [g.imageId, g.cleanImageId] : [g.imageId])),
    ...(stored.draft?.imageId ? [stored.draft.imageId] : []),
  ]);

  // Show a look's saved render when coming back to it; keep an older render
  // (dimmed) while the look is being changed; clear it when the look is empty.
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

// Close an open item menu when clicking anywhere else.
document.addEventListener('click', (e) => {
  if (state.menuFor && !(e.target as Element).closest('.item-wrap')) actions.toggleMenu(null);
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (KEYS.garments in changes || KEYS.outfit in changes || KEYS.draft in changes) void refresh();
});

void refresh();
void trackPanel('extension_opened');
startFlushing();
