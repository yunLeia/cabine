import { deleteImage, putImage } from '../shared/images';
import { chainOrder, pruneOutfit, removeFromOutfit, toggleInOutfit } from '../shared/outfit';
import { KEYS, addGarments, loadState, removeGarment, setDraft, setOutfit, updateGarment } from '../shared/store';
import type { Category, Garment } from '../shared/types';
import { syncImageUrls } from './image-urls';
import { RenderError, getSavedRender, lookKey, styleOutfit } from './render';
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
    state.choosing = slot;
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
    // The render keeps going if the look changes meanwhile; its result is saved
    // either way and shown if the user comes back to this look.
    try {
      const blob = await styleOutfit(state.outfit, state.byId, (e) => {
        if (e.type === 'plan' && state.render?.key === key) {
          state.render.cached = e.cached;
          render();
        }
      });
      if (state.render?.key === key) setRender({ key, count: garments.length, status: 'done', imageUrl: URL.createObjectURL(blob) });
    } catch (err) {
      if (!(err instanceof RenderError)) console.error('[cabine] render failed', err);
      const message = err instanceof RenderError ? err.message : 'Something went wrong. Please try again.';
      if (state.render?.key === key) setRender({ key, count: garments.length, status: 'error', error: message });
    }
  },

  toggleMenu(id) {
    state.menuFor = id;
    render();
  },

  async addToCloset(g: Garment) {
    // Step (b): extract a clean product photo here when the original needs it.
    state.menuFor = null;
    await updateGarment(g.id, { location: 'closet' });
  },

  async removeGarment(g: Garment) {
    state.menuFor = null;
    if (!confirm(`Remove "${g.title ?? 'this item'}" from Cabine?`)) return render();
    await removeGarment(g.id);
    await setOutfit(pruneOutfit(state.outfit, new Map(state.garments.filter((x) => x.id !== g.id).map((x) => [x.id, x]))));
    await Promise.all([deleteImage(g.imageId), g.cleanImageId ? deleteImage(g.cleanImageId) : null]);
  },
};

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
