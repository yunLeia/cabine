import { CATEGORIES, type Category, type Garment } from '../shared/types';
import { SAMPLE_CANDIDATES, SEED_CLOSET } from '../shared/seed';
import { CAPTURE_KEY, type Capture } from '../shared/capture';
import { deleteImage, getImage } from '../shared/images';
import { renderMannequin } from './mannequin';
import { renderCloset } from './closet';

interface State {
  outfit: Partial<Record<Category, string>>; // closet garment id worn per slot (in memory until M1.5)
  capture: Capture | null; // mirror of chrome.storage.local[CAPTURE_KEY]; never set directly
  processed: { imageId: string; url: string } | null; // object URL for the capture's IndexedDB image
}

const state: State = {
  outfit: { top: 'sweater-puff-grey', bottom: 'jeans-dark-highrise' },
  capture: null,
  processed: null,
};

const $ = (id: string) => document.getElementById(id)!;
const byId = new Map(SEED_CLOSET.map((g) => [g.id, g]));
const CATEGORY_LABEL: Record<Category, string> = { top: 'Top', bottom: 'Bottom', outerwear: 'Outerwear' };

// A capture becomes the candidate garment once it has a category.
function candidate(): Garment | null {
  const c = state.capture;
  if (!c?.category) return null;
  return { id: c.id, source: 'captured', name: c.title, category: c.category, imageSrc: captureImageSrc(c) };
}

// The cleaned copy once it's loaded; the retailer's original until then.
function captureImageSrc(c: Capture): string {
  return state.processed && state.processed.imageId === c.imageId ? state.processed.url : c.srcUrl;
}

// Blobs can't go in an <img> directly: load it from IndexedDB and give it a
// temporary object URL, revoking the previous one so it doesn't leak.
async function syncProcessedImage(): Promise<void> {
  const imageId = state.capture?.imageId;
  if (state.processed?.imageId === imageId) return;
  if (state.processed) URL.revokeObjectURL(state.processed.url);
  state.processed = null;
  const blob = imageId ? await getImage(imageId) : undefined;
  if (blob && state.capture?.imageId === imageId) {
    state.processed = { imageId: imageId!, url: URL.createObjectURL(blob) };
  }
}

function statusText(c: Capture): string {
  if (c.status === 'processing') return 'Cleaning up the image…';
  if (c.status === 'failed') return `Showing the original: ${c.error ?? 'processing failed'}`;
  if (c.stats && c.stats.bgRemoved < 0.02) return 'No plain background found, so it was left as is';
  return '';
}

// The candidate always owns its category's slot. Its closet counterpart stays
// in state.outfit, so clearing the candidate puts the old piece back.
function wornGarments(): Garment[] {
  const cand = candidate();
  return CATEGORIES.flatMap((cat) => {
    if (cand?.category === cat) return [cand];
    const id = state.outfit[cat];
    const g = id ? byId.get(id) : undefined;
    return g ? [g] : [];
  });
}

// With a candidate, showing its own category in the closet is pointless: you
// already know what goes in that slot. Show only what it could be worn with.
function closetCategories(): Category[] {
  const order: Category[] = ['top', 'bottom', 'outerwear'];
  return order.filter((c) => c !== candidate()?.category);
}

function pick(g: Garment): void {
  // Clicking the piece already worn takes it off (e.g. no outerwear).
  state.outfit[g.category] = state.outfit[g.category] === g.id ? undefined : g.id;
  render();
}

// Writes go to storage only; the onChanged listener below updates state and
// re-renders. One path, whether the change came from the panel or the worker.
function saveCapture(c: Capture | null): void {
  void (c ? chrome.storage.local.set({ [CAPTURE_KEY]: c }) : chrome.storage.local.remove(CAPTURE_KEY));
}

function renderCandidate(): void {
  const root = $('candidate');
  const c = state.capture;
  root.hidden = !c;
  if (!c) return root.replaceChildren();

  const img = document.createElement('img');
  img.src = captureImageSrc(c);
  img.alt = '';

  const text = document.createElement('div');
  text.className = 'candidate-text';
  const label = document.createElement('span');
  label.className = 'candidate-label';
  label.textContent = c.category ? 'Trying on' : 'What is this?';
  const name = document.createElement('strong');
  name.textContent = c.title;
  name.title = c.title;

  const chips = document.createElement('div');
  chips.className = 'candidate-chips';
  for (const cat of CATEGORIES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = CATEGORY_LABEL[cat];
    chip.setAttribute('aria-pressed', String(c.category === cat));
    chip.addEventListener('click', () => saveCapture({ ...c, category: cat }));
    chips.append(chip);
  }
  text.append(label, name, chips);
  const status = statusText(c);
  if (status) {
    const note = document.createElement('span');
    note.className = 'candidate-status';
    note.textContent = status;
    text.append(note);
  }

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'candidate-clear';
  clear.textContent = 'Remove';
  clear.addEventListener('click', () => {
    if (c.imageId) void deleteImage(c.imageId);
    saveCapture(null);
  });

  root.replaceChildren(img, text, clear);
}

function render(): void {
  renderMannequin($('stage'), wornGarments());
  renderCandidate();
  renderCloset($('closet'), {
    categories: closetCategories(),
    items: SEED_CLOSET,
    isWorn: (g) => state.outfit[g.category] === g.id,
    onPick: pick,
  });
}

// Dev stub: writes a capture exactly like the right-click handler does.
for (const sample of SAMPLE_CANDIDATES) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = sample.name;
  btn.addEventListener('click', () =>
    saveCapture({
      id: crypto.randomUUID(),
      srcUrl: sample.imageSrc,
      title: sample.name,
      category: sample.category,
      capturedAt: Date.now(),
      status: 'ready',
    }),
  );
  $('dev-samples').append(btn);
}

async function setCapture(c: Capture | undefined): Promise<void> {
  state.capture = c ?? null;
  render(); // show the change immediately (original image while processing)
  await syncProcessedImage();
  render(); // then swap in the processed image if there is one
}

chrome.storage.local.onChanged.addListener((changes) => {
  if (CAPTURE_KEY in changes) void setCapture(changes[CAPTURE_KEY].newValue as Capture | undefined);
});

render();
chrome.storage.local.get(CAPTURE_KEY).then((items) => setCapture(items[CAPTURE_KEY] as Capture | undefined));
