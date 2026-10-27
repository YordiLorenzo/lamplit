// @ts-check
// The on-screen QWERTY keyboards: Find's, and the names keyboard (a game's name, Change art's search), which adds
// Shift and the signs game names use. Keys sit on a grid of half keys, 20 columns; each row is its indent in half
// keys, then its keys, and the rows step right as on a real keyboard. The d-pad goes to the nearest key (logic.js
// nearest).

import { nameAfter, nearest } from './logic.js';

/** @typedef {[number, string[]][]} Layout */

/** The keys that aren't one character: their labels. */
const LABELS = { space: 'Space', delete: 'Delete', clear: 'Clear', done: 'Done', shift: 'Shift' };

/** Find's: its search ignores case. */
export const SEARCH = {
  /** @type {Layout} */
  rows: [
    [0, [...'1234567890']],
    [0, [...'qwertyuiop']],
    [1, [...'asdfghjkl']],
    [2, [...'zxcvbnm', 'delete']],
    [0, ['clear', 'space', 'done']],
  ],
  /** Widths in half keys, where not 2. */
  spans: { space: 10, delete: 4, clear: 4, done: 6 },
};

const NAMES = {
  /** @type {Layout} */
  rows: [
    [0, [...'1234567890']],
    [0, [...'qwertyuiop']],
    [1, [...'asdfghjkl']],
    [0, ['shift', ...'zxcvbnm', 'delete']],
    [0, ['clear', ...'-:\'.&', 'space', 'done']],
  ],
  spans: { shift: 3, delete: 3, clear: 3, space: 4, done: 3 },
};

/**
 * Fills `container` (a 20-column grid) with the keys of `layout`.
 * @param {HTMLElement} container
 * @param {{ rows: Layout, spans: Record<string, number> }} layout
 */
export function buildKeys(container, { rows, spans }) {
  container.append(
    ...rows.flatMap(([indent, ids], row) => {
      // Every key gets its own column: left to the grid, a key would fill the gap the indent leaves.
      let column = indent + 1;
      return ids.map((id) => {
        const key = document.createElement('div');
        key.className = 'key';
        key.dataset.id = id;
        const span = spans[id] ?? 2;
        key.textContent = LABELS[id] ?? id;
        if (span > 2) key.classList.add('wide');
        key.style.gridArea = `${row + 1} / ${column} / auto / span ${span}`;
        column += span;
        return key;
      });
    })
  );
}

/**
 * A text field typed on the names keyboard: the name so far (logic.js Name), the focused key, the longest the name
 * may get, and the elements it is drawn in.
 * @typedef {import('./logic.js').Name & { focus: string, max: number, keys: HTMLElement, out: HTMLElement }} Field
 */

/**
 * @param {HTMLElement} keys  the grid the keys go in
 * @param {HTMLElement} out  where the text shows
 * @param {number} max
 * @returns {Field}
 */
export function nameField(keys, out, max) {
  buildKeys(keys, NAMES);
  return { text: '', caps: true, focus: 'done', max, keys, out };
}

/**
 * Puts `text` in the field, with focus on Done: a suggested name or the last search is usually what the player
 * wants, and ✕ takes it at once.
 * @param {Field} f
 * @param {string} text
 */
export function setText(f, text) {
  Object.assign(f, { text, caps: !text || text.endsWith(' '), focus: 'done' });
  draw(f);
}

/** @param {Field} f */
export function draw(f) {
  f.out.textContent = f.text;
  for (const key of /** @type {NodeListOf<HTMLElement>} */ (f.keys.querySelectorAll('[data-id]'))) {
    const id = /** @type {string} */ (key.dataset.id);
    key.classList.toggle('focus', id === f.focus);
    if (id.length === 1) key.textContent = f.caps ? id.toUpperCase() : id;
    if (id === 'shift') key.classList.toggle('on', f.caps);
  }
}

/**
 * Moves focus to the nearest key that way; false when there is none.
 * @param {Field} f
 * @param {'up' | 'down' | 'left' | 'right'} dir
 */
export function moveKey(f, dir) {
  const all = /** @type {HTMLElement[]} */ ([...f.keys.querySelectorAll('[data-id]')]);
  const from = all.find((k) => k.dataset.id === f.focus);
  const to = all[nearest(from.getBoundingClientRect(), all.map((k) => k.getBoundingClientRect()), dir)];
  if (!to) return false;
  f.focus = /** @type {string} */ (to.dataset.id);
  draw(f);
  return true;
}

/**
 * A key of the names keyboard, pressed on screen or with a controller button ('delete', 'space'); true for Done.
 * @param {Field} f
 * @param {string} [key]  the focused key when left out
 */
export function pressKey(f, key = f.focus) {
  if (key === 'done') return true;
  Object.assign(f, nameAfter(f, key, f.max));
  draw(f);
  return false;
}

/**
 * A key typed on the PC's keyboard: a character, or Backspace. It goes in as typed, without the capitals the
 * on-screen keyboard adds, and focus moves to Done, so Enter then takes the name.
 * @param {Field} f
 * @param {string} key  KeyboardEvent.key
 */
export function typeKey(f, key) {
  const id = key === 'Backspace' ? 'delete' : key === ' ' ? 'space' : key;
  const { text } = nameAfter({ text: f.text, caps: false }, id, f.max);
  Object.assign(f, { text, caps: !text || text.endsWith(' '), focus: 'done' });
  draw(f);
}

/**
 * Clicks on a key press it, as ✕ would. `done` runs on Done.
 * @param {Field} f
 * @param {() => boolean} active  whether the keyboard is in use
 * @param {() => void} done
 */
export function clickable(f, active, done) {
  f.keys.addEventListener('click', (e) => {
    const key = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-id]'));
    if (!key || !active()) return;
    f.focus = /** @type {string} */ (key.dataset.id);
    if (pressKey(f)) done();
  });
}
