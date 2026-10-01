import { CATEGORIES, CATEGORY_LABEL, type Category, type Draft, type Garment, type Location, type Outfit } from '../shared/types';
import { h } from './dom';
import { imageUrl } from './image-urls';
import { qrSvg, type PhoneSession } from './phone';

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
  confirmBuy: string | null; // garment whose "Add to My Closet?" confirmation is showing
  justAdded: string | null; // garment that just moved to My Closet, confirmed for a few seconds
  phone: PhoneSession | null; // an open "Use your phone" QR session
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
  decide(g: Garment, decision: 'buy' | 'save' | 'pass'): void;
  askBuy(id: string | null): void;
  openOriginal(g: Garment): void;
  cleanUp(g: Garment): void;
  useOriginal(g: Garment): void;
  usePhone(): void;
  closePhone(): void;
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

function renderArea(s: ViewState, a: Actions, worn: Garment[]): HTMLElement | null {
  const r = s.render;
  if (!r) return null;
  const current = r.key === s.lookKey;
  if (r.status === 'running' && current) {
    return h(
      'div',
      { class: 'render-frame running', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'running-pieces', 'aria-hidden': 'true' }, ...worn.map((g) => img(thumbSrc(g), 'running-thumb'))),
      h('span', { class: 'spinner', 'aria-hidden': 'true' }),
      h('p', { class: 'progress-title' }, 'Styling your look…'),
      h('p', { class: 'muted small' }, r.cached ? 'Almost there' : 'Usually takes about 15 seconds'),
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
      !current && h('span', { class: 'outdated-badge' }, 'Outfit changed'),
    );
  }
  return null;
}

// After seeing the look: what about each piece you're considering? (Buy moves it
// to My Closet, Save keeps it in the Fitting Room, Pass puts it away.)
function decisionView(s: ViewState, a: Actions, trying: Garment[]): HTMLElement | null {
  if (!trying.length) return null;
  return h(
    'div',
    { class: 'decision' },
    h('p', { class: 'decision-q' }, 'What are you thinking?'),
    ...trying.map((g) =>
      s.confirmBuy === g.id
        ? h(
            'div',
            { class: 'decision-row confirm' },
            h('span', { class: 'decision-name' }, `Add "${name(g)}" to My Closet?`),
            h('button', { type: 'button', class: 'chip strong', onclick: () => a.decide(g, 'buy') }, 'Add'),
            h('button', { type: 'button', class: 'link small', onclick: () => a.askBuy(null) }, 'Cancel'),
          )
        : h(
            'div',
            { class: 'decision-row' },
            trying.length > 1 && h('span', { class: 'decision-name' }, name(g)),
            h('button', { type: 'button', class: 'chip', onclick: () => a.askBuy(g.id) }, 'Buy'),
            h('button', { type: 'button', class: 'chip', 'aria-pressed': g.decision === 'save', onclick: () => a.decide(g, 'save') }, g.decision === 'save' ? 'Saved' : 'Save'),
            h('button', { type: 'button', class: 'chip', onclick: () => a.decide(g, 'pass') }, 'Pass'),
          ),
    ),
  );
}

// Buying moves a piece out of "Trying" and into My Closet; say so, or the move goes unnoticed.
function addedNotice(s: ViewState): HTMLElement | null {
  const g = s.justAdded ? s.byId.get(s.justAdded) : undefined;
  if (!g || g.location !== 'closet') return null;
  return h('p', { class: 'added-notice', role: 'status' }, `✓ Added "${name(g)}" to My Closet`);
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
  const rendered = s.render?.key === s.lookKey && s.render.status === 'done';
  const hasOldRender = !!s.render?.imageUrl && !upToDate;

  const group = (label: string, items: Garment[], cls: string) =>
    items.length ? h('div', { class: `group ${cls}` }, h('h3', {}, label), h('ul', { class: 'pieces' }, ...items.map((g) => pieceView(g, a)))) : null;

  return h(
    'section',
    { class: 'look', 'aria-label': 'Your look' },
    h('h2', {}, 'Your look'),
    worn.length > 0 && renderArea(s, a, worn),
    rendered && decisionView(s, a, trying),
    addedNotice(s),
    worn.length === 0 &&
      (s.garments.length === 0
        ? h(
            'ol',
            { class: 'first-run' },
            h('li', {}, 'Add a few clothes you own to My Closet, from your phone or this computer.'),
            h('li', {}, 'On any store, right-click a product image and choose "Try in Cabine".'),
            h('li', {}, 'Pick pieces and tap "See the outfit" to see them together.'),
          )
        : h('p', { class: 'muted' }, 'Pick pieces from your Fitting Room or My Closet to see them together.')),
    group('Trying', trying, 'trying'),
    group(trying.length ? 'With my closet' : 'From my closet', owned, 'owned'),
    h(
      'div',
      { class: 'adders' },
      ...adders(s.outfit).map(({ label, slot }) =>
        h('button', { type: 'button', class: label.startsWith('+') ? 'adder' : 'link small', 'aria-pressed': s.choosing === slot, onclick: () => a.choose(slot) }, label),
      ),
    ),
    worn.length > 0 && !upToDate && h('button', { type: 'button', class: 'primary', onclick: a.seeOutfit }, hasOldRender ? 'Update outfit' : 'See the outfit'),
  );
}

// ---- Drawers: Fitting Room · My Closet ----------------------------------------------

