// @ts-check
// The bottom of the screen: which buttons do what right now, named as on the controller in use, and short messages
// for the player.

import { buttonFace } from './logic.js';
import { actionableStep, els, focused, state, storeName } from './state.js';

export function showHints() {
  /** @param {import('./logic.js').HintButton} button @param {string} label */
  const b = (button, label) => {
    const [cls, glyph] = buttonFace(state.padKind, button);
    return `<span><b class="${cls}">${glyph}</b>${label}</span>`;
  };
  const g = focused();
  let html = '';
  if (state.mode === 'starting') {
    const s = actionableStep();
    if (s) html += b('ok', `Open ${storeName(s.store) ?? 'the store app'}`);
    if (s?.state === 'block') html += b('triangle', 'Try anyway');
    html += b('back', 'Cancel');
  } else if (state.mode === 'details') html = b('ok', 'Play') + b('back', 'Close');
  else if (state.mode === 'settings') {
    const row = state.settings.rows[state.settings.idx];
    if (row?.adjust) html += b('adjust', 'Adjust');
    else if (row?.kind) html += b('ok', row.kind === 'section' ? 'Open' : 'Select');
    html += b('back', state.settings.section ? 'Back' : 'Close');
  }
  else if (g && state.running === g.id) html = b('ok', 'Back to game') + b('menu', 'Details');
  else if (g) {
    html = b('ok', 'Play') + b('menu', 'Details') + b('triangle', 'Settings');
    if (state.running) html += b('back', 'Back to game');
  }
  els.hint.innerHTML = html;
}

/** The player used another kind of controller: the hints name its buttons. @param {import('./api.js').PadKind} kind */
export function setPadKind(kind) {
  state.padKind = kind;
  showHints();
}

let toastTimer = 0;

/** @param {string} text */
export function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('on'), 6000);
}
