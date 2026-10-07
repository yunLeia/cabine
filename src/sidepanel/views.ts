import { CATEGORIES, CATEGORY_LABEL, isSaved, type Category, type Draft, type Garment, type Outfit, type SavedLook } from '../shared/types';
import { productName } from '../shared/infer';
import { h } from './dom';
import { icon } from './icons';
import { account, authAvailable } from './auth';
import { imageUrl } from './image-urls';
import { qrSvg, type PhoneSession } from './phone';

// The panel (D29):
//   Your Look (main) = the mannequin with what you picked, then the pieces to
//                      pick from: In Fitting Room (store) and My Closet (yours)
//   In Cabine        = the same two groups, to manage (menus, filters, upload)
//   Saved Looks      = looks you kept
// Sections say where a piece comes from; no source badges. Categories, slots
// and the dress rule stay internal.

export type View = 'look' | 'cabine' | 'saved';

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
  uploadOpen: boolean; // the Upload button's "phone or this computer?" menu
  savedEdit: boolean; // Saved Looks in edit mode (delete buttons showing)
  accountOpen: boolean; // the account menu in the header
}

export interface Actions {
  saveDraft(category: Category): void;
  discardDraft(): void;
  pick(g: Garment): void; // put on / take off, in the current look
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
  toggleUpload(open: boolean): void;
  toggleSavedEdit(on: boolean): void;
  signIn(): void;
  signOut(): void;
  toggleAccount(open: boolean): void;
  deleteSavedLook(l: SavedLook): void;
  chooseFile(): void;
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

// The newest store piece in the look (only used to order closet suggestions).
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

// While a piece's photo is being cleaned up: the Cabine C drawing itself into
// the hanger, the same mark as "Putting it together…" (scripts/brand-loading.py).
function cleaningOverlay(): HTMLElement {
  return h('span', { class: 'cleaning', role: 'status' }, h('img', { class: 'cleaning-mark', src: '/brand/loading.webp', alt: '' }), h('span', { class: 'cleaning-text' }, 'Cleaning up'));
}

function tile(s: ViewState, g: Garment, a: Actions, opts: { onclick?: () => void; selected?: boolean; disabled?: string; menu?: boolean; below?: HTMLElement }): HTMLElement {
  return h(
    'div',
    { class: 'tile-wrap' },
    h(
      'button',
      {
        type: 'button',
        class: opts.onclick ? 'tile' : 'tile static',
        title: opts.disabled ?? name(g),
        'aria-pressed': opts.onclick ? !!opts.selected : undefined,
        disabled: !!opts.disabled,
        onclick: opts.onclick ?? (() => a.toggleMenu(s.menuFor === g.id ? null : g.id)),
      },
      img(thumbSrc(g), 'tile-img', name(g)),
      h('span', { class: 'tile-check', 'aria-hidden': 'true' }, icon('check')),
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
    opts.below,
  );
}

function itemMenu(s: ViewState, g: Garment, a: Actions): HTMLElement {
  const store = g.location === 'fittingRoom';
  const item = (label: string, onclick: () => void, cls?: string) => h('button', { type: 'button', role: 'menuitem', class: cls, onclick }, label);
  return h(
    'div',
    { class: 'menu', role: 'menu' },
    store && g.sourcePageUrl && item('Open original page ↗', () => a.openOriginal(g, 'menu')),
    item('Edit category', () => a.editType(g.id)),
    store && item('I got this — move to My Closet', () => a.addToCloset(g)),
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
      h('label', { class: 'btn btn-utility', for: 'upload-input' }, 'Upload a screenshot', icon('plus')),
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
      // The C draws itself into the hanger while we wait (scripts/brand-loading.py).
      h('div', { class: 'frame-overlay' }, h('img', { class: 'loading-mark', src: '/brand/loading.webp', alt: '' }), h('p', { class: 'running-title' }, 'Putting it together…'), h('p', { class: 'muted small' }, r.cached ? 'Almost there' : 'About 15 seconds')),
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
    worn.length === 0 && h('p', { class: 'frame-hint small' }, 'Your look shows here'),
  );
}

// The pieces you picked, stacked down the right of the mannequin, head to toe.
// Only what's chosen: no empty boxes asking to be filled. × takes one off.
// The column is always there, so the mannequin doesn't jump when the first
// piece arrives.
// The panel is redrawn on every change (a filter, a menu…); only a piece that
// just joined the look plays the drop-in animation, so nothing else seems to reload.
const placed = new Set<string>();
function picked(s: ViewState, a: Actions, worn: Garment[]): HTMLElement {
  const fresh = new Set(worn.filter((g) => !placed.has(g.id)).map((g) => g.id));
  placed.clear();
  worn.forEach((g) => placed.add(g.id));
  return h(
    'ul',
    { class: 'picked' },
    ...worn.map((g) =>
      h(
        'li',
        { class: fresh.has(g.id) ? 'picked-piece new' : 'picked-piece' },
        h('span', { class: 'picked-main', title: name(g) }, img(thumbSrc(g), 'picked-img', name(g))),
        h('button', { type: 'button', class: 'picked-off', 'aria-label': `Take off ${name(g)}`, title: 'Take off', onclick: () => a.takeOff(g) }, '×'),
      ),
    ),
  );
}

// The main page: the look (mannequin + picked pieces), then what you can pick
// from, kept apart: store pieces in the Fitting Room, then your own clothes.
export function lookView(s: ViewState, a: Actions): HTMLElement {
  const worn = wornPieces(s);
  const shown = s.render?.key === s.lookKey && !s.cleared;
  const rendered = shown && s.render?.status === 'done';
  const running = shown && s.render?.status === 'running';
  const saved = s.savedLooks.some((l) => l.key === s.lookKey && isSaved(l));
  return h(
    'div',
    { class: 'main-page' },
    h(
      'section',
      { class: 'look', 'aria-label': 'Your Look' },
      h('h2', { class: 'label look-title' }, 'Your Look'),
      h('div', { class: 'look-stage' }, lookFrame(s, a, worn), picked(s, a, worn)),
      rendered
        ? h(
            'div',
            { class: 'result-row' },
            h('button', { type: 'button', class: 'btn btn-primary', 'aria-pressed': saved, onclick: a.toggleSave }, icon(saved ? 'heartFilled' : 'heart'), saved ? 'Saved' : 'Save this look'),
            h('button', { type: 'button', class: 'btn btn-secondary', onclick: a.tryAnother }, icon('refresh'), 'Try another'),
          )
        : !running && h('button', { type: 'button', class: 'btn btn-primary btn-block cta', disabled: worn.length === 0, onclick: a.seeTogether }, 'See them together', icon('arrow')),
    ),
    lookPickers(s, a),
  );
}

// Everything below the look: the filter row, In Fitting Room and My Closet.
// A filter click redraws only this part (main.ts), so the look above it stays put.
export function lookPickers(s: ViewState, a: Actions): HTMLElement {
  const store = s.garments.filter((g) => g.location === 'fittingRoom' && g.decision !== 'pass').sort((x, y) => y.createdAt - x.createdAt);
  const closet = s.garments.filter((g) => g.location === 'closet');
  // One filter row for both groups (as in In Cabine); every piece of the chosen kind shows.
  const kind = (g: Garment) => s.filter === 'all' || g.category === s.filter;
  const storeShown = store.filter(kind);
  const mine = closet.filter(kind).sort((x, y) => y.createdAt - x.createdAt);
  const none = h('p', { class: 'muted small' }, 'Nothing of this kind.');
  const pick = (g: Garment) => tile(s, g, a, { onclick: () => a.pick(g), selected: inLook(s, g) });
  return h(
    'div',
    { id: 'pickers' },
    store.length + closet.length > 0 && h('div', { class: 'main-filters' }, filters(s, a, [...store, ...closet])),
    h(
      'section',
      { class: 'pick-section', 'aria-label': 'In Fitting Room' },
      h('div', { class: 'section-head' }, h('span', { class: 'label' }, 'In Fitting Room')),
      store.length ? (storeShown.length ? h('div', { class: 'grid' }, ...storeShown.map(pick)) : none) : h('p', { class: 'muted small' }, STORE_HINT),
    ),
    h(
      'section',
      { class: 'pick-section', 'aria-label': 'My Closet' },
      h('div', { class: 'section-head' }, h('span', { class: 'label' }, 'My Closet')),
      ...(closet.length
        ? [s.phone && phoneCard(s.phone, a), mine.length ? h('div', { class: 'grid' }, ...mine.map(pick)) : none]
        : [closetEmpty(s, a)]),
    ),
  );
}

// ---- In Cabine: everything you've brought in, store pieces and your own --------------

export function cabineView(s: ViewState, a: Actions): HTMLElement {
  // A list of everything you've brought in. One filter row on top applies to
  // both groups; tapping a piece opens its menu (it doesn't change your look).
  const kind = (g: Garment) => s.filter === 'all' || g.category === s.filter;
  const store = s.garments.filter((g) => g.location === 'fittingRoom' && g.decision !== 'pass').sort((x, y) => y.createdAt - x.createdAt);
  const items = s.garments.filter((g) => g.location === 'closet').sort((x, y) => y.createdAt - x.createdAt);
  const piece = (g: Garment) => tile(s, g, a, { menu: true });
  const none = h('p', { class: 'muted small' }, 'Nothing of this kind.');
  return h(
    'section',
    { class: 'page' },
    // No page title: the tab above already says where you are. Filters and
    // Upload share the top row; Upload is the page's main action.
    h('div', { class: 'toolbar' }, store.length + items.length > 0 ? filters(s, a, [...store, ...items]) : h('span', {}), !s.phone && uploadButton(s, a, 'btn-primary')),
    s.phone && phoneCard(s.phone, a),
    s.typeFor && typeEditor(s.byId.get(s.typeFor)!, a),
    h(
      'div',
      { class: 'page-section' },
      h('div', { class: 'section-head' }, h('span', { class: 'label' }, 'In Fitting Room'), h('span', { class: 'muted small' }, store.length === 1 ? '1 piece you’re considering' : `${store.length} pieces you’re considering`)),
      store.length ? (store.some(kind) ? h('div', { class: 'grid' }, ...store.filter(kind).map(piece)) : none) : h('p', { class: 'muted small' }, STORE_HINT),
    ),
    h(
      'div',
      { class: 'page-section' },
      h('div', { class: 'section-head' }, h('span', { class: 'label' }, 'My Closet'), items.length > 0 && h('span', { class: 'muted small' }, items.length === 1 ? '1 piece' : `${items.length} pieces`)),
      items.length ? (items.some(kind) ? h('div', { class: 'grid' }, ...items.filter(kind).map(piece)) : none) : !s.phone && closetEmpty(s, a),
    ),
  );
}

// ---- Saved Looks -------------------------------------------------------------------

export function savedView(s: ViewState, a: Actions): HTMLElement {
  const looks = s.savedLooks.filter(isSaved).filter((l) => imageUrl(l.key)).sort((x, y) => y.createdAt - x.createdAt);
  return h(
    'section',
    { class: `page${s.savedEdit ? ' editing' : ''}` },
    // "Edit" (same style as Upload) shows a delete button on every look; "Done" ends it.
    looks.length > 0 &&
      h(
        'div',
        { class: 'page-head' },
        h('span', { class: 'muted small' }, looks.length === 1 ? '1 look' : `${looks.length} looks`),
        h('button', { type: 'button', class: 'btn btn-utility btn-small', 'aria-pressed': s.savedEdit, onclick: () => a.toggleSavedEdit(!s.savedEdit) }, s.savedEdit ? 'Done' : 'Edit', !s.savedEdit && icon('pencil')),
      ),
    looks.length
      ? h(
          'div',
          { class: 'looks-grid' },
          ...looks.map((l) =>
            h(
              'div',
              { class: 'saved-wrap' },
              h('button', { type: 'button', class: 'saved-look', 'aria-label': 'Open this look', disabled: s.savedEdit, onclick: () => a.openSavedLook(l) }, img(imageUrl(l.key), 'saved-img')),
              s.savedEdit && h('button', { type: 'button', class: 'saved-delete', 'aria-label': 'Delete this look', title: 'Delete', onclick: () => a.deleteSavedLook(l) }, '×'),
            ),
          ),
        )
      : h('div', { class: 'empty' }, h('p', {}, 'No saved looks yet.'), h('p', { class: 'muted small' }, 'After you see a look, tap “♡ Save this look” to keep it here.')),
  );
}

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

// "Upload": one button that asks where the photos are, your phone (QR) or this computer.
function uploadButton(s: ViewState, a: Actions, kind = 'btn-utility'): HTMLElement {
  return h(
    'div',
    { class: 'upload-wrap' },
    h('button', { type: 'button', class: `btn ${kind}`, 'aria-expanded': s.uploadOpen, onclick: () => a.toggleUpload(!s.uploadOpen) }, 'Upload', icon('plus')),
    s.uploadOpen &&
      h(
        'div',
        { class: 'menu upload-menu', role: 'menu' },
        h('button', { type: 'button', role: 'menuitem', onclick: a.usePhone }, icon('phone'), 'From your phone'),
        h('button', { type: 'button', role: 'menuitem', onclick: a.chooseFile }, icon('plus'), 'From this computer'),
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
        h('div', { class: 'add-actions' }, uploadButton(s, a)),
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
      actions(h('button', { type: 'button', class: 'btn btn-secondary', onclick: a.usePhone }, icon('refresh'), 'Try again'), h('button', { type: 'button', class: 'text-button small', onclick: a.closePhone }, 'Close')),
    );
  }
  if (p.status === 'expired') {
    return h(
      'div',
      { class: 'phone-card' },
      h('p', { class: 'phone-title' }, 'This code has expired'),
      added,
      actions(h('button', { type: 'button', class: 'btn btn-secondary', onclick: a.usePhone }, icon('refresh'), 'Show a new code'), h('button', { type: 'button', class: 'text-button small', onclick: a.closePhone }, 'Done')),
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
  const nav = (v: View, label: string) => h('button', { type: 'button', class: 'nav', 'aria-current': s.view === v ? 'page' : undefined, onclick: () => a.setView(v) }, label);
  // The wordmark is the way home (Your Look); it gets the same gradient underline as the tabs.
  const home = h(
    'button',
    { type: 'button', class: 'nav brand', 'aria-label': 'Your Look', 'aria-current': s.view === 'look' ? 'page' : undefined, onclick: () => a.setView('look') },
    h('img', { class: 'brand-mark', src: '/brand/wordmark.png', alt: 'Cabine' }),
  );
  return h('header', { class: 'app-header' }, home, h('div', { class: 'header-right' }, h('nav', {}, nav('saved', 'Saved Looks'), nav('cabine', 'In Cabine')), accountButton(s, a)));
}

// Optional sign-in (D32): "Sign in" when signed out; your initial, with a small
// menu (email, Sign out), when signed in.
function accountButton(s: ViewState, a: Actions): HTMLElement | null {
  if (!authAvailable()) return null;
  const me = account();
  if (!me) return h('button', { type: 'button', class: 'nav sign-in', onclick: a.signIn }, 'Sign in');
  return h(
    'div',
    { class: 'account-wrap' },
    h('button', { type: 'button', class: 'avatar', 'aria-label': `Account: ${me.email}`, 'aria-expanded': s.accountOpen, title: me.email, onclick: () => a.toggleAccount(!s.accountOpen) }, me.initial),
    s.accountOpen &&
      h(
        'div',
        { class: 'menu account-menu', role: 'menu' },
        h('p', { class: 'account-email small muted' }, me.email),
        h('button', { type: 'button', role: 'menuitem', onclick: a.signOut }, 'Sign out'),
      ),
  );
}
