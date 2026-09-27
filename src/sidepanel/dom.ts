type Child = Node | string | false | null | undefined;

// Tiny element builder: h('button', { class: 'x', onclick: fn }, 'Label').
// Boolean attributes (disabled, hidden) are set when true and skipped when false;
// aria-* values are always written as "true"/"false", since ARIA reads the text.
// `on*` functions become listeners; null/undefined attributes are skipped.
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key.startsWith('aria-')) el.setAttribute(key, String(value));
    else if (value === false) continue;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else if (key === 'class') el.className = String(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  el.append(...children.filter((c): c is Node | string => c != null && c !== false));
  return el;
}
