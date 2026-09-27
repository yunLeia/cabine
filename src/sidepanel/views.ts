import { CATEGORIES, CATEGORY_LABEL, type Category, type Draft, type Garment, type Location, type Outfit } from '../shared/types';
import { h } from './dom';
import { imageUrl } from './image-urls';

// The panel's hierarchy (D18): Your Look on top is the workspace (what I'm
// building now, and its render); the drawers below are where pieces come from.
//   Fitting Room = store pieces I'm considering, as their original photos
//   My Closet    = what I own, optionally with a cleaned-up thumbnail

export interface RenderState {
  key: string; // the look it was made for (render.ts lookKey)
  count: number; // pieces in that look
  status: 'running' | 'done' | 'error';
  cached?: boolean;
  imageUrl?: string;
  error?: string;
}

export interface ViewState {
  garments: Garment[];
  byId: Map<string, Garment>;
  outfit: Outfit;
  draft: Draft | null;
  lookKey: string | null; // the current look's key; null when nothing is selected
  render: RenderState | null; // the latest render; dimmed when it's for an older look
  drawer: Location;
  filter: Category | 'all';
  choosing: Category | null; // the slot the user is picking a garment for
  menuFor: string | null; // garment whose item menu is open
}

export interface Actions {
  saveDraft(category: Category): void;
  discardDraft(): void;
  pick(g: Garment): void;
  takeOff(category: Category): void;
  choose(slot: Category): void;
  cancelChoose(): void;
  filter(filter: Category | 'all'): void;
  openDrawer(drawer: Location): void;
  seeOutfit(): void;
  toggleMenu(id: string | null): void;
  addToCloset(g: Garment): void;
  removeGarment(g: Garment): void;
}

const lower = (c: Category) => CATEGORY_LABEL[c].toLowerCase();
const name = (g: Garment) => g.title ?? CATEGORY_LABEL[g.category];
const DRAWER_LABEL: Record<Location, string> = { fittingRoom: 'Fitting Room', closet: 'My Closet' };

// My Closet shows the cleaned-up photo when there is one; the Fitting Room and
// every render always use the original.
const thumbSrc = (g: Garment) => imageUrl(g.location === 'closet' && g.cleanImageId ? g.cleanImageId : g.imageId);

const img = (src: string | undefined, cls: string, alt = '') =>
  src ? h('img', { class: cls, src, alt }) : h('div', { class: `${cls} thumb-empty` });

// ---- Draft: "What type of item is this?" ----------------------------------------

export function draftView(d: Draft, a: Actions): HTMLElement {
  const status =
    d.status === 'downloading' ? 'Saving the image…' : d.status === 'failed' ? `Couldn't save this image (${d.error}). Try another image.` : null;
  return h(
    'section',
    { class: 'draft', 'aria-label': 'New item' },
    img(imageUrl(d.imageId), 'draft-img'),
    h(
      'div',
      { class: 'draft-body' },
      h('span', { class: 'eyebrow' }, d.sourceType === 'shopping' ? 'To your Fitting Room' : 'To My Closet'),
      d.title && h('strong', { class: 'draft-title', title: d.title }, d.title),
      status ? h('p', { class: 'muted' }, status) : h('p', { class: 'draft-q' }, 'What type of item is this?'),
      d.status === 'ready' &&
        h('div', { class: 'chips' }, ...CATEGORIES.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => a.saveDraft(c) }, CATEGORY_LABEL[c]))),
    ),
    h('button', { type: 'button', class: 'link', onclick: a.discardDraft }, 'Discard'),
  );
}

// ---- Your Look: the workspace ------------------------------------------------------

const LOOK_ORDER: Category[] = ['outerwear', 'dress', 'top', 'bottom', 'shoes']; // head to toe

