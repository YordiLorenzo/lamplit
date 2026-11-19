// @ts-check
// Change art, from a game's menu: Steam's store searched for the game's name, the matches shown as covers to pick
// from, and no art at all, which shows the game's name; Back to automatic gives the game Lamplit's own match again.
// The lifted cover (lift.js) shows the art in focus before it is picked. The search can be edited on the names
// keyboard. Below, a cover, a background, a logo and a trailer each from a file on the PC, chosen in its folders as
// Add a game chooses an exe; each shows in place of the art of its kind.

import * as api from './api.js';
import { clickedRow, drawRows, folderRows } from './folders.js';
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
/** Folder listings asked for so far, dropped in the same way. */
let listings = 0;
/** The folder the last file came from: choosing the next one starts there. @type {string | null} */
let lastFolder = null;

/** @type {[import('./api.js').ArtKind, string, string][]} the kinds of art a file can be: label, and what to choose */
const FILES = [['portrait', 'Cover', 'a cover'], ['hero', 'Background', 'a background'], ['logo', 'Logo', 'a logo'], ['trailer', 'Trailer', 'a trailer']];

/** Opens Change art for the game whose menu is open, searching for its name. */
export function openArt() {
  const g = byId(/** @type {string} */ (state.lifted));
  state.art = { ...state.art, open: true, id: g.id, query: g.name, found: null, error: '', focus: 'search', editing: false, saving: false, browsing: null, folder: null };
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
  els.artPick.classList.toggle('browsing', !!art.browsing);
  if (art.browsing) return renderFolder();
  els.artTitle.textContent = 'Change art';
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
  els.artFiles.replaceChildren(
    ...FILES.map(([kind, label]) => {
      const el = div(g.own_art[kind] ? 'choice on' : 'choice', label);
      el.dataset.id = `file:${kind}`;
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
  /** @type {HTMLElement[]} */ ([...els.artPick.querySelectorAll('#artField, #artTiles .tile, #artChoices .choice, #artFiles .choice')]);

/** The folder being looked through for a file, with its pictures or videos. */
function renderFolder() {
  const { art } = state;
  const [, , what] = /** @type {[string, string, string]} */ (FILES.find(([kind]) => kind === art.browsing));
  els.artTitle.textContent = `Choose ${what}`;
  els.artPath.textContent = art.saving ? 'Copying the file…' : (art.folder.path ?? 'This PC');
  art.rows = folderRows(art.folder, art.browsing === 'trailer' ? 'No folders or videos here' : 'No folders or pictures here');
  art.idx = Math.min(art.idx, art.rows.filter((r) => r.kind).length - 1);
  drawRows(els.artList, art.rows, art.idx);
  showHints();
}

/** The focused row of the folder. */
const artRow = () => state.art.rows.filter((r) => r.kind)[state.art.idx];

/**
 * Lists a folder, or the drives with null, for a `kind` of file. Focus goes to the folder the player came up from.
 * @param {string | null} path @param {import('./api.js').ArtKind} kind
 */
async function list(path, kind) {
  const asked = ++listings;
  const { art } = state;
  const from = art.folder?.path;
  art.saving = true;
  try {
    const folder = await api.libraryBrowse(path, kind);
    if (asked !== listings || !art.open) return;
    Object.assign(art, { browsing: kind, folder, idx: Math.max(0, folder.entries.findIndex((e) => e.path === from)) });
    sfx.move();
  } catch (e) {
    if (asked !== listings || !art.open) return;
    // The folder of the last file has gone since: the drives instead.
    if (!art.browsing && path !== null) {
      lastFolder = null;
      return list(null, kind);
    }
    toast(e.message, { game: byId(art.id), warn: true });
  } finally {
    if (asked === listings) art.saving = false;
  }
  render();
}

/**
 * Gives the game a `kind` of art from `file`, or with null takes the player's file of that kind away; then the
 * choices again, with focus on that kind.
 * @param {import('./api.js').ArtKind} kind @param {string | null} file
 */
async function setFile(kind, file) {
  const { art } = state;
  art.saving = true;
  sfx.open();
  render();
  try {
    setGames(await api.librarySetOwnArt(art.id, kind, file));
    if (art.open) Object.assign(art, { browsing: null, folder: null, focus: `file:${kind}` });
  } catch (e) {
    toast(e.message, { game: byId(art.id), warn: true });
  } finally {
    art.saving = false;
    if (art.open) render();
  }
}

/** ✕ on a folder's row: a folder opens, a file is used. */
function pressRow() {
  const row = artRow();
  const kind = /** @type {import('./api.js').ArtKind} */ (state.art.browsing);
  // A folder with nothing to open or choose has only a line saying so.
  if (!row) return;
  if (row.kind === 'drive' || row.kind === 'folder') list(row.path ?? null, kind);
  else {
    lastFolder = state.art.folder.path;
    setFile(kind, row.path ?? null);
  }
}

/** ○ in a folder: up a level, and from the drives back to the choices. */
function upFolder() {
  const { art } = state;
  if (art.folder.path !== null) return list(art.folder.parent, /** @type {import('./api.js').ArtKind} */ (art.browsing));
  Object.assign(art, { browsing: null, folder: null });
  sfx.back();
  render();
}

/** @param {number} delta */
function moveRow(delta) {
  const { art } = state;
  const next = Math.max(0, Math.min(art.rows.filter((r) => r.kind).length - 1, art.idx + delta));
  if (next === art.idx) return sfx.edge();
  art.idx = next;
  sfx.move();
  render();
}

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
  if (id.startsWith('file:')) return list(lastFolder, /** @type {import('./api.js').ArtKind} */ (id.slice('file:'.length)));
  choose({ steam: Number(id.slice('app:'.length)) });
}

/** The kind of art whose file choice has focus, when the game has a file of that kind. */
function focusedFile() {
  const { art } = state;
  const kind = /** @type {import('./api.js').ArtKind} */ (art.focus.slice('file:'.length));
  return art.focus.startsWith('file:') && byId(art.id).own_art[kind] ? kind : null;
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
  // As in Add a game, a folder takes no input while it lists or a file is copied.
  if (art.browsing) {
    const row = artRow();
    if (art.saving) return;
    if (action === 'back' || action === 'left') upFolder();
    else if (action === 'ok' || (action === 'right' && (row?.kind === 'drive' || row?.kind === 'folder'))) pressRow();
    else if (action === 'up' || action === 'down') moveRow(action === 'up' ? -1 : 1);
    else if (action === 'l1' || action === 'r1') moveRow(action === 'l1' ? -8 : 8);
    return;
  }
  // Back leaves while Steam's store is still being asked; the answer then changes the art behind the menu.
  if (action === 'back') return close();
  if (art.saving) return;
  const removable = focusedFile();
  if (action === 'ok') press();
  else if (action === 'square') edit();
  else if (action === 'triangle' && removable) setFile(removable, null);
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
// A click on a folder's row focuses and opens it.
els.artList.addEventListener('click', (e) => {
  const { art } = state;
  const target = clickedRow(els.artList, art.rows, e);
  if (!target || !art.open || !art.browsing || art.saving) return;
  art.idx = art.rows.filter((r) => r.kind).indexOf(target);
  pressRow();
});
