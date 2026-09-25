import { CATEGORIES, type Category, type Garment } from '../shared/types';
import { SAMPLE_CANDIDATES, SEED_CLOSET } from '../shared/seed';
import { renderMannequin } from './mannequin';
import { renderCloset } from './closet';

// In-memory for M1.1; persisted in M1.5.
interface State {
  outfit: Partial<Record<Category, string>>; // closet garment id worn per slot
  candidate: Garment | null; // the piece being considered for purchase
}

const state: State = {
  outfit: { top: 'sweater-puff-grey', bottom: 'jeans-dark-highrise' },
  candidate: null,
};

const $ = (id: string) => document.getElementById(id)!;
const byId = new Map(SEED_CLOSET.map((g) => [g.id, g]));

// The candidate always owns its category's slot. Its closet counterpart stays
// in state.outfit, so clearing the candidate puts the old piece back.
function wornGarments(): Garment[] {
  return CATEGORIES.flatMap((cat) => {
    if (state.candidate?.category === cat) return [state.candidate];
    const id = state.outfit[cat];
    const g = id ? byId.get(id) : undefined;
    return g ? [g] : [];
  });
}

// With a candidate, showing its own category in the closet is pointless: you
// already know what goes in that slot. Show only what it could be worn with.
function closetCategories(): Category[] {
  const order: Category[] = ['top', 'bottom', 'outerwear'];
  return order.filter((c) => c !== state.candidate?.category);
}

function pick(g: Garment): void {
  // Clicking the piece already worn takes it off (e.g. no outerwear).
  state.outfit[g.category] = state.outfit[g.category] === g.id ? undefined : g.id;
  render();
}

function renderCandidate(): void {
  const root = $('candidate');
  const c = state.candidate;
  root.hidden = !c;
  if (!c) return root.replaceChildren();

  const img = document.createElement('img');
  img.src = c.imageSrc;
  img.alt = '';
  const text = document.createElement('div');
  text.className = 'candidate-text';
  text.innerHTML = '<span class="candidate-label">Trying on</span>';
  const name = document.createElement('strong');
  name.textContent = c.name;
  text.append(name);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'candidate-clear';
  clear.textContent = 'Remove';
  clear.addEventListener('click', () => {
    state.candidate = null;
    render();
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

// Dev stub standing in for right-click capture until M1.2.
for (const sample of SAMPLE_CANDIDATES) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = sample.name;
  btn.addEventListener('click', () => {
    state.candidate = sample;
    render();
  });
  $('dev-samples').append(btn);
}

render();
