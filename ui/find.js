// @ts-check
// Find, on the filter line above the row: the search field, a chip for the store and one for the sort, and how many
// games the row holds. The on-screen keyboard grows up out of the field, and the store chip's list of logos up out of
// the chip; a search already set has its pill on that line, which widens into the field (morph.js grow). The row
// below stays sharp and follows every change (logic.js rowOf): it is the result list. One focus ring (ring.js) moves
// across the keys and the chips.

import { showHints } from './hints.js';
import { SEARCH, buildKeys } from './keyboard.js';
import { rowCount, showRow } from './library.js';
import { nearest, storeChoices, typed } from './logic.js';
import { grow, rest } from './morph.js';
import { focusRing } from './ring.js';
import { sfx } from './sounds.js';
import { els, icon, state, storeName, withStoreLogo } from './state.js';

/** @typedef {import('./logic.js').Find} Find */

buildKeys(els.findKeys, SEARCH);
const ring = focusRing(els.find);
/** The keyboard or the store list is still growing: the ring comes once it has, so it isn't drawn ahead of its key. */
let growing = false;

/** The keys and chips focus can move between, or the store list's choices while it is open. */
const targets = () =>
  /** @type {HTMLElement[]} */ ([...(state.findList ? els.findStores : els.find).querySelectorAll(state.findList ? '[data-id]' : '#findPlate [data-id], #findLine [data-id]')]);

/** @param {string} id @param {boolean} on @param {(string | Node)[]} content */
function choice(id, on, ...content) {
  const el = document.createElement('div');
  el.className = on ? 'choice on' : 'choice';
  el.dataset.id = id;
  el.append(...content);
  return el;
}

/** A store's logo and its name; games outside any store show as PC. @param {Find['store']} s */
const storeFace = (s) => (s ? withStoreLogo(s === 'pc' ? null : s, s === 'pc' ? 'PC' : (storeName(s) ?? s)) : [icon('i-store'), 'All stores']);

/** The chip's mark that it opens a list upward. */
function opensUp() {
  const mark = icon('i-back');
  mark.classList.add('up');
  return mark;
}

function renderFind() {
  const { query, store, sort } = state.find;
  els.findQuery.textContent = query;
  els.findStore.replaceChildren(...storeFace(store), opensUp());
  els.findSort.replaceChildren(icon('i-sort'), sort === 'name' ? 'A to Z' : 'Last played');
  els.findCount.textContent = rowCount();
  const stores = storeChoices(state.all, store);
  els.findStores.replaceChildren(...stores.map((s) => choice(`store:${s ?? 'all'}`, s === store, ...storeFace(s))));
  // A long list takes a second column rather than rising past the top of the screen.
  els.findStores.style.setProperty('--rows', String(Math.ceil(stores.length / Math.ceil(stores.length / 6))));
  // A store whose games have all gone takes its choice with it.
  if (!targets().some((t) => t.dataset.id === state.findFocus)) state.findFocus = state.findList ? 'store:all' : 'store';
  for (const t of /** @type {NodeListOf<HTMLElement>} */ (els.find.querySelectorAll('[data-id]'))) {
    t.classList.toggle('focus', t.dataset.id === state.findFocus);
  }
  if (!growing) moveRing();
  showHints();
}

