// @ts-check
// The pill both pages show a short message in: the message's icon in a round badge, then its text, on the plate's
// glass (plate.css .news). The dock's news is one; home screen messages will be.

/**
 * Fills `el` as a pill: `icon` is one of the shared icons (icons.js), `warn` colours its badge.
 * @param {HTMLElement} el
 * @param {{ icon: import('./icons.js').IconId, text: string, warn?: boolean }} message
 */
export function fillPill(el, { icon, text, warn = false }) {
  const ns = 'http://www.w3.org/2000/svg';
  const badge = document.createElement('span');
  badge.className = 'badge';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#${icon}`);
  svg.append(use);
  badge.append(svg);
  const words = document.createElement('span');
  words.className = 'text';
  words.textContent = text;
  el.classList.add('news');
  el.classList.toggle('warn', warn);
  el.replaceChildren(badge, words);
}
