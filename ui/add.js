// @ts-check
// Add a game, with a controller alone, from Settings or the empty home screen: an installed program Lamplit passed
// over, or an exe found by browsing the PC's drives and folders; then its name, typed on the names keyboard, and its
// art through Change art.

import * as api from './api.js';
import { openArt } from './art.js';
import { showHints, toast } from './hints.js';
import { clickable, moveKey, nameField, pressKey, setText } from './keyboard.js';
import { focusGame, openDetails, render as renderRow, setGames } from './library.js';
import { sfx } from './sounds.js';
import { els, icon, state } from './state.js';

/** @typedef {typeof state.add.rows[number]} AddRow */

const field = nameField(els.addKeys, els.addName, 40);

/** What Back on the first list goes back to: Settings, when Add a game was opened there. @type {(() => void) | null} */
let backTo = null;
/** Folder listings asked for so far: an older answer, after the player has moved on, is dropped. */
let listings = 0;

/** @param {(() => void) | null} [back] */
export function openAdd(back = null) {
  backTo = back;
  state.mode = 'add';
  state.add = { ...state.add, view: 'list', programs: null, folder: null, idx: 0, exe: '', from: 'list', busy: false };
  els.add.classList.add('on');
  sfx.open();
  render();
  loadPrograms();
}

async function loadPrograms() {
  try {
    const programs = await api.libraryPrograms();
    if (state.mode !== 'add') return;
    state.add.programs = programs;
  } catch (e) {
    toast(e.message);
    state.add.programs = [];
  }
  if (state.mode === 'add' && state.add.view === 'list') render();
}

/**
 * Lists a folder, or the drives with null. Focus goes to the folder the player came up from, if it is there.
 * @param {string | null} path
 */
async function browse(path) {
  const asked = ++listings;
  const from = state.add.folder?.path;
  state.add.busy = true;
  try {
    const folder = await api.libraryBrowse(path);
    if (asked !== listings || state.mode !== 'add') return;
    Object.assign(state.add, { view: 'browse', folder, idx: Math.max(0, folder.entries.findIndex((e) => e.path === from)) });
    sfx.move();
  } catch (e) {
    toast(e.message);
  } finally {
    if (asked === listings) state.add.busy = false;
  }
  if (state.mode === 'add') render();
}

/** @returns {AddRow[]} */
function rows() {
  const { view, programs, folder } = state.add;
  if (view === 'browse') {
    const entries = folder.entries.map((e) => ({ kind: e.kind, label: e.name, path: e.path, title: e.title ?? '' }));
    return entries.length ? entries : [{ kind: '', label: 'No folders or exes here' }];
  }
  /** @type {AddRow[]} */
  const list = [{ kind: 'browse', label: 'Browse drives and folders' }, { heading: 'Programs on this PC' }];
  if (!programs) list.push({ kind: '', label: 'Looking for programs…' });
  else if (!programs.length) list.push({ kind: '', label: 'No other programs found' });
  else list.push(...programs.map((p) => ({ kind: 'program', label: p.name, value: p.folder, path: p.exe, title: p.name })));
  return list;
}

/** Icons in front of a row, by its kind. */
const ICONS = { browse: 'icon-drive', drive: 'icon-drive', folder: 'icon-folder', exe: 'icon-exe', program: 'icon-exe' };

function render() {
  const a = state.add;
  els.add.classList.toggle('naming', a.view === 'name');
  els.addTitle.textContent = { list: 'Add a game', browse: "Choose the game's exe", name: 'Name the game' }[a.view];
  els.addPath.textContent =
    a.view === 'browse' ? (a.folder.path ?? 'This PC') : a.view === 'name' ? a.exe : 'A program on this PC, or an exe on its drives';
  if (a.view !== 'name') {
    a.rows = rows();
    const focusable = a.rows.filter((r) => r.kind);
    a.idx = Math.min(a.idx, focusable.length - 1);
    els.addList.replaceChildren(
      ...a.rows.map((r) => {
        if (r.heading) {
          const h = document.createElement('h3');
          h.textContent = r.heading;
          return h;
        }
        const row = document.createElement('div');
        const focus = r.kind && focusable.indexOf(r) === a.idx;
        row.className = `row ${r.kind || 'info'}${focus ? ' focus' : ''}`;
        const label = document.createElement('span');
        label.append(...(ICONS[r.kind] ? [icon(ICONS[r.kind])] : []), r.label);
        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = r.value ?? '';
        row.append(label, value);
        if (focus) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
        return row;
      })
    );
  }
  showHints();
}