function itemMenu(s: ViewState, g: Garment, a: Actions): HTMLElement {
  const worn = s.outfit[g.category] === g.id;
  return h(
    'div',
    { class: 'item-menu', role: 'menu' },
    h('button', { type: 'button', role: 'menuitem', onclick: () => a.pick(g) }, worn ? 'Take off' : 'Add to look'),
    g.sourcePageUrl && h('button', { type: 'button', role: 'menuitem', onclick: () => a.openOriginal(g) }, 'Open original page'),
    g.location === 'fittingRoom' &&
      h('button', { type: 'button', role: 'menuitem', onclick: () => a.addToCloset(g) }, 'Add to My Closet'),
    g.location === 'closet' &&
      g.cleanStatus !== 'pending' &&
      h('button', { type: 'button', role: 'menuitem', onclick: () => a.cleanUp(g) }, g.cleanImageId ? 'Clean up again' : 'Clean up photo'),
    g.location === 'closet' &&
      g.cleanImageId &&
      h('button', { type: 'button', role: 'menuitem', onclick: () => a.useOriginal(g) }, 'Use original photo'),
    h('button', { type: 'button', role: 'menuitem', class: 'danger', onclick: () => a.removeGarment(g) }, 'Remove'),
  );
}

// ---- Adding your own clothes (My Closet) -----------------------------------------------

function addClothesView(a: Actions): HTMLElement {
  return h(
    'div',
    { class: 'add-clothes' },
    h('span', { class: 'add-label' }, 'Add clothes'),
    h('label', { class: 'button', for: 'upload-input' }, 'Upload from this device'),
    h('button', { type: 'button', class: 'button', onclick: a.usePhone }, 'Use your phone'),
  );
}

function phoneView(p: PhoneSession, a: Actions): HTMLElement {
  const added = p.added > 0 && h('p', { class: 'phone-added' }, `✓ ${p.added} new ${p.added === 1 ? 'piece' : 'pieces'} added`);
  if (p.status === 'error') {
    return h(
      'div',
      { class: 'phone-card', role: 'alert' },
      h('p', { class: 'phone-title' }, "Couldn't start a phone session"),
      h('p', { class: 'muted small' }, p.error ?? 'Please try again.'),
      h('div', { class: 'phone-actions' }, h('button', { type: 'button', class: 'button', onclick: a.usePhone }, 'Try again'), h('button', { type: 'button', class: 'link small', onclick: a.closePhone }, 'Close')),
    );
  }
  if (p.status === 'expired') {
    return h(
      'div',
      { class: 'phone-card' },
      h('p', { class: 'phone-title' }, 'This QR code expired'),
      added,
      h('div', { class: 'phone-actions' }, h('button', { type: 'button', class: 'button', onclick: a.usePhone }, 'Make a new QR code'), h('button', { type: 'button', class: 'link small', onclick: a.closePhone }, 'Done')),
    );
  }
  const minutes = Math.max(1, Math.ceil((p.expiresAt - Date.now()) / 60_000));
  const qr = h('div', { class: 'qr', role: 'img', 'aria-label': 'QR code for adding clothes from your phone' });
  qr.innerHTML = qrSvg(p.url); // SVG generated locally from our own URL
  return h(
    'div',
    { class: 'phone-card' },
    h('p', { class: 'phone-title' }, 'Scan to add clothes from your closet'),
    qr,
    h('p', { class: 'muted small' }, 'Scan with your phone and add a few pieces you wear often.'),
    added || h('p', { class: 'phone-waiting' }, 'Waiting for photos…'),
    h('div', { class: 'phone-actions' }, h('span', { class: 'muted small' }, `Expires in ${minutes} min`), h('button', { type: 'button', class: 'button', onclick: a.closePhone }, 'Done')),
  );
}

export function drawersView(s: ViewState, a: Actions): HTMLElement {
  const inDrawer = s.garments.filter((g) => g.location === s.drawer && g.decision !== 'pass');
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
        h('span', { class: 'tab-count' }, String(s.garments.filter((g) => g.location === d && g.decision !== 'pass').length)),
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
              g.location === 'fittingRoom' && g.decision === 'save' && h('span', { class: 'item-badge' }, 'Saved'),
              g.location === 'closet' && s.justAdded === g.id && !g.cleanStatus && h('span', { class: 'item-badge' }, 'Just added'),
              g.location === 'closet' && g.cleanStatus === 'pending' && h('span', { class: 'item-badge' }, 'Cleaning up…'),
              g.location === 'closet' && g.cleanStatus === 'failed' && h('span', { class: 'item-badge failed' }, "Couldn't clean up"),
            ),
            h(
              'button',
              { type: 'button', class: 'item-more', 'aria-label': `More for ${name(g)}`, 'aria-expanded': s.menuFor === g.id, onclick: () => a.toggleMenu(s.menuFor === g.id ? null : g.id) },
              '⋯',
            ),
            s.menuFor === g.id && itemMenu(s, g, a),
          ),
        ),
      )
    : h('p', { class: 'muted' }, empty());

  const adding = s.drawer === 'closet' && !s.choosing && (s.phone ? phoneView(s.phone, a) : addClothesView(a));
  return h('section', { class: 'drawers', id: 'drawers', 'aria-label': 'Your pieces' }, tabs, adding, choosing, filters, grid);
}
