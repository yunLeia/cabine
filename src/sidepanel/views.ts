import { CATEGORIES, CATEGORY_LABEL, type Category, type Draft, type Garment, type Outfit } from '../shared/types';
import { h } from './dom';
import { imageUrl } from './image-urls';

export interface RenderState {
  key: string; // which look this is (render.ts lookKey)
  garments: Garment[]; // the pieces, in layering order, as they were when requested
  status: 'running' | 'done' | 'error';
  cached?: boolean; // the server already had this look: it'll be back in a moment
  imageUrl?: string;
  error?: string;
}

export interface ViewState {
  garments: Garment[];
  byId: Map<string, Garment>;
  outfit: Outfit;
  draft: Draft | null;
  filter: Category | 'all';
  choosing: Category | null; // the slot the user is picking a garment for
  view: 'build' | 'result';
  result: RenderState | null;
}

export interface Actions {
  saveDraft(category: Category): void;
  discardDraft(): void;
  pick(g: Garment): void;
  remove(category: Category): void;
  choose(slot: Category): void; // show only that category in the closet, then pick
  cancelChoose(): void;
  filter(filter: Category | 'all'): void;
  seeOutfit(): void;
  editLook(): void;
}

const thumb = (imageId: string | undefined, cls: string) => {
  const src = imageUrl(imageId);
  return src ? h('img', { class: cls, src, alt: '' }) : h('div', { class: `${cls} thumb-empty` });
};

const lower = (c: Category) => CATEGORY_LABEL[c].toLowerCase();

// ---- Draft: "What type of item is this?" --------------------------------------

export function draftView(d: Draft, a: Actions): HTMLElement {
  const status =
    d.status === 'downloading' ? 'Saving the image…' : d.status === 'failed' ? `Couldn't save this image (${d.error}). Try another image.` : null;
  return h(
    'section',
    { class: 'draft', 'aria-label': 'New item' },
    thumb(d.imageId, 'draft-img'),
    h(
      'div',
      { class: 'draft-body' },
      h('span', { class: 'eyebrow' }, d.sourceType === 'shopping' ? 'From this store' : 'Your upload'),
      d.title && h('strong', { class: 'draft-title', title: d.title }, d.title),
      status ? h('p', { class: 'muted' }, status) : h('p', { class: 'draft-q' }, 'What type of item is this?'),
      d.status === 'ready' &&
        h('div', { class: 'chips' }, ...CATEGORIES.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => a.saveDraft(c) }, CATEGORY_LABEL[c]))),
    ),
    h('button', { type: 'button', class: 'link', onclick: a.discardDraft }, 'Discard'),
  );
}

// ---- Your look ------------------------------------------------------------------
// The piece being considered (a store capture) is "Trying"; everything else is
// "With my closet". That split is Cabine's question: does this new piece work
// with what I already own?

const LOOK_ORDER: Category[] = ['outerwear', 'dress', 'top', 'bottom', 'shoes']; // head to toe