function renderArea(s: ViewState, a: Actions): HTMLElement | null {
  const r = s.render;
  if (!r) return null;
  const current = r.key === s.lookKey;
  if (r.status === 'running' && current) {
    return h(
      'div',
      { class: 'render-frame running', role: 'status', 'aria-live': 'polite' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('p', { class: 'progress-title' }, 'Styling your look…'),
      h('p', { class: 'muted small' }, r.cached ? 'Almost there' : `${r.count} piece${r.count > 1 ? 's' : ''} · about 15 seconds`),
    );
  }
  if (r.status === 'error' && current) {
    return h(
      'div',
      { class: 'render-frame error', role: 'alert' },
      h('p', {}, r.error ?? 'Something went wrong.'),
      h('button', { type: 'button', class: 'link', onclick: a.seeOutfit }, 'Try again'),
    );
  }
  if (r.status === 'done' && r.imageUrl) {
    // A render for an older look stays visible, dimmed, so you keep your bearings.
    return h(
      'div',
      { class: current ? 'render-frame done' : 'render-frame done outdated' },
      h('img', { class: 'render-img', src: r.imageUrl, alt: 'Your outfit on the mannequin' }),
      !current && h('span', { class: 'outdated-badge' }, 'Look changed'),
    );
  }
  return null;
}

function pieceView(g: Garment, a: Actions): HTMLElement {
  return h(
    'li',
    { class: 'piece' },
    h(
      'button',
      { type: 'button', class: 'piece-main', title: `Change ${lower(g.category)}`, onclick: () => a.choose(g.category) },
      img(thumbSrc(g), 'piece-img'),
      h('span', { class: 'piece-text' }, h('span', { class: 'piece-name' }, name(g)), h('span', { class: 'piece-cat' }, CATEGORY_LABEL[g.category])),
    ),
    h('button', { type: 'button', class: 'icon', 'aria-label': `Take off ${name(g)}`, onclick: () => a.takeOff(g.category) }, '×'),
  );
}

// Slots that can still be filled. A dress replaces top + bottom, so it's offered
// as an alternative rather than as its own always-empty row.
function adders(o: Outfit): { label: string; slot: Category }[] {
  const list: { label: string; slot: Category }[] = [];
  if (!o.dress) {
    if (!o.top) list.push({ label: '+ Top', slot: 'top' });
    if (!o.bottom) list.push({ label: '+ Bottom', slot: 'bottom' });
  }
  if (!o.outerwear) list.push({ label: '+ Outerwear', slot: 'outerwear' });
  if (!o.shoes) list.push({ label: '+ Shoes', slot: 'shoes' });
  if (!o.dress) list.push({ label: o.top || o.bottom ? 'Use a dress instead' : '+ Dress', slot: 'dress' });
  else list.push({ label: 'Use top & bottom instead', slot: 'top' });
  return list;
}

export function lookView(s: ViewState, a: Actions): HTMLElement {
  const worn = LOOK_ORDER.flatMap((c) => {
    const g = s.outfit[c] ? s.byId.get(s.outfit[c]!) : undefined;
    return g ? [g] : [];
  });
  const trying = worn.filter((g) => g.location === 'fittingRoom');
  const owned = worn.filter((g) => g.location === 'closet');
  const upToDate = s.render?.key === s.lookKey && (s.render.status === 'running' || s.render.status === 'done');

  const group = (label: string, items: Garment[], cls: string) =>
    items.length ? h('div', { class: `group ${cls}` }, h('h3', {}, label), h('ul', { class: 'pieces' }, ...items.map((g) => pieceView(g, a)))) : null;

  return h(
    'section',
    { class: 'look', 'aria-label': 'Your look' },
    h('h2', {}, 'Your look'),
    worn.length > 0 && renderArea(s, a),
    worn.length === 0 && h('p', { class: 'muted' }, 'Pick pieces from your Fitting Room or My Closet to see them together.'),
    group('Trying', trying, 'trying'),
    group(trying.length ? 'With my closet' : 'From my closet', owned, 'owned'),
    h(
      'div',
      { class: 'adders' },
      ...adders(s.outfit).map(({ label, slot }) =>
        h('button', { type: 'button', class: label.startsWith('+') ? 'adder' : 'link small', 'aria-pressed': s.choosing === slot, onclick: () => a.choose(slot) }, label),
      ),
    ),
    worn.length > 0 && !upToDate && h('button', { type: 'button', class: 'primary', onclick: a.seeOutfit }, 'See the outfit'),
  );
}

// ---- Drawers: Fitting Room · My Closet ----------------------------------------------

function itemMenu(g: Garment, a: Actions): HTMLElement {
  return h(
    'div',
    { class: 'item-menu', role: 'menu' },
    g.location === 'fittingRoom' &&
      h('button', { type: 'button', role: 'menuitem', onclick: () => a.addToCloset(g) }, 'Add to My Closet'),
    h('button', { type: 'button', role: 'menuitem', class: 'danger', onclick: () => a.removeGarment(g) }, 'Remove'),
  );
}

export function drawersView(s: ViewState, a: Actions): HTMLElement {
  const inDrawer = s.garments.filter((g) => g.location === s.drawer);
  const count = (c: Category) => inDrawer.filter((g) => g.category === c).length;
  const shown = inDrawer.filter((g) => s.filter === 'all' || g.category === s.filter).sort((x, y) => y.createdAt - x.createdAt);

  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    ...(['fittingRoom', 'closet'] as Location[]).map((d) =>
      h(
        'button',
        { type: 'button', role: 'tab', class: 'tab', 'aria-selected': s.drawer === d, onclick: () => a.openDrawer(d) },
        DRAWER_LABEL[d],
        h('span', { class: 'tab-count' }, String(s.garments.filter((g) => g.location === d).length)),
      ),
    ),
  );

  const choosing =
    s.choosing &&
    h(
      'div',
      { class: 'choosing' },
      h('span', {}, `Choose ${/^[aeiou]/i.test(s.choosing) ? 'an' : 'a'} ${lower(s.choosing)}`),
      h('button', { type: 'button', class: 'link small', onclick: a.cancelChoose }, 'Cancel'),
    );

  const filters =
    !s.choosing &&
    inDrawer.length > 0 &&
    h(
      'div',
      { class: 'chips' },
      h('button', { type: 'button', class: 'chip', 'aria-pressed': s.filter === 'all', onclick: () => a.filter('all') }, `All ${inDrawer.length}`),
      ...CATEGORIES.filter((c) => count(c) > 0).map((c) =>
        h('button', { type: 'button', class: 'chip', 'aria-pressed': s.filter === c, onclick: () => a.filter(c) }, `${CATEGORY_LABEL[c]} ${count(c)}`),
      ),
    );

  const shownCategory = s.choosing ?? (s.filter === 'all' ? null : s.filter);
  const empty = () =>
    inDrawer.length === 0 && !shownCategory
      ? s.drawer === 'fittingRoom'
        ? 'Nothing here yet. On any store, right-click a product image and choose "Try in Cabine".'
        : 'Your closet is empty. Upload photos of clothes you own.'
      : `No ${shownCategory ? lower(shownCategory) : 'items'} in your ${DRAWER_LABEL[s.drawer]}.`;

  const grid = shown.length
    ? h(
        'div',
        { class: 'grid' },
        ...shown.map((g) =>
          h(
            'div',
            { class: 'item-wrap' },
            h(
              'button',
              { type: 'button', class: 'item', title: name(g), 'aria-pressed': s.outfit[g.category] === g.id, onclick: () => a.pick(g) },
              img(thumbSrc(g), 'item-img', name(g)),
            ),
            h(
              'button',
              { type: 'button', class: 'item-more', 'aria-label': `More for ${name(g)}`, 'aria-expanded': s.menuFor === g.id, onclick: () => a.toggleMenu(s.menuFor === g.id ? null : g.id) },
              '⋯',
            ),
            s.menuFor === g.id && itemMenu(g, a),
          ),
        ),
      )
    : h('p', { class: 'muted' }, empty());

  return h('section', { class: 'drawers', id: 'drawers', 'aria-label': 'Your pieces' }, tabs, choosing, filters, grid);
}
