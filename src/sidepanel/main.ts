import { deleteImage, putImage } from '../shared/images';
import { pruneOutfit, removeFromOutfit, toggleInOutfit } from '../shared/outfit';
import { KEYS, addGarments, loadState, setDraft, setOutfit } from '../shared/store';
import type { Category, Garment } from '../shared/types';
import { syncImageUrls } from './image-urls';
import { draftView, libraryView, lookView, type Actions, type ViewState } from './views';

// Stored state (garments, outfit, draft) is a mirror of chrome.storage.local and
// only changes through storage writes + onChanged. UI-only state (filter,
// notice) lives here.
const state: ViewState = {
  garments: [],
  byId: new Map(),
  outfit: {},
  draft: null,
  filter: 'all',
  notice: null,
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

  toggle(g: Garment) {
    void setOutfit(toggleInOutfit(state.outfit, g));
  },

  clearSlot(category: Category) {
    void setOutfit(removeFromOutfit(state.outfit, category));
  },

  browse(filter) {
    state.filter = filter;
    render();
    $('library').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  styleTogether() {
    // R4-R5: send the chain to the Vercel proxy and show step-by-step progress.
    state.notice = 'Styling connects to FASHN in the next step (R4–R5).';
    render();
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
  state.notice = null;
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
