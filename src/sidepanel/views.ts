import { chainOrder } from '../shared/outfit';
import { CATEGORIES, CATEGORY_LABEL, type Category, type Draft, type Garment, type Outfit } from '../shared/types';
import { h } from './dom';
import { imageUrl } from './image-urls';

export interface ViewState {
  garments: Garment[];
  byId: Map<string, Garment>;
  outfit: Outfit;
  draft: Draft | null;
  filter: Category | 'all';
  notice: string | null;
}

export interface Actions {
  saveDraft(category: Category): void;
  discardDraft(): void;
  toggle(g: Garment): void;
  clearSlot(category: Category): void;
  browse(category: Category | 'all'): void;
  styleTogether(): void;
}

const thumb = (imageId?: string, cls = 'thumb') => {
  const src = imageUrl(imageId);
  return src ? h('img', { class: cls, src, alt: '' }) : h('div', { class: `${cls} thumb-empty` });
};

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

// ---- Your look: one row per slot + Style together -----------------------------

const LOOK_ROWS: Category[] = ['outerwear', 'top', 'bottom', 'dress', 'shoes'];

export function lookView(s: ViewState, a: Actions): HTMLElement {
  const worn = (c: Category) => (s.outfit[c] ? s.byId.get(s.outfit[c]!) : undefined);
  const covered = (c: Category) => (c === 'top' || c === 'bottom') && !!s.outfit.dress;

  const rows = LOOK_ROWS.map((c) => {
    const g = worn(c);
    const label = h('span', { class: 'slot-label' }, CATEGORY_LABEL[c]);
    if (g) {
      return h(
        'li',
        { class: 'slot filled' },
        label,
        h('button', { type: 'button', class: 'slot-item', onclick: () => a.browse(c), title: 'Change' }, thumb(g.imageId), h('span', { class: 'slot-name' }, g.title ?? CATEGORY_LABEL[c]), g.sourceType === 'shopping' && h('span', { class: 'tag' }, 'Store')),
        h('button', { type: 'button', class: 'icon', 'aria-label': `Remove ${CATEGORY_LABEL[c]}`, onclick: () => a.clearSlot(c) }, '×'),
      );
    }
    if (covered(c)) return h('li', { class: 'slot covered' }, label, h('span', { class: 'muted' }, 'Covered by the dress'));
    return h('li', { class: 'slot' }, label, h('button', { type: 'button', class: 'slot-add', onclick: () => a.browse(c) }, `+ Add ${CATEGORY_LABEL[c].toLowerCase()}`));
  });

  const chain = chainOrder(s.outfit, s.byId);
  return h(
    'section',
    { class: 'look', 'aria-label': 'Your look' },
    h('h2', {}, 'Your look'),
    h('ul', { class: 'slots' }, ...rows),
    h('button', { type: 'button', class: 'primary', disabled: chain.length === 0, onclick: a.styleTogether }, 'Style together'),
    h(
      'p',
      { class: 'muted small' },
      chain.length
        ? `Styles in order: ${chain.map((g) => g.title ?? CATEGORY_LABEL[g.category]).join(' → ')} · ${chain.length} step${chain.length > 1 ? 's' : ''}`
        : 'Pick at least one piece to style.',
    ),
    s.notice && h('p', { class: 'notice' }, s.notice),
  );
}

// ---- Library: filter by category, click to wear / take off --------------------

export function libraryView(s: ViewState, a: Actions): HTMLElement {
  const count = (c: Category) => s.garments.filter((g) => g.category === c).length;
  const filters = h(
    'div',
    { class: 'chips', role: 'tablist' },
    h('button', { type: 'button', class: 'chip', 'aria-pressed': s.filter === 'all', onclick: () => a.browse('all') }, `All ${s.garments.length}`),
    ...CATEGORIES.map((c) =>
      h('button', { type: 'button', class: 'chip', 'aria-pressed': s.filter === c, onclick: () => a.browse(c) }, `${CATEGORY_LABEL[c]} ${count(c)}`),
    ),
  );

  const shown = s.garments.filter((g) => s.filter === 'all' || g.category === s.filter).sort((x, y) => y.createdAt - x.createdAt);
  const grid = shown.length
    ? h(
        'div',
        { class: 'grid' },
        ...shown.map((g) =>
          h(
            'button',
            { type: 'button', class: 'item', title: g.title, 'aria-pressed': s.outfit[g.category] === g.id, onclick: () => a.toggle(g) },
            thumb(g.imageId, 'item-img'),
            g.sourceType === 'shopping' && h('span', { class: 'tag' }, 'Store'),
          ),
        ),
      )
    : h(
        'p',
        { class: 'muted' },
        s.garments.length
          ? `No ${CATEGORY_LABEL[s.filter as Category].toLowerCase()} yet.`
          : 'Your closet is empty. Upload a photo, or right-click a product image on any store and choose "Try in Cabine".',
      );

  return h('section', { class: 'library', id: 'library', 'aria-label': 'Your closet' }, h('h2', {}, 'Closet'), filters, grid);
}
