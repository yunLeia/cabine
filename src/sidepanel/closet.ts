import type { Category, Garment } from '../shared/types';

const LABELS: Record<Category, string> = { top: 'Tops', bottom: 'Bottoms', outerwear: 'Outerwear' };

interface ClosetView {
  categories: Category[];
  items: Garment[];
  isWorn: (g: Garment) => boolean;
  onPick: (g: Garment) => void;
}

export function renderCloset(root: HTMLElement, view: ClosetView): void {
  const sections = view.categories.map((cat) => {
    const section = document.createElement('section');
    section.className = 'closet-section';

    const h = document.createElement('h2');
    h.textContent = LABELS[cat];

    const grid = document.createElement('div');
    grid.className = 'closet-grid';
    for (const g of view.items.filter((i) => i.category === cat)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'closet-item';
      btn.title = g.name;
      btn.setAttribute('aria-pressed', String(view.isWorn(g)));
      const img = document.createElement('img');
      img.src = g.imageSrc;
      img.alt = g.name;
      btn.append(img);
      btn.addEventListener('click', () => view.onPick(g));
      grid.append(btn);
    }

    section.append(h, grid);
    return section;
  });
  root.replaceChildren(...sections);
}
