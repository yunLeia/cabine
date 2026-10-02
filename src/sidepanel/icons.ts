import { h } from './dom';

// Cabine's line icons (design system: thin, rounded, 24 px grid). Static
// markup, set with innerHTML.
const PATHS = {
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  heartFilled: '<path fill="currentColor" d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.05-4.95M19 5v4h-4"/>',
  hanger: '<path d="M10 7.5a2 2 0 1 1 3 1.7c-.6.35-1 .8-1 1.5v.8"/><path d="M12 11.5 3.6 17c-.6.4-.3 1.3.4 1.3h16c.7 0 1-.9.4-1.3z"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  check: '<path d="M6 12.5l4 4 8-9"/>',
  pencil: '<path d="M14.5 5.5l4 4M5 19l1-4 10-10 3 3-10 10z"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName): HTMLElement {
  const el = h('span', { class: 'icon', 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`;
  return el;
}
