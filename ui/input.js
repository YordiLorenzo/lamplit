// @ts-check
// Controller presses (from Rust), keys and the mouse, turned into one set of actions for whatever is on screen.

import * as api from './api.js';
import { toast } from './hints.js';
import { backToGame, cancelLaunch, play } from './launch.js';
import { closeDetails, detailChoice, markGame, move, moveDetails, openDetails } from './library.js';
import { adjustSetting, backSettings, closeSettings, moveSettings, openSettings, selectSetting } from './settings.js';
import { actionableStep, els, state } from './state.js';

/** @typedef {import('./api.js').Action} Action */

/**
 * @param {Action} action
 * @param {'pad' | 'key' | 'mouse'} source
 */
export function act(action, source) {
  if (source === 'pad') state.lastPad = performance.now();
  // Steam can mirror the controller as arrow keys; while the pad is in use, ignore the keyboard.
  else if (source === 'key' && performance.now() - state.lastPad < 2000) return;

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
  // Also with an empty row: Settings has Power and Hidden games, and the running game may be one that is hidden.
  if (action === 'triangle') return openSettings();
  if (action === 'back') {
    if (state.running) backToGame();
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
  Enter: 'ok', Escape: 'back', Backspace: 'back', i: 'menu', c: 'triangle', PageUp: 'l1', PageDown: 'r1',
};

window.addEventListener('keydown', (e) => {
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
  if (k === state.idx) act('ok', 'mouse');
  else if (k >= 0 && state.mode === 'browse') move(k - state.idx);
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