/** The focused row of the list or the folder. */
export const addRow = () => state.add.rows.filter((r) => r.kind)[state.add.idx];

/** @param {number} delta */
function move(delta) {
  const a = state.add;
  const last = a.rows.filter((r) => r.kind).length - 1;
  const next = Math.max(0, Math.min(last, a.idx + delta));
  if (next === a.idx) return sfx.edge();
  a.idx = next;
  sfx.move();
  render();
}

/** ✕ on the focused row. */
function press() {
  const row = addRow();
  if (row.kind === 'browse') browse(null);
  else if (row.kind === 'drive' || row.kind === 'folder') browse(row.path);
  else if (row.kind === 'exe' || row.kind === 'program') name(row.path, row.title);
}

/**
 * The name step for `exe`, starting from the name Lamplit suggests.
 * @param {string} exe @param {string} suggested
 */
function name(exe, suggested) {
  const a = state.add;
  Object.assign(a, { from: a.view === 'browse' ? 'browse' : 'list', view: 'name', exe });
  state.typing = field;
  setText(field, suggested);
  sfx.open();
  render();
}

/** ○: from naming back to the list it came from, from a folder up a level, from the first list out. */
function back() {
  const a = state.add;
  if (a.view === 'name') {
    a.view = a.from;
    state.typing = null;
    sfx.back();
    render();
  } else if (a.view === 'browse' && a.folder.path !== null) {
    browse(a.folder.parent);
  } else if (a.view === 'browse') {
    Object.assign(a, { view: 'list', folder: null, idx: 0 });
    sfx.back();
    render();
  } else {
    closeAdd();
    backTo?.();
  }
}

/** Closes Add a game, also when a game's news takes the screen (launch.js). @param {boolean} [quiet]  no sound */
export function closeAdd(quiet = false) {
  state.mode = 'browse';
  state.typing = null;
  els.add.classList.remove('on');
  if (!quiet) sfx.back();
  showHints();
}

/** Adds the game, then lifts its cover into Change art, searching for its name. */
async function save() {
  const a = state.add;
  a.busy = true;
  try {
    const { id, games } = await api.libraryAddGame(a.exe, field.text);
    if (state.mode !== 'add') return;
    closeAdd(true);
    setGames(games);
    focusGame(id);
    renderRow();
    openDetails();
    openArt();
  } catch (e) {
    toast(e.message);
  } finally {
    a.busy = false;
  }
}

/**
 * A controller press, a key or a click while Add a game is open.
 * @param {import('./api.js').Action} action
 */
export function actAdd(action) {
  const a = state.add;
  if (a.busy) return;
  const dir = action === 'up' || action === 'down' || action === 'left' || action === 'right' ? action : null;
  if (a.view === 'name') {
    if (action === 'back') back();
    else if (action === 'ok' && pressKey(field)) save();
    else if (action === 'square') pressKey(field, 'delete');
    else if (action === 'triangle') pressKey(field, 'space');
    else if (dir) (moveKey(field, dir) ? sfx.move : sfx.edge)();
    return;
  }
  const row = addRow();
  // As in Settings: → opens what ← came out of.
  if (action === 'back' || (action === 'left' && a.view === 'browse')) back();
  else if (action === 'ok' || (action === 'right' && (row?.kind === 'drive' || row?.kind === 'folder'))) press();
  else if (action === 'up' || action === 'down') move(action === 'up' ? -1 : 1);
  else if (action === 'l1' || action === 'r1') move(action === 'l1' ? -8 : 8);
}

clickable(field, () => state.mode === 'add' && state.add.view === 'name' && !state.add.busy, save);

// A click on a row focuses and opens it.
els.addList.addEventListener('click', (e) => {
  const row = /** @type {Element} */ (e.target).closest('.row');
  if (!row || state.mode !== 'add' || state.add.busy) return;
  const k = [...els.addList.querySelectorAll('.row')].indexOf(row);
  const target = state.add.rows.filter((r) => r.heading === undefined)[k];
  if (!target?.kind) return;
  state.add.idx = state.add.rows.filter((r) => r.kind).indexOf(target);
  press();
});
