import { deleteImage, putImage } from '../shared/images';
import { pruneOutfit, removeFromOutfit, toggleInOutfit } from '../shared/outfit';
import { KEYS, addGarments, loadState, setDraft, setOutfit } from '../shared/store';
import type { Category, Garment } from '../shared/types';
import { syncImageUrls } from './image-urls';
import { draftView, libraryView, lookView, type Actions, type ViewState } from './views';

// Stored state (garments, outfit, draft) is a mirror of chrome.storage.local and
// only changes through storage writes + onChanged. UI-only state (filter,
// choosing) lives here.
const state: ViewState = {
  garments: [],
  byId: new Map(),
  outfit: {},
  draft: null,
  filter: 'all',
  choosing: null,
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

  seeOutfit() {
    // R5: render through the proxy and switch to the result view.
  },
};

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
  $('library').replaceChildren(...libraryView(state, actions).childNodes);
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
