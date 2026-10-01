import { CATEGORIES, CATEGORY_LABEL, type Category, type Draft, type Garment, type Outfit, type SavedLook } from '../shared/types';
import { productName } from '../shared/infer';
import { h } from './dom';
import { imageUrl } from './image-urls';
import { qrSvg, type PhoneSession } from './phone';

// The panel (D26): one loop, "I found this → what do I have that works with
// it? → see them together". Your Look is the workspace; Fitting Room and My
// Closet are places to go when needed, from the header. Categories, slots and
// the dress rule stay internal; the user only picks pieces.

export type View = 'look' | 'fittingRoom' | 'closet';

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
  savedLooks: SavedLook[];
  lookKey: string | null; // the current look's key; null when nothing is selected
  render: RenderState | null; // the latest render; dimmed when it's for an older look
  view: View;
  filter: Category | 'all';
  menuFor: string | null; // garment whose ⋯ menu is open
  typeFor: string | null; // garment whose type is being corrected
  cleared: boolean; // "Try another": back to the empty mannequin, pieces still chosen
  notice: string | null; // a short confirmation at the bottom
  phone: PhoneSession | null; // an open "Use your phone" QR session
}

export interface Actions {
  saveDraft(category: Category): void;
  discardDraft(): void;
  pick(g: Garment): void; // put on / take off, in the current look
  consider(g: Garment): void; // from the Fitting Room page: wear it, back on the main page
  takeOff(g: Garment): void;
  setView(v: View): void;
  seeTogether(): void;
  tryAnother(): void;
  toggleSave(): void;
  openSavedLook(l: SavedLook): void;
  openOriginal(g: Garment, from: 'result' | 'menu'): void;
  toggleMenu(id: string | null): void;
  editType(id: string | null): void;
  changeType(g: Garment, c: Category): void;
  addToCloset(g: Garment): void;
  cleanUp(g: Garment): void;
  useOriginal(g: Garment): void;
  filter(f: Category | 'all'): void;
  usePhone(): void;
  closePhone(): void;
  removeGarment(g: Garment): void;
}

const name = (g: Garment) => (g.title ? productName(g.title) : CATEGORY_LABEL[g.category]);
const STORE_HINT = 'On any store, right-click a product image and choose "Take it to Cabine".';

// My Closet shows the cleaned-up photo when there is one; store pieces and
// every render always use the original.
const thumbSrc = (g: Garment) => imageUrl(g.location === 'closet' && g.cleanImageId ? g.cleanImageId : g.imageId);

const img = (src: string | undefined, cls: string, alt = '') =>
  src ? h('img', { class: cls, src, alt }) : h('div', { class: `${cls} thumb-empty` });

// ---- Shared pieces ----------------------------------------------------------------

const LOOK_ORDER: Category[] = ['outerwear', 'dress', 'top', 'bottom', 'shoes']; // head to toe

export function wornPieces(s: ViewState): Garment[] {
  return LOOK_ORDER.flatMap((c) => {
    const g = s.outfit[c] ? s.byId.get(s.outfit[c]!) : undefined;
    return g ? [g] : [];
  });
}

