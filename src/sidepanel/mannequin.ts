import type { Garment } from '../shared/types';
import { SLOTS } from './slots';

// Rendering is just stacked images: the mannequin at the bottom, then one
// absolutely positioned box per garment at its category's slot.
export function renderMannequin(stage: HTMLElement, garments: Garment[]): void {
  const base = document.createElement('img');
  base.className = 'mannequin';
  base.src = '/mannequin.svg';
  base.alt = '';

  const layers = garments.map((g) => {
    const slot = SLOTS[g.category];
    const box = document.createElement('div');
    box.className = 'layer';
    box.style.left = `${slot.left}%`;
    box.style.top = `${slot.top}%`;
    box.style.width = `${slot.width}%`;
    box.style.height = `${slot.height}%`;
    box.style.zIndex = String(slot.z);

    const img = document.createElement('img');
    img.src = g.imageSrc;
    img.alt = g.name;
    const { scale = 1, dx = 0, dy = 0 } = g.adjust ?? {};
    if (scale !== 1 || dx || dy) {
      img.style.transform = `translate(${dx * 100}%, ${dy * 100}%) scale(${scale})`;
    }
    box.append(img);
    return box;
  });

  stage.replaceChildren(base, ...layers);
}
