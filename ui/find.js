// @ts-check
// The Find panel: a search typed on an on-screen keyboard, a store filter and a sort. The cover row follows every
// change while the panel is open (logic.js rowOf); this file draws the panel and acts on it.

import { showHints } from './hints.js';
import { SEARCH, buildKeys } from './keyboard.js';
import { showRow } from './library.js';
import { nearest, storeChoices, typed } from './logic.js';
import { sfx } from './sounds.js';
import { els, state, withStoreLogo } from './state.js';

/** @typedef {import('./logic.js').Find} Find */

buildKeys(els.findKeys, SEARCH);

/** The keys and choices focus can move between. */
const targets = () => /** @type {HTMLElement[]} */ ([...els.find.querySelectorAll('[data-id]')]);

/** @param {string} id @param {boolean} on @param {(string | Node)[]} content */
function choice(id, on, ...content) {
  const el = document.createElement('div');
  el.className = on ? 'choice on' : 'choice';
  el.dataset.id = id;
  el.append(...content);
  return el;
}

function renderFind() {
  const { query, store, sort } = state.find;
  els.findQuery.textContent = query;
  els.findStores.replaceChildren(
    ...storeChoices(state.all, store).map((s) =>
      // Games outside any store show as PC, as on the home screen's store pill.
      choice(`store:${s ?? 'all'}`, s === store, ...(s ? withStoreLogo(s === 'pc' ? null : s, s) : ['All']))
    )
  );
  els.findSort.replaceChildren(
    choice('sort:played', sort === 'played', 'Last played'),
    choice('sort:name', sort === 'name', 'A to Z')
  );
  // A store whose games have all gone takes its choice with it.
  if (!targets().some((t) => t.dataset.id === state.findFocus)) state.findFocus = 'store:all';
  for (const t of targets()) t.classList.toggle('focus', t.dataset.id === state.findFocus);
  // Store choices that wrap onto a third line (a 4:3 screen) push Sort below the panel's edge, which then scrolls.
  // In the frame after next: scrolling now would work out the panel's styles and layout inside the press, on top of
  // the frame that draws it.
  const focus = state.findFocus;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => targets().find((t) => t.dataset.id === focus)?.scrollIntoView({ block: 'nearest' }))
  );
  showHints();
}

/**
 * The search, the store or the sort changes: the row follows, with focus on its first game. Drawn also when nothing
 * changes, since a click or the PC's keyboard has moved focus to the key it pressed.
 * @param {Partial<Find>} change
 */
function setFind(change) {
  const next = { ...state.find, ...change };
  const { query, store, sort } = state.find;
  if (next.query === query && next.store === store && next.sort === sort) sfx.edge();
  else {
    state.find = next;
    sfx.move();
    showRow();
  }
  renderFind();
}

export function openFind() {
  state.mode = 'find';
  state.findFocus = 'a';
  els.find.classList.add('on');
  sfx.open();
  renderFind();
}

/** Closes the panel; the row stays as the search left it. */
export function closeFind() {
  state.mode = 'browse';
  els.find.classList.remove('on');
  sfx.back();
  showHints();
}

/** @param {'up' | 'down' | 'left' | 'right'} dir */
export function moveFind(dir) {
  const all = targets();
  const from = all.find((t) => t.dataset.id === state.findFocus);
  const to = all[nearest(from.getBoundingClientRect(), all.map((t) => t.getBoundingClientRect()), dir)];
  if (!to) return sfx.edge();
  state.findFocus = /** @type {string} */ (to.dataset.id);
  sfx.move();
  renderFind();
}

/** A letter or digit, 'space' or 'delete', from the on-screen keyboard or a controller button. @param {string} key */
export function typeKey(key) {
  setFind({ query: typed(state.find.query, key) });
}

/**
 * A key typed on the PC's keyboard: a character, or Backspace. Focus moves to Done, so Enter then closes the panel as
 * it would a search box.
 * @param {string} key  KeyboardEvent.key
 */
export function typeFromKeyboard(key) {
  state.findFocus = 'done';
  typeKey(key === 'Backspace' ? 'delete' : key === ' ' ? 'space' : key);
}

/** ✕ on the focused key or choice. */
export function pressFind() {
  const id = state.findFocus;
  const [kind, value] = id.split(':');
  if (id === 'done') closeFind();
  else if (id === 'clear') setFind({ query: '' });
  else if (kind === 'store') setFind({ store: value === 'all' ? null : /** @type {Find['store']} */ (value) });
  else if (kind === 'sort') setFind({ sort: /** @type {Find['sort']} */ (value) });
  else typeKey(id);
}

// A click on a key or a choice focuses and presses it.
els.find.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-id]'));
  if (!target || state.mode !== 'find') return;
  state.findFocus = /** @type {string} */ (target.dataset.id);
  pressFind();
});
