// @ts-check
// Controller presses (from Rust), keys and the mouse, turned into one set of actions for whatever is on screen.

import * as api from './api.js';
import { closeFind, moveFind, openFind, pressFind, typeFromKeyboard, typeKey } from './find.js';
import { toast } from './hints.js';
import { backToGame, cancelLaunch, play } from './launch.js';
import { closeDetails, detailChoice, markGame, move, moveDetails, openDetails, showAllGames } from './library.js';
import { narrowed } from './logic.js';
import { adjustSetting, backSettings, closeSettings, moveSettings, openSettings, selectSetting } from './settings.js';
import { actionableStep, els, state } from './state.js';

/** @typedef {import('./api.js').Action} Action */

/** Steam can mirror the controller as keys; while the pad is in use, the keyboard is ignored. */
const padInUse = () => performance.now() - state.lastPad < 2000;

/**
 * @param {Action} action
 * @param {'pad' | 'key' | 'mouse'} source
 */
export function act(action, source) {
  if (source === 'pad') state.lastPad = performance.now();
  else if (source === 'key' && padInUse()) return;

  if (state.mode === 'starting') {
    const s = actionableStep();
    if (action === 'back') cancelLaunch();
    else if (action === 'ok' && s) api.storesOpen(s.store).catch((e) => toast(e.message));
    else if (action === 'triangle' && s?.state === 'block') api.launchAnyway();
    return;
  }
  if (state.mode === 'settings') {
    const row = state.settings.rows[state.settings.idx];
    if (action === 'triangle') closeSettings();
    else if (action === 'back') backSettings();
    else if (action === 'up') moveSettings(-1);
    else if (action === 'down') moveSettings(1);
    else if ((action === 'left' || action === 'right') && row?.adjust) adjustSetting(action === 'left' ? -1 : 1);
    else if (action === 'right' && row?.kind === 'section') selectSetting();
    else if (action === 'left' && state.settings.section) backSettings();
    else if (action === 'ok') selectSetting();
    return;
  }
  if (state.mode === 'details') {
    if (action === 'back' || action === 'menu') closeDetails();
    else if (action === 'up' || action === 'down') moveDetails(action === 'up' ? -1 : 1);
    else if (action === 'ok' && detailChoice().kind === 'play') {
      closeDetails();
      play();
    } else if (action === 'ok') markGame();
    return;
  }
  if (state.mode === 'find') {
    // □ and △ delete and space, as on a console's own keyboard.
    if (action === 'back') closeFind();
    else if (action === 'ok') pressFind();
    else if (action === 'square') typeKey('delete');
    else if (action === 'triangle') typeKey('space');
    else if (action === 'up' || action === 'down' || action === 'left' || action === 'right') moveFind(action);
    return;
  }
  // These work on an empty row too: Settings has Power and Hidden games, a search can match nothing, and the running
  // game may be a hidden one.
  if (action === 'triangle') return openSettings();
  if (action === 'square' && state.all.length) return openFind();
  if (action === 'back') {
    if (narrowed(state.find)) showAllGames();
    else if (state.running) backToGame();
    return;
  }
  if (!state.games.length) return;
  switch (action) {
    case 'left': return move(-1);
    case 'right': return move(1);
    case 'l1': return move(-5);
    case 'r1': return move(5);
    case 'ok': return play();
    case 'menu': return openDetails();
  }
}

/**
 * The actions a held key repeats: only directions, as on the controller, so holding ✕ can't also answer the question
 * it asked (Settings > Power).
 */
const REPEATS = ['left', 'right', 'up', 'down'];

/** @type {Record<string, Action>} */
const KEYS = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  Enter: 'ok', Escape: 'back', Backspace: 'back', i: 'menu', c: 'triangle', f: 'square', PageUp: 'l1', PageDown: 'r1',
};

window.addEventListener('keydown', (e) => {
  // In Find, the keyboard types: characters go into the search and Backspace takes one out, rather than acting.
  const typing = (e.key.length === 1 || e.key === 'Backspace') && !e.ctrlKey && !e.altKey && !e.metaKey;
  if (state.mode === 'find' && typing) {
    e.preventDefault();
    if (!padInUse()) typeFromKeyboard(e.key);
    return;
  }
  const action = KEYS[e.key];
  if (!action) return;
  e.preventDefault();
  if (e.repeat && !REPEATS.includes(action)) return;
  act(action, 'key');
});

// A click on the focused cover plays it; a click on another one focuses it. The game is looked up at click time,
// since the row is re-sorted when a game ends.
els.track.addEventListener('click', (e) => {
  const cover = /** @type {Element} */ (e.target).closest('.cover');
  const k = state.games.findIndex((g) => g.el === cover);
  if (k < 0) return;
  // A click on a result leaves Find for the row.
  if (state.mode === 'find') closeFind();
  // Under Settings or Details, ✕ means their focused row: a cover click there could confirm a power action.
  if (state.mode !== 'browse') return;
  if (k === state.idx) act('ok', 'mouse');
  else move(k - state.idx);
});

// A click on a choice in Details picks it.
els.dChoices.addEventListener('click', (e) => {
  const k = [...els.dChoices.children].indexOf(/** @type {Element} */ (e.target).closest('.row'));
  if (k < 0 || state.mode !== 'details') return;
  state.detailsIdx = k;
  act('ok', 'mouse');
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

// The mouse pointer shows while the mouse moves, and hides again after two seconds.
let pointerTimer = 0;
window.addEventListener('mousemove', () => {
  document.body.classList.add('pointer');
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => document.body.classList.remove('pointer'), 2000);
});
