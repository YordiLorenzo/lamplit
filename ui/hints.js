// @ts-check
// The bottom of the screen: which buttons do what right now, named as on the controller in use; and short messages
// for the player, as pills.

import { buttonFace, detailChoices, narrowed } from './logic.js';
import { fillPill } from './pill.js';
import { actionableStep, els, focused, state, storeName } from './state.js';

/**
 * The PlayStation symbols as drawn shapes (index.html): as text, each font puts ✕, △, □ and ≡ at its own size and
 * height, so they sat off-centre in their circles. Letters stay text.
 * @type {Record<string, string>}
 */
const SHAPES = { '✕': 'btn-cross', '○': 'btn-circle', '△': 'btn-triangle', '□': 'btn-square', '≡': 'btn-menu', '↔': 'btn-adjust' };

/**
 * A controller button as the hints draw it, in a round badge: the PlayStation symbol's shape or the letter of the
 * controller in use. The glyph stays in the text, hidden, for screen readers.
 * @param {import('./logic.js').HintButton} button
 */
export function buttonBadge(button) {
  const [cls, glyph] = buttonFace(state.padKind, button);
  const face = SHAPES[glyph] ? `<svg aria-hidden="true"><use href="#${SHAPES[glyph]}"/></svg><i>${glyph}</i>` : glyph;
  return `<b class="${cls}">${face}</b>`;
}

/** What ✕ does for a step the player can act on (state.js actionableStep). @param {import('./api.js').LaunchStep} s */
export const stepAction = (s) => (s.key === 'window' ? 'Show the window' : `Open ${storeName(s.store) ?? 'the store app'}`);

export function showHints() {
  /** @param {import('./logic.js').HintButton} button @param {string} label */
  const b = (button, label) => `<span>${buttonBadge(button)}${label}</span>`;
  const g = focused();
  let html = '';
  if (state.mode === 'starting') {
    const s = actionableStep();
    if (s) html += b('ok', stepAction(s));
    if (s?.state === 'block') html += b('triangle', 'Try anyway');
    html += b('back', 'Cancel');
  } else if (state.mode === 'details' && state.art.open) {
    html = state.art.editing
      ? b('ok', 'Select') + b('square', 'Delete') + b('triangle', 'Space') + b('back', 'Cancel')
      : b('ok', 'Select') + b('square', 'Edit search') + b('back', 'Back');
  } else if (state.mode === 'details') {
    const choice = detailChoices(g, state.running, state.removing)[state.detailsIdx];
    html = b('ok', choice.kind === 'play' ? choice.label : 'Select') + b('back', 'Close');
  } else if (state.mode === 'add' && state.add.view === 'name') {
    html = b('ok', 'Select') + b('square', 'Delete') + b('triangle', 'Space') + b('back', 'Back');
  } else if (state.mode === 'add') {
    const kind = state.add.rows.filter((r) => r.kind)[state.add.idx]?.kind;
    if (kind) html += b('ok', kind === 'exe' || kind === 'program' ? 'Choose' : 'Open');
    html += b('back', 'Back');
  } else if (state.mode === 'settings') {
    const row = state.settings.rows[state.settings.idx];
    if (row?.adjust) html += b('adjust', 'Adjust');
    else if (row?.kind) html += b('ok', row.kind === 'section' ? 'Open' : 'Select');
    html += b('back', state.settings.section ? 'Back' : 'Close');
  } else if (state.mode === 'find' && state.findList) {
    html = b('ok', 'Select') + b('back', 'Back');
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

/** How long a message shows. */
const MESSAGE_MS = 6000;
/** @type {WeakMap<HTMLElement, number>} each pill's timer */
const timers = new WeakMap();

/**
 * A short message for the player, in a pill (pill.js) with its icon. One about a game stands on the line above the
 * row, after what narrows it, and names the game; any other at the top right, under the clock. Never over the covers.
 * `warn` says something went wrong, with the warning icon unless `icon` says otherwise.
 * @param {string} text
 * @param {{ game?: { id: string, name: string } | null, warn?: boolean, icon?: import('./icons.js').IconId }} [about]
 */
export function toast(text, { game = null, warn = false, icon = warn ? 'i-warn' : 'i-info' } = {}) {
  const el = game ? els.gameNews : els.toast;
  fillPill(el, { icon, text: game && !text.includes(game.name) ? `${game.name}: ${text}` : text, warn });
  if (game) el.dataset.game = game.id;
  el.classList.add('on');
  clearTimeout(timers.get(el));
  timers.set(el, setTimeout(() => el.classList.remove('on'), MESSAGE_MS));
}
