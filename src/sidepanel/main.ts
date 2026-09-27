import { deleteImage, putImage } from '../shared/images';
import { chainOrder, pruneOutfit, removeFromOutfit, toggleInOutfit } from '../shared/outfit';
import { KEYS, addGarments, loadState, setDraft, setOutfit } from '../shared/store';
import type { Category, Garment } from '../shared/types';
import { syncImageUrls } from './image-urls';
import { RenderError, getSavedRender, lookKey, styleOutfit, type RenderEvent } from './render';
import { draftView, libraryView, lookView, resultView, type Actions, type RenderState, type ViewState } from './views';

// Stored state (garments, outfit, draft) is a mirror of chrome.storage.local and
// only changes through storage writes + onChanged. UI-only state (filter,
// choosing, view, result) lives here.
const state: ViewState = {
  garments: [],
  byId: new Map(),
  outfit: {},
  draft: null,
  filter: 'all',
  choosing: null,
  view: 'build',
  result: null,
};

const $ = (id: string) => document.getElementById(id)!;

const actions: Actions = {
  async saveDraft(category: Category) {
    const d = state.draft;
    if (!d?.imageId) return;
    const garment: Garment = {
      id: d.id,
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
    if (garment.sourceType === 'shopping') await setOutfit(toggleInOutfit(state.outfit, garment));
    await setDraft(null);
  },

  async discardDraft() {
    const d = state.draft;
    await setDraft(null);
    if (d?.imageId) await deleteImage(d.imageId);
  },

  pick(g: Garment) {
    if (state.choosing) {
      // Picking for a slot: wear it (even if it already was) and go back to the look.
      if (state.outfit[g.category] !== g.id) void setOutfit(toggleInOutfit(state.outfit, g));
      state.choosing = null;
      state.filter = 'all';
      render();
      $('look').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    void setOutfit(toggleInOutfit(state.outfit, g)); // browsing: click toggles on/off
  },

  remove(category: Category) {
    void setOutfit(removeFromOutfit(state.outfit, category));
  },

  choose(slot: Category) {
    state.choosing = slot;
    state.filter = slot;
    render();
    $('library').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  async seeOutfit() {
    const garments = chainOrder(state.outfit, state.byId);
    if (!garments.length) return;
    const key = await lookKey(state.outfit, state.byId);
    state.view = 'result';

    // Rendered this exact look before: show it straight away.
    const saved = await getSavedRender(key);
    if (saved) {
      showResult({ key, garments, steps: [], status: 'done', imageUrl: URL.createObjectURL(saved) });
      return;
    }

    showResult({ key, garments, steps: garments.map((g) => ({ category: g.category, status: 'waiting' })), status: 'running' });
    // The render keeps going if the user goes back to edit; its result is saved
    // either way. Updates only apply while this look is still the one on screen.
    const current = () => (state.result?.key === key ? state.result : null);
    try {
      const blob = await styleOutfit(state.outfit, state.byId, (e) => {
        const r = current();
        if (r) applyEvent(r, e);
        render();
      });
      const r = current();
      if (r) Object.assign(r, { status: 'done', imageUrl: URL.createObjectURL(blob) });
    } catch (err) {
      const r = current();
      if (r) Object.assign(r, { status: 'error', error: err instanceof RenderError ? err.message : 'Something went wrong. Please try again.' });
      if (!(err instanceof RenderError)) console.error('[cabine] render failed', err);
    }
    render();
  },

  editLook() {
    state.view = 'build';
    render();
  },
};

function showResult(r: RenderState): void {
  if (state.result?.imageUrl) URL.revokeObjectURL(state.result.imageUrl);
  state.result = r;
  render();
}

// The server's plan says which steps are already made (cached) and which it will make.
function applyEvent(r: RenderState, e: RenderEvent): void {
  if (e.type === 'plan') {
    r.steps = e.steps.map((s) => ({ category: s.category, status: s.cached ? 'done' : 'waiting' }));
    // Hide the mannequin step unless it's actually being made (only the very first time).
    r.steps = r.steps.filter((s) => s.category !== 'base' || s.status !== 'done');
  } else if (e.type === 'step') {
    const step = r.steps.find((s) => s.category === e.category);
    if (step) step.status = e.status;
    if (e.image) r.preview = e.image;
  }
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
  const showResult = state.view === 'result' && state.result;
  $('result').replaceChildren(...(showResult ? [resultView(state.result!, actions)] : []));
  $('look').hidden = $('library').hidden = !!showResult;
  if (!showResult) {
    $('look').replaceChildren(lookView(state, actions));
    $('library').replaceChildren(...libraryView(state, actions).childNodes);
  }
}

async function refresh(): Promise<void> {
  const stored = await loadState();
  state.garments = stored.garments;
  state.byId = new Map(stored.garments.map((g) => [g.id, g]));
  state.outfit = pruneOutfit(stored.outfit, state.byId);
  state.draft = stored.draft;
  await syncImageUrls([...stored.garments.map((g) => g.imageId), ...(stored.draft?.imageId ? [stored.draft.imageId] : [])]);
  render();
}

const input = $('upload-input') as HTMLInputElement;
input.addEventListener('change', () => {
  const file = input.files?.[0];
  if (file) void upload(file);
  input.value = ''; // allow picking the same file again
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (KEYS.garments in changes || KEYS.outfit in changes || KEYS.draft in changes) void refresh();
});

void refresh();
