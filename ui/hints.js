// @ts-check
// The bottom of the screen: which buttons do what right now, and short messages for the player.

import { narrowed } from './logic.js';
import { actionableStep, els, focused, state, storeName } from './state.js';

export function showHints() {
  /** @param {string} cls @param {string} glyph @param {string} label */
  const b = (cls, glyph, label) => `<span><b class="${cls}">${glyph}</b>${label}</span>`;
  const g = focused();
  let html = '';
  if (state.mode === 'starting') {
    const s = actionableStep();
    if (s) html += b('cross', '✕', `Open ${storeName(s.store) ?? 'the store app'}`);
    if (s?.state === 'block') html += b('options', '△', 'Try anyway');
    html += b('circle', '○', 'Cancel');
  } else if (state.mode === 'details') html = b('cross', '✕', 'Play') + b('circle', '○', 'Close');
  else if (state.mode === 'settings') {
    const row = state.settings.rows[state.settings.idx];
    if (row?.adjust) html += b('options', '↔', 'Adjust');
    else if (row?.kind) html += b('cross', '✕', row.kind === 'section' ? 'Open' : 'Select');
    html += b('circle', '○', state.settings.section ? 'Back' : 'Close');
  } else if (state.mode === 'find') {
    html = b('cross', '✕', 'Select') + b('options', '□', 'Delete') + b('options', '△', 'Space') + b('circle', '○', 'Done');
  } else if (state.all.length) {
    // The row can be empty here: a search that matches nothing.
    if (g && state.running === g.id) html = b('cross', '✕', 'Back to game') + b('options', '≡', 'Details');
    else if (g) html = b('cross', '✕', 'Play') + b('options', '≡', 'Details') + b('options', '△', 'Settings');
    html += b('options', '□', 'Find');
    if (narrowed(state.find)) html += b('circle', '○', 'All games');
    else if (state.running && state.running !== g?.id) html += b('circle', '○', 'Back to game');
  }
  els.hint.innerHTML = html;
}

let toastTimer = 0;

/** @param {string} text */
export function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('on'), 6000);
}
