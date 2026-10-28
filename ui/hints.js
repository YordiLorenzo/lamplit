// @ts-check
// The bottom of the screen: which buttons do what right now, named as on the controller in use, and short messages
// for the player.

import { buttonFace, detailChoices, narrowed } from './logic.js';
import { actionableStep, els, focused, state, storeName } from './state.js';

/**
 * The PlayStation symbols as drawn shapes (index.html): as text, each font puts ✕, △, □ and ≡ at its own size and
 * height, so they sat off-centre in their circles. Letters stay text.
 * @type {Record<string, string>}
 */
const SHAPES = { '✕': 'btn-cross', '○': 'btn-circle', '△': 'btn-triangle', '□': 'btn-square', '≡': 'btn-menu', '↔': 'btn-adjust' };

export function showHints() {
  /** @param {import('./logic.js').HintButton} button @param {string} label */
  const b = (button, label) => {
    const [cls, glyph] = buttonFace(state.padKind, button);
    // The glyph stays in the text, hidden, for screen readers.
    const face = SHAPES[glyph] ? `<svg aria-hidden="true"><use href="#${SHAPES[glyph]}"/></svg><i>${glyph}</i>` : glyph;
    return `<span><b class="${cls}">${face}</b>${label}</span>`;
  };
  const g = focused();
  let html = '';
  if (state.mode === 'starting') {
    const s = actionableStep();
    if (s) html += b('ok', s.key === 'window' ? 'Show it' : `Open ${storeName(s.store) ?? 'the store app'}`);
    if (s?.state === 'block') html += b('triangle', 'Try anyway');
    html += b('back', 'Cancel');
  } else if (state.mode === 'details' && state.art.open) {
    html = state.art.editing
      ? b('ok', 'Select') + b('square', 'Delete') + b('triangle', 'Space') + b('back', 'Cancel')
      : b('ok', 'Select') + b('square', 'Edit search') + b('back', 'Back');
  } else if (state.mode === 'details') {
    const choice = detailChoices(g, state.running, state.closer)[state.detailsIdx];
    html = b('ok', choice.kind === 'play' ? choice.label : (choice.hold ?? 'Select')) + b('back', 'Close');
  } else if (state.mode === 'add' && state.add.view === 'name') {
    html = b('ok', 'Select') + b('square', 'Delete') + b('triangle', 'Space') + b('back', 'Back');
  } else if (state.mode === 'add') {
    const kind = state.add.rows.filter((r) => r.kind)[state.add.idx]?.kind;
    if (kind) html += b('ok', kind === 'exe' || kind === 'program' ? 'Choose' : 'Open');
    html += b('back', 'Back');
  } else if (state.mode === 'settings') {
    const row = state.settings.rows[state.settings.idx];
    if (row?.adjust) html += b('adjust', 'Adjust');
    else if (row?.kind) html += b('ok', row.kind === 'section' ? 'Open' : (row.hold ?? 'Select'));
    html += b('back', state.settings.section ? 'Back' : 'Close');
  } else if (state.mode === 'find') {
    html = b('ok', 'Select') + b('square', 'Delete') + b('triangle', 'Space') + b('back', 'Done');
  } else {
    // The row can be empty: no game found yet, every game hidden (the running one too, maybe), or a search that
    // matches nothing.
    if (g && state.running === g.id) html = b('ok', 'Back to game') + b('menu', 'Game menu');
    else if (g) html = b('ok', 'Play') + b('menu', 'Game menu') + b('triangle', 'Settings');
    else if (state.loaded && !state.all.length) html = b('ok', 'Add a game') + b('triangle', 'Settings');
    else html = b('triangle', 'Settings');
    if (state.all.length) html += b('square', 'Find');
    if (narrowed(state.find)) html += b('back', 'All games');
    else if (state.running && state.running !== g?.id) html += b('back', 'Back to game');
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
