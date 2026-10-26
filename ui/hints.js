// @ts-check
// The bottom of the screen: which buttons do what right now, and short messages for the player.

import { detailChoices } from './logic.js';
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
  } else if (state.mode === 'details') {
    const choice = detailChoices(g, state.running)[state.detailsIdx];
    html = b('cross', '✕', choice.kind === 'play' ? choice.label : 'Select') + b('circle', '○', 'Close');
  } else if (state.mode === 'settings') {
    const row = state.settings.rows[state.settings.idx];
    if (row?.adjust) html += b('options', '↔', 'Adjust');
    else if (row?.kind) html += b('cross', '✕', row.kind === 'section' ? 'Open' : 'Select');
    html += b('circle', '○', state.settings.section ? 'Back' : 'Close');
  }
  else if (g && state.running === g.id) html = b('cross', '✕', 'Back to game') + b('options', '≡', 'Details');
  else if (g) {
    html = b('cross', '✕', 'Play') + b('options', '≡', 'Details') + b('options', '△', 'Settings');
    if (state.running) html += b('circle', '○', 'Back to game');
  } else html = b('options', '△', 'Settings');
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