function pieceView(g: Garment, a: Actions): HTMLElement {
  return h(
    'li',
    { class: 'piece' },
    h(
      'button',
      { type: 'button', class: 'piece-main', title: `Change ${lower(g.category)}`, onclick: () => a.choose(g.category) },
      thumb(g.imageId, 'piece-img'),
      h('span', { class: 'piece-text' }, h('span', { class: 'piece-name' }, g.title ?? CATEGORY_LABEL[g.category]), h('span', { class: 'piece-cat' }, CATEGORY_LABEL[g.category])),
    ),
    h('button', { type: 'button', class: 'icon', 'aria-label': `Remove ${g.title ?? lower(g.category)}`, onclick: () => a.remove(g.category) }, '×'),
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
  const trying = worn.filter((g) => g.sourceType === 'shopping');
  const owned = worn.filter((g) => g.sourceType === 'closet');

  const group = (label: string, items: Garment[], cls: string) =>
    items.length ? h('div', { class: `group ${cls}` }, h('h3', {}, label), h('ul', { class: 'pieces' }, ...items.map((g) => pieceView(g, a)))) : null;

  return h(
    'section',
    { class: 'look', 'aria-label': 'Your look' },
    h('h2', {}, 'Your look'),
    worn.length === 0 && h('p', { class: 'muted' }, 'Pick pieces to see them together.'),
    group('Trying', trying, 'trying'),
    group(trying.length ? 'With my closet' : 'From my closet', owned, 'owned'),
    h(
      'div',
      { class: 'adders' },
      ...adders(s.outfit).map(({ label, slot }) =>
        h('button', { type: 'button', class: label.startsWith('+') ? 'adder' : 'link small', 'aria-pressed': s.choosing === slot, onclick: () => a.choose(slot) }, label),
      ),
    ),
    h('button', { type: 'button', class: 'primary', disabled: worn.length === 0, onclick: a.seeOutfit }, 'See the outfit'),
    worn.length > 0 && h('p', { class: 'muted small center' }, `${worn.length} piece${worn.length > 1 ? 's' : ''} selected`),
  );
}

// ---- Closet ----------------------------------------------------------------------

export function libraryView(s: ViewState, a: Actions): HTMLElement {
  const count = (c: Category) => s.garments.filter((g) => g.category === c).length;
  const shown = s.garments.filter((g) => s.filter === 'all' || g.category === s.filter).sort((x, y) => y.createdAt - x.createdAt);

  const heading = s.choosing
    ? h('div', { class: 'choosing' }, h('h2', {}, `Choose ${/^[aeiou]/i.test(s.choosing) ? 'an' : 'a'} ${lower(s.choosing)}`), h('button', { type: 'button', class: 'link small', onclick: a.cancelChoose }, 'Cancel'))
    : h('h2', {}, 'Closet');

  // While choosing a slot the closet is already narrowed to it, so filters are hidden.
  const filters =
    !s.choosing &&
    h(
      'div',
      { class: 'chips' },
      h('button', { type: 'button', class: 'chip', 'aria-pressed': s.filter === 'all', onclick: () => a.filter('all') }, `All ${s.garments.length}`),
      ...CATEGORIES.map((c) => h('button', { type: 'button', class: 'chip', 'aria-pressed': s.filter === c, onclick: () => a.filter(c) }, `${CATEGORY_LABEL[c]} ${count(c)}`)),
    );

  const grid = shown.length
    ? h(
        'div',
        { class: 'grid' },
        ...shown.map((g) =>
          h(
            'button',
            { type: 'button', class: 'item', title: g.title, 'aria-pressed': s.outfit[g.category] === g.id, onclick: () => a.pick(g) },
            thumb(g.imageId, 'item-img'),
            g.sourceType === 'shopping' && h('span', { class: 'tag' }, 'Trying'),
          ),
        ),
      )
    : h(
        'p',
        { class: 'muted' },
        s.garments.length
          ? `No ${lower((s.choosing ?? s.filter) as Category)} in your closet yet. Upload one, or capture it from a store.`
          : 'Your closet is empty. Upload a photo, or right-click a product image on any store and choose "Try in Cabine".',
      );

  return h('section', { class: 'library', id: 'library', 'aria-label': 'Your closet' }, heading, filters, grid);
}

// ---- Result: the render takes over the panel ------------------------------------

const pieceName = (g: Garment) => g.title ?? CATEGORY_LABEL[g.category];

// One render per look, so there's nothing to tick off: just say what's happening
// and roughly how long it takes. The pieces are listed below the frame.
function progressView(r: RenderState): HTMLElement {
  return h(
    'div',
    { class: 'progress', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('p', { class: 'progress-title' }, 'Styling your look…'),
    h('p', { class: 'muted small' }, r.cached ? 'Almost there' : `${r.garments.length} piece${r.garments.length > 1 ? 's' : ''} · about 15 seconds`),
  );
}

export function resultView(r: RenderState, a: Actions): HTMLElement {
  const frame =
    r.status === 'done' && r.imageUrl
      ? h('img', { class: 'render-img', src: r.imageUrl, alt: `Outfit: ${r.garments.map(pieceName).join(', ')}` })
      : r.status === 'error'
        ? h(
            'div',
            { class: 'render-error', role: 'alert' },
            h('p', {}, r.error ?? 'Something went wrong.'),
            h('button', { type: 'button', class: 'primary', onclick: a.seeOutfit }, 'Try again'),
          )
        : progressView(r);

  return h(
    'section',
    { class: 'result', 'aria-label': 'Your outfit' },
    h('button', { type: 'button', class: 'link back', onclick: a.editLook }, '← Edit look'),
    h('div', { class: `render-frame ${r.status}` }, frame),
    h(
      'ul',
      { class: 'result-pieces' },
      ...r.garments.map((g) =>
        h(
          'li',
          {},
          thumb(g.imageId, 'result-thumb'),
          h('span', { class: 'piece-name' }, pieceName(g)),
          h('span', { class: g.sourceType === 'shopping' ? 'tag' : 'tag owned' }, g.sourceType === 'shopping' ? 'Trying' : 'My closet'),
        ),
      ),
    ),
  );
}