function moveRing() {
  const to = targets().find((t) => t.dataset.id === state.findFocus);
  if (to) ring.move(to);
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

/** Where the field grows from and goes back to: the search's pill above the row, or, with none, the field's glass. */
function fieldSource() {
  const pill = els.filters.querySelector('.pill.query');
  if (pill) return pill.getBoundingClientRect();
  const f = els.findField.getBoundingClientRect();
  return new DOMRect(f.left, f.top, f.height, f.height);
}

export function openFind() {
  const from = fieldSource();
  state.mode = 'find';
  state.findFocus = 'a';
  state.findList = false;
  els.find.classList.remove('going');
  els.findStores.classList.remove('on', 'going');
  els.find.classList.add('on');
  sfx.open();
  growing = true;
  ring.hide();
  renderFind();
  // The field widens out of the pill, and the keyboard rises out of it on the same spring.
  grow(els.findField, from, { anchor: 'left' });
  grow(els.findPlate, from, {
    anchor: 'bottom-left',
    done: () => {
      growing = false;
      moveRing();
    },
  });
}

/** Closes Find; the row stays as the search left it, and the field goes back into its pill, or its glass. */
export function closeFind() {
  state.mode = 'browse';
  state.findList = false;
  growing = false;
  ring.hide();
  sfx.back();
  showHints();
  els.find.classList.add('going');
  // The store list may still be growing: it goes with Find, and what its opening was to do once it ended with it.
  rest(els.findStores);
  const to = fieldSource();
  grow(els.findPlate, to, { back: true, anchor: 'bottom-left' });
  grow(els.findField, to, {
    back: true,
    anchor: 'left',
    done: () => {
      if (state.mode === 'find') return;
      els.find.classList.remove('on', 'going');
      els.findStores.classList.remove('on', 'going');
    },
  });
}

/** The store chip opens its list of logos, growing up out of it, with focus on the store chosen now. */
function openStores() {
  state.findList = true;
  state.findFocus = `store:${state.find.store ?? 'all'}`;
  els.findStores.style.setProperty('--store-x', `${els.findLine.offsetLeft + els.findStore.offsetLeft}px`);
  els.findStores.style.setProperty('--store-w', `${els.findStore.offsetWidth}px`);
  els.findStores.classList.remove('going');
  els.findStores.classList.add('on');
  sfx.open();
  growing = true;
  renderFind();
  grow(els.findStores, els.findStore.getBoundingClientRect(), {
    anchor: 'bottom-left',
    done: () => {
      growing = false;
      moveRing();
    },
  });
}

/** The list goes back into its chip, which has the focus again. @param {boolean} [quiet]  a choice made has its own sound */
function closeStores(quiet = false) {
  state.findList = false;
  state.findFocus = 'store';
  growing = false;
  if (!quiet) sfx.back();
  els.findStores.classList.add('going');
  grow(els.findStores, els.findStore.getBoundingClientRect(), {
    back: true,
    anchor: 'bottom-left',
    done: () => !state.findList && els.findStores.classList.remove('on', 'going'),
  });
  renderFind();
}

/** ○: the store list closes if it is open, else Find. */
export function backFind() {
  if (state.findList) closeStores();
  else closeFind();
}

/**
 * Where `el` is laid out in Find's layer, from its offsets: a press while the keyboard or the list still grows (and so
 * still moves) goes where it would once they are in place, not to the chip a moving key happens to be beside.
 * @param {HTMLElement} el
 */
function laidOut(el) {
  let [x, y, n] = [0, 0, /** @type {HTMLElement | null} */ (el)];
  for (; n && n !== els.find; n = /** @type {HTMLElement | null} */ (n.offsetParent)) {
    x += n.offsetLeft;
    y += n.offsetTop;
  }
  return { x, y, width: el.offsetWidth, height: el.offsetHeight };
}

/** @param {'up' | 'down' | 'left' | 'right'} dir */
export function moveFind(dir) {
  const all = targets();
  const from = all.find((t) => t.dataset.id === state.findFocus);
  const to = all[nearest(laidOut(from), all.map(laidOut), dir)];
  if (!to) return sfx.edge();
  state.findFocus = /** @type {string} */ (to.dataset.id);
  sfx.move();
  renderFind();
}

/** A letter or digit, 'space' or 'delete', from the on-screen keyboard or a controller button. @param {string} key */
export function typeKey(key) {
  if (state.findList) closeStores(true);
  setFind({ query: typed(state.find.query, key) });
}

/**
 * A key typed on the PC's keyboard: a character, or Backspace. Focus moves to Done, so Enter then closes Find as it
 * would a search box.
 * @param {string} key  KeyboardEvent.key
 */
export function typeFromKeyboard(key) {
  if (state.findList) closeStores(true);
  state.findFocus = 'done';
  typeKey(key === 'Backspace' ? 'delete' : key === ' ' ? 'space' : key);
}

/** ✕ on the focused key, chip or store. */
export function pressFind() {
  const id = state.findFocus;
  const [kind, value] = id.split(':');
  if (id === 'done') closeFind();
  else if (id === 'clear') setFind({ query: '' });
  else if (id === 'store') openStores();
  else if (id === 'sort') setFind({ sort: state.find.sort === 'name' ? 'played' : 'name' });
  else if (kind === 'store') {
    setFind({ store: value === 'all' ? null : /** @type {Find['store']} */ (value) });
    closeStores(true);
  } else typeKey(id);
}

// A click on a key, a chip or a store focuses and presses it.
els.find.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-id]'));
  if (!target || state.mode !== 'find') return;
  // The store chip again closes its list; a click elsewhere closes it first.
  if (state.findList && target === els.findStore) return closeStores();
  if (state.findList && !els.findStores.contains(target)) closeStores(true);
  state.findFocus = /** @type {string} */ (target.dataset.id);
  pressFind();
});