// The store piece the look is about: the newest one in it.
export function candidateOf(s: ViewState): Garment | undefined {
  return wornPieces(s)
    .filter((g) => g.location === 'fittingRoom')
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

const inLook = (s: ViewState, g: Garment) => s.outfit[g.category] === g.id;

function typeEditor(g: Garment, a: Actions): HTMLElement {
  return h(
    'div',
    { class: 'type-editor' },
    h('span', { class: 'small muted' }, 'What is it?'),
    h(
      'div',
      { class: 'type-options' },
      ...CATEGORIES.map((c) =>
        h('button', { type: 'button', class: 'type-option', 'aria-pressed': g.category === c, onclick: () => a.changeType(g, c) }, CATEGORY_LABEL[c]),
      ),
      h('button', { type: 'button', class: 'text-button small', onclick: () => a.editType(null) }, 'Cancel'),
    ),
  );
}

// While a piece's photo is being cleaned up: a hanger turning on its hook.
const HANGER = '<svg viewBox="0 0 64 48" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M26 10a6 6 0 1 1 9 5.2c-1.8 1-3 2.2-3 4.3V21"/><path d="M32 21 5 37.5c-1.8 1.1-1 3.5 1 3.5h52c2 0 2.8-2.4 1-3.5z"/></g></svg>';
function cleaningOverlay(): HTMLElement {
  const hanger = h('span', { class: 'hanger' });
  hanger.innerHTML = HANGER; // static markup
  return h('span', { class: 'cleaning', role: 'status' }, hanger, h('span', { class: 'cleaning-text' }, 'Cleaning up'));
}

function tile(s: ViewState, g: Garment, a: Actions, opts: { onclick: () => void; selected: boolean; menu?: boolean }): HTMLElement {
  return h(
    'div',
    { class: 'tile-wrap' },
    h(
      'button',
      { type: 'button', class: 'tile', title: name(g), 'aria-pressed': opts.selected, onclick: opts.onclick },
      img(thumbSrc(g), 'tile-img', name(g)),
      h('span', { class: 'tile-check', 'aria-hidden': 'true' }, '✓'),
      g.location === 'fittingRoom' && h('span', { class: 'tile-tag' }, 'Store'),
      g.location === 'closet' && g.cleanStatus === 'pending' && cleaningOverlay(),
      g.location === 'closet' && g.cleanStatus === 'failed' && h('span', { class: 'tile-badge failed' }, "Couldn't clean up"),
    ),
    opts.menu &&
      h(
        'button',
        { type: 'button', class: 'tile-more', 'aria-label': `More for ${name(g)}`, 'aria-expanded': s.menuFor === g.id, onclick: () => a.toggleMenu(s.menuFor === g.id ? null : g.id) },
        '⋯',
      ),
    opts.menu && s.menuFor === g.id && itemMenu(s, g, a),
  );
}

function itemMenu(s: ViewState, g: Garment, a: Actions): HTMLElement {
  const store = g.location === 'fittingRoom';
  const item = (label: string, onclick: () => void, cls?: string) => h('button', { type: 'button', role: 'menuitem', class: cls, onclick }, label);
  return h(
    'div',
    { class: 'menu', role: 'menu' },
    store && g.sourcePageUrl && item('Open original page ↗', () => a.openOriginal(g, 'menu')),
    store && item(inLook(s, g) ? 'Take off this look' : 'Add to this look', () => a.pick(g)),
    item('Edit category', () => a.editType(g.id)),
    store && item('I got this — add to My Closet', () => a.addToCloset(g)),
    !store && g.cleanStatus === 'failed' && item('Try the clean-up again', () => a.cleanUp(g)),
    !store && g.cleanImageId && item('Use original photo', () => a.useOriginal(g)),
    item('Remove', () => a.removeGarment(g), 'danger'),
  );
}

// ---- Draft: a capture that's still saving, couldn't be saved, or needs its type --------

export function draftView(d: Draft, a: Actions): HTMLElement {
  const fromStore = d.sourceType === 'shopping';
  const head = (body: (HTMLElement | false | undefined)[]) =>
    h(
      'section',
      { class: `draft${d.status === 'failed' ? ' failed' : ''}`, 'aria-label': 'New piece', role: d.status === 'failed' ? 'alert' : undefined },
      d.status !== 'failed' && img(imageUrl(d.imageId), 'draft-img'),
      h('div', { class: 'draft-body' }, h('span', { class: 'eyebrow' }, fromStore ? 'From the store' : 'To My Closet'), d.title && h('strong', { class: 'draft-title', title: d.title }, productName(d.title)), ...body),
      h('button', { type: 'button', class: 'text-button small', onclick: a.discardDraft }, 'Discard'),
    );
  if (d.status === 'failed') {
    // Some stores block downloads. A screenshot of the product works just as well.
    return head([
      h('p', {}, "This store didn't let Cabine save the image."),
      h('p', { class: 'muted small' }, 'Take a screenshot of the product, then upload it or paste it here (⌘V).'),
      h('label', { class: 'btn btn-secondary', for: 'upload-input' }, 'Upload a screenshot'),
    ]);
  }
  if (d.status === 'downloading') return head([h('p', { class: 'muted small' }, 'Saving the image…')]);
  return head([
    h('p', { class: 'small' }, 'What is it?'),
    h('div', { class: 'type-options' }, ...CATEGORIES.map((c) => h('button', { type: 'button', class: 'type-option', onclick: () => a.saveDraft(c) }, CATEGORY_LABEL[c]))),
  ]);
}

// ---- Your Look --------------------------------------------------------------------

// The panel is redrawn on every change; the picture resolves only the first time it's shown.
const revealed = new Set<string>();
const markRevealed = (url: string) => queueMicrotask(() => revealed.add(url));

const MANNEQUIN = '/mannequin.jpg';

// The mannequin frame: empty until you ask to see the look, then "Putting it
// together…", then the result. It keeps the mannequin's proportions so the whole
// figure is always visible, however wide the panel is.
function lookFrame(s: ViewState, a: Actions, worn: Garment[]): HTMLElement {
  const r = s.render;
  const current = !!r && r.key === s.lookKey && !s.cleared;
  if (r?.status === 'running' && current) {
    return h(
      'div',
      { class: 'render-frame running', role: 'status', 'aria-live': 'polite' },
      h('img', { class: 'render-img mannequin', src: MANNEQUIN, alt: '' }),
      h('div', { class: 'frame-overlay' }, h('p', { class: 'running-title' }, 'Putting it together…'), h('p', { class: 'muted small' }, r.cached ? 'Almost there' : 'About 15 seconds')),
    );
  }
  if (r?.status === 'error' && current) {
    return h(
      'div',
      { class: 'render-frame error', role: 'alert' },
      h('img', { class: 'render-img mannequin', src: MANNEQUIN, alt: '' }),
      h('div', { class: 'frame-overlay' }, h('p', {}, r.error ?? 'Something went wrong.'), h('button', { type: 'button', class: 'text-button', onclick: a.seeTogether }, 'Try again')),
    );
  }
  if (r?.status === 'done' && r.imageUrl && current) {
    markRevealed(r.imageUrl);
    return h(
      'div',
      { class: 'render-frame done' },
      h('img', { class: revealed.has(r.imageUrl) ? 'render-img' : 'render-img reveal', src: r.imageUrl, alt: 'The pieces together on a mannequin' }),
    );
  }
  return h(
    'div',
    { class: 'render-frame idle' },
    h('img', { class: 'render-img mannequin', src: MANNEQUIN, alt: '' }),
    worn.length === 0 && h('p', { class: 'frame-hint small' }, 'Pick pieces below'),
  );
}

// The boxes beside the mannequin, head to toe. A dress takes the top and
// bottom boxes together. Tapping a box shows that kind below.
function slotBox(s: ViewState, a: Actions, kind: Category, label: string, tall = false): HTMLElement {
  const g = s.outfit[kind] ? s.byId.get(s.outfit[kind]!) : undefined;
  return h(
    'div',
    { class: `slot${g ? ' filled' : ''}${g?.location === 'fittingRoom' ? ' store' : ''}${tall ? ' tall' : ''}` },
    h(
      'button',
      { type: 'button', class: 'slot-main', 'aria-label': g ? `${label}: ${name(g)}` : `Choose ${label.toLowerCase()}`, title: g ? name(g) : label, onclick: () => a.filter(kind) },
      g ? img(thumbSrc(g), 'slot-img', name(g)) : h('span', { class: 'slot-label' }, label),
    ),
    g && h('button', { type: 'button', class: 'slot-off', 'aria-label': `Take off ${name(g)}`, title: 'Take off', onclick: () => a.takeOff(g) }, '×'),
  );
}

function slots(s: ViewState, a: Actions): HTMLElement {
  return h(
    'div',
    { class: 'slots' },
    slotBox(s, a, 'outerwear', 'Outer'),
    ...(s.outfit.dress ? [slotBox(s, a, 'dress', 'Dress', true)] : [slotBox(s, a, 'top', 'Top'), slotBox(s, a, 'bottom', 'Bottom')]),
    slotBox(s, a, 'shoes', 'Shoes'),
  );
}

// The look, always at the top: mannequin + boxes, then one row of actions.
function lookSection(s: ViewState, a: Actions, worn: Garment[]): HTMLElement {
  const shown = s.render?.key === s.lookKey && !s.cleared;
  const rendered = shown && s.render?.status === 'done';
  const running = shown && s.render?.status === 'running';
  const saved = s.savedLooks.some((l) => l.key === s.lookKey);
  return h(
    'section',
    { class: 'look', 'aria-label': 'Your Look' },
    h('div', { class: 'look-head' }, h('h2', { class: 'label' }, 'Your Look')),
    h('div', { class: 'look-stage' }, lookFrame(s, a, worn), slots(s, a)),
    rendered
      ? h(
          'div',
          { class: 'result-row' },
          h('button', { type: 'button', class: 'btn btn-primary', 'aria-pressed': saved, onclick: a.toggleSave }, saved ? '♥ Saved' : '♡ Save this look'),
          h('button', { type: 'button', class: 'btn btn-secondary', onclick: a.tryAnother }, 'Try another'),
        )
      : !running && h('button', { type: 'button', class: 'btn btn-primary btn-block cta', disabled: worn.length === 0, onclick: a.seeTogether }, 'See them together'),
  );
}

// Under "All", what goes with the store piece in the look comes first, most
// recently used first. The order doesn't change while you pick (recency only
// moves when you see a look), so tiles never jump.
const GOES_WITH: Record<Category, Category[]> = {
  top: ['bottom', 'outerwear', 'shoes'],
  bottom: ['top', 'outerwear', 'shoes'],
  outerwear: ['top', 'bottom', 'dress', 'shoes'],
  dress: ['outerwear', 'shoes'],
  shoes: ['top', 'bottom', 'dress', 'outerwear'],
};

export function pieceOrder(pieces: Garment[], store: Garment | undefined): Garment[] {
  const kinds = store ? [...GOES_WITH[store.category], store.category] : LOOK_ORDER;
  const rank = (g: Garment) => (kinds.includes(g.category) ? kinds.indexOf(g.category) : kinds.length);
  const recent = (g: Garment) => g.lastUsedAt ?? g.createdAt;
  return [...pieces].sort((x, y) => rank(x) - rank(y) || recent(y) - recent(x));
}

// The main page (D26, revised): Your Look on top, then every piece, store and
// owned together, under All · Top · Bottom … A new capture lands in its kind.
export function lookView(s: ViewState, a: Actions): HTMLElement {
  const worn = wornPieces(s);
  const pieces = s.garments.filter((g) => g.decision !== 'pass');
  const shown = pieceOrder(pieces, candidateOf(s)).filter((g) => s.filter === 'all' || g.category === s.filter);
  const hasCloset = pieces.some((g) => g.location === 'closet');
  return h(
    'div',
    { class: 'main-page' },
    lookSection(s, a, worn),
    !pieces.length && !s.draft && h('div', { class: 'empty-look' }, h('p', { class: 'question' }, 'Found something you like?'), h('p', { class: 'muted' }, STORE_HINT)),
    pieces.length > 0 &&
      h(
        'section',
        { class: 'pieces', 'aria-label': 'Your pieces' },
        s.phone && phoneCard(s.phone, a),
        filters(s, a, pieces),
        s.typeFor && pieces.some((g) => g.id === s.typeFor) && typeEditor(s.byId.get(s.typeFor)!, a),
        shown.length
          ? h('div', { class: 'grid' }, ...shown.map((g) => tile(s, g, a, { onclick: () => a.pick(g), selected: inLook(s, g), menu: true })))
          : h('p', { class: 'muted small' }, 'Nothing here yet.'),
      ),
    !hasCloset && closetEmpty(s, a),
  );
}

// ---- Fitting Room ----------------------------------------------------------------

export function fittingRoomView(s: ViewState, a: Actions): HTMLElement {
  const pieces = s.garments.filter((g) => g.location === 'fittingRoom' && g.decision !== 'pass').sort((x, y) => y.createdAt - x.createdAt);
  const looks = [...s.savedLooks].sort((x, y) => y.createdAt - x.createdAt);
  return h(
    'section',
    { class: 'page' },
    h('h2', { class: 'page-title' }, 'Fitting Room'),
    h('p', { class: 'muted small' }, pieces.length === 1 ? '1 piece you’re considering' : `${pieces.length} pieces you’re considering`),
    looks.length > 0 &&
      h(
        'div',
        { class: 'saved' },
        h('div', { class: 'section-head' }, h('span', { class: 'label' }, 'Saved looks')),
        h(
          'div',
          { class: 'saved-strip' },
          ...looks.map((l) => h('button', { type: 'button', class: 'saved-look', 'aria-label': 'Open saved look', onclick: () => a.openSavedLook(l) }, img(imageUrl(l.key), 'saved-img'))),
        ),
      ),
    s.typeFor && pieces.some((g) => g.id === s.typeFor) && typeEditor(s.byId.get(s.typeFor)!, a),
    pieces.length
      ? h('div', { class: 'grid' }, ...pieces.map((g) => tile(s, g, a, { onclick: () => a.consider(g), selected: false, menu: true })))
      : h('div', { class: 'empty' }, h('p', {}, 'Nothing here yet.'), h('p', { class: 'muted small' }, STORE_HINT)),
  );
}

// ---- My Closet ---------------------------------------------------------------------

// All 9 · Top 5 · Bottom 3 … (only kinds you have).
function filters(s: ViewState, a: Actions, items: Garment[]): HTMLElement {
  const count = (c: Category) => items.filter((g) => g.category === c).length;
  return h(
    'div',
    { class: 'chips' },
    h('button', { type: 'button', class: 'chip', 'aria-pressed': s.filter === 'all', onclick: () => a.filter('all') }, `All ${items.length}`),
    ...CATEGORIES.filter((c) => count(c) > 0).map((c) =>
      h('button', { type: 'button', class: 'chip', 'aria-pressed': s.filter === c, onclick: () => a.filter(c) }, `${CATEGORY_LABEL[c]} ${count(c)}`),
    ),
  );
}

function closetEmpty(s: ViewState, a: Actions): HTMLElement {
  return s.phone
    ? phoneCard(s.phone, a)
    : h(
        'div',
        { class: 'empty closet-empty' },
        h('p', {}, 'Add a few pieces you actually wear.'),
        h('p', { class: 'muted small' }, 'You don’t need your whole wardrobe to get started.'),
        h('div', { class: 'add-actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: a.usePhone }, 'Use your phone'), h('label', { class: 'text-button small', for: 'upload-input' }, 'Upload from this device')),
      );
}

export function closetView(s: ViewState, a: Actions): HTMLElement {
  const items = s.garments.filter((g) => g.location === 'closet');
  const shown = items.filter((g) => s.filter === 'all' || g.category === s.filter).sort((x, y) => y.createdAt - x.createdAt);
  return h(
    'section',
    { class: 'page' },
    h('div', { class: 'page-head' }, h('h2', { class: 'page-title' }, 'My Closet'), items.length > 0 && !s.phone && h('div', { class: 'add-actions' }, h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: a.usePhone }, 'Use your phone'), h('label', { class: 'text-button small', for: 'upload-input' }, 'Upload'))),
    ...(items.length === 0
      ? [closetEmpty(s, a)]
      : [
          s.phone && phoneCard(s.phone, a),
          filters(s, a, items),
          s.typeFor && items.some((g) => g.id === s.typeFor) && typeEditor(s.byId.get(s.typeFor)!, a),
          h('div', { class: 'grid' }, ...shown.map((g) => tile(s, g, a, { onclick: () => a.pick(g), selected: inLook(s, g), menu: true }))),
        ]),
  );
}

// ---- Use your phone -----------------------------------------------------------------

function phoneCard(p: PhoneSession, a: Actions): HTMLElement {
  const added = p.added > 0 && h('p', { class: 'phone-added' }, `✓ ${p.added} new ${p.added === 1 ? 'piece' : 'pieces'} added`);
  const actions = (...children: (HTMLElement | false)[]) => h('div', { class: 'phone-actions' }, ...children);
  if (p.status === 'error') {
    return h(
      'div',
      { class: 'phone-card', role: 'alert' },
      h('p', { class: 'phone-title' }, "Couldn't connect to your phone"),
      h('p', { class: 'muted small' }, p.error ?? 'Please try again.'),
      actions(h('button', { type: 'button', class: 'btn btn-secondary', onclick: a.usePhone }, 'Try again'), h('button', { type: 'button', class: 'text-button small', onclick: a.closePhone }, 'Close')),
    );
  }
  if (p.status === 'expired') {
    return h(
      'div',
      { class: 'phone-card' },
      h('p', { class: 'phone-title' }, 'This code has expired'),
      added,
      actions(h('button', { type: 'button', class: 'btn btn-secondary', onclick: a.usePhone }, 'Show a new code'), h('button', { type: 'button', class: 'text-button small', onclick: a.closePhone }, 'Done')),
    );
  }
  const minutes = Math.max(1, Math.ceil((p.expiresAt - Date.now()) / 60_000));
  const qr = h('div', { class: 'qr', role: 'img', 'aria-label': 'QR code for adding clothes from your phone' });
  qr.innerHTML = qrSvg(p.url); // SVG generated locally from our own URL
  return h(
    'div',
    { class: 'phone-card' },
    h('p', { class: 'phone-title' }, 'Add clothes from your phone'),
    h('p', { class: 'small' }, 'Scan the code, take or choose a photo, and it’ll appear here.'),
    qr,
    h('p', { class: 'muted small' }, 'One piece per photo works best. No account needed.'),
    added || h('p', { class: 'phone-waiting small' }, 'Waiting for photos…'),
    actions(h('span', { class: 'muted small' }, `Code expires in ${minutes} min`), h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: a.closePhone }, 'Done')),
  );
}

// ---- Header -------------------------------------------------------------------------

export function headerView(s: ViewState, a: Actions): HTMLElement {
  const considering = s.garments.filter((g) => g.location === 'fittingRoom' && g.decision !== 'pass').length;
  const nav = (v: View, label: string, count?: number) =>
    h('button', { type: 'button', class: 'nav', 'aria-current': s.view === v ? 'page' : undefined, onclick: () => a.setView(v) }, label, count ? h('span', { class: 'nav-count' }, String(count)) : null);
  return h(
    'header',
    { class: 'app-header' },
    h('button', { type: 'button', class: 'brand', onclick: () => a.setView('look') }, 'Cabine'),
    h('nav', {}, nav('fittingRoom', 'Fitting Room', considering), nav('closet', 'My Closet')),
  );
}
