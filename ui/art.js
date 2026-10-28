// @ts-check
// Change art, from a game's menu: Steam's store searched for the game's name, the matches shown as covers to pick
// from, and no art at all, which shows the game's name; Back to automatic gives the game Lamplit's own match again.
// The lifted cover (lift.js) shows the art in focus before it is picked. The search can be edited on the names
// keyboard.

import * as api from './api.js';
import { showHints, toast } from './hints.js';
import { clickable, moveKey, nameField, pressKey, setText } from './keyboard.js';
import { face, showSheet } from './lift.js';
import { backToMenu, coverLook, setGames } from './library.js';
import { nearest } from './logic.js';
import { sfx } from './sounds.js';
import { byId, els, state } from './state.js';

/** @typedef {import('./api.js').ArtChoice} ArtChoice */

const field = nameField(els.artKeys, els.artQuery, 40);

/** Searches asked for so far: the answer to an older one, after the player searched again, is dropped. */
let searches = 0;

/** Opens Change art for the game whose menu is open, searching for its name. */
export function openArt() {
  const g = byId(/** @type {string} */ (state.lifted));
  state.art = { ...state.art, open: true, id: g.id, query: g.name, found: null, error: '', focus: 'search', editing: false, saving: false };
  showSheet('art');
  sfx.open();
  search();
}

async function search() {
  const asked = ++searches;
  const { art } = state;
  Object.assign(art, { found: null, error: '' });
  render();
  try {
    const found = await api.libraryArtSearch(art.query);
    if (asked !== searches || !art.open) return;
    art.found = found;
    // Focus goes to the first match, unless the player has moved on meanwhile.
    if (art.focus === 'search' && found.length) art.focus = `app:${found[0].appid}`;
  } catch (e) {
    if (asked !== searches || !art.open) return;
    art.error = e.message;
  }
  render();
}

/** @param {string} cls @param {string} text */
function div(cls, text = '') {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  return el;
}

/** The covers, choices and search field, with focus on one of them, and the card showing the art in focus. */
function render() {
  const { art } = state;
  const g = byId(art.id);
  els.artPick.classList.toggle('editing', art.editing);
  // While the player types, the field shows what the keyboard holds, which Done searches for.
  els.artQuery.textContent = art.editing ? field.text : art.query;
  els.artStatus.textContent = art.error
    ? art.error
    : art.found === null
      ? `Searching Steam's store for "${art.query}"…`
      : art.found.length
        ? ''
        : `Nothing on Steam's store matches "${art.query}". Edit the search to try other words.`;
  const chosen = g.art_choice;
  els.artTiles.replaceChildren(
    ...(art.found ?? []).map((c) => {
      const look = coverLook(c.name, c.portrait);
      const tile = div(`tile${look.art ? ' has-art' : ''}`);
      tile.dataset.id = `app:${c.appid}`;
      const cover = div('art');
      cover.style.backgroundImage = look.image;
      // Choosing it leaves the game's cover to its name, as the lifted card shows when it is in focus.
      if (!look.art) cover.append(div('none', 'No cover'));
      if (typeof chosen === 'object' && chosen?.steam === c.appid) cover.append(div('badge', 'Chosen'));
      tile.append(cover, div('caption', c.name));
      return tile;
    })
  );
  /** @type {[string, string, boolean][]} id, label, whether it is the game's choice now */
  const choices = [['none', 'No art, show the name', chosen === 'none']];
  if (chosen !== null) choices.push(['auto', 'Back to automatic', false]);
  els.artChoices.replaceChildren(
    ...choices.map(([id, label, on]) => {
      const el = div(on ? 'choice on' : 'choice', label);
      el.dataset.id = id;
      return el;
    })
  );
  // A focused cover that a new search took away hands focus to the search field.
  if (!art.editing && !targets().some((t) => t.dataset.id === art.focus)) art.focus = 'search';
  for (const t of targets()) {
    t.classList.toggle('focus', !art.editing && t.dataset.id === art.focus);
    t.classList.toggle('saving', art.saving && t.dataset.id === art.focus);
    if (t.dataset.id === art.focus) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  preview();
  showHints();
}

/** What focus can move between, outside the keyboard. */
const targets = () =>
  /** @type {HTMLElement[]} */ ([...els.artPick.querySelectorAll('#artField, #artTiles .tile, #artChoices .choice')]);

/** The card shows the focused cover, or the game's name for No art; elsewhere, and while typing, the game's own art. */
function preview() {
  const { art } = state;
  const g = byId(art.id);
  const match = !art.editing && art.found?.find((c) => art.focus === `app:${c.appid}`);
  if (match) face(coverLook(g.name, match.portrait));
  else if (!art.editing && art.focus === 'none') face(coverLook(g.name, null));
  else face(coverLook(g.name, g.art.portrait));
}

/** @param {'up' | 'down' | 'left' | 'right'} dir */
function move(dir) {
  const all = targets();
  const from = all.find((t) => t.dataset.id === state.art.focus);
  const to = all[nearest(from.getBoundingClientRect(), all.map((t) => t.getBoundingClientRect()), dir)];
  if (!to) return sfx.edge();
  state.art.focus = /** @type {string} */ (to.dataset.id);
  sfx.move();
  render();
}

/** The search field on the keyboard, to type other words. */
function edit() {
  state.art.editing = true;
  state.typing = field;
  setText(field, state.art.query);
  sfx.open();
  render();
}

/** Leaves the keyboard: with `query`, a new search for it, else the search as it was. @param {string} [query] */
function stopEditing(query) {
  state.art.editing = false;
  state.typing = null;
  els.artQuery.textContent = state.art.query;
  if (query === undefined || query.trim() === '' || query === state.art.query) {
    sfx.back();
    return render();
  }
  state.art.query = query.trim();
  state.art.focus = 'search';
  sfx.open();
  search();
}

/** ✕ on what has focus. */
function press() {
  const id = state.art.focus;
  if (id === 'search') return edit();
  if (id === 'none') return choose('none');
  if (id === 'auto') return choose(null);
  choose({ steam: Number(id.slice('app:'.length)) });
}

/** @param {ArtChoice | null} choice */
async function choose(choice) {
  const { art } = state;
  if (art.saving) return;
  art.saving = true;
  sfx.open();
  render();
  try {
    setGames(await api.librarySetArt(art.id, choice));
    if (!art.open) return;
    backToMenu();
  } catch (e) {
    toast(e.message, { game: byId(art.id), warn: true });
  } finally {
    art.saving = false;
    if (art.open) render();
  }
}

/** Back to the menu, without a change. */
function close() {
  searches++;
  sfx.back();
  backToMenu();
}

/**
 * A controller press, a key or a click while Change art is open.
 * @param {import('./api.js').Action} action
 */
export function actArt(action) {
  const { art } = state;
  if (art.editing) {
    if (action === 'back') stopEditing();
    else if (action === 'ok' && pressKey(field)) stopEditing(field.text);
    else if (action === 'square') pressKey(field, 'delete');
    else if (action === 'triangle') pressKey(field, 'space');
    else if (action === 'up' || action === 'down' || action === 'left' || action === 'right') {
      if (moveKey(field, action)) sfx.move();
      else sfx.edge();
    }
    return;
  }
  // Back leaves while Steam's store is still being asked; the answer then changes the art behind the menu.
  if (action === 'back') return close();
  if (art.saving) return;
  if (action === 'ok') press();
  else if (action === 'square') edit();
  else if (action === 'up' || action === 'down' || action === 'left' || action === 'right') move(action);
}

clickable(field, () => state.art.open && state.art.editing, () => stopEditing(field.text));

// A click on a cover or a choice picks it; one on the search field edits it.
els.artPick.addEventListener('click', (e) => {
  const target = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-id]'));
  if (!target || !state.art.open || state.art.editing || state.art.saving || els.artKeys.contains(target)) return;
  state.art.focus = /** @type {string} */ (target.dataset.id);
  press();
});
