// @ts-check
// Your captures is a face of the game's plate. Full screen covers the page and returns to the same thumbnail.

import { libraryCaptures } from './api.js';
import { showHints, toast } from './hints.js';
import { backToMenu, detailChoice, refreshChoices } from './library.js';
import { showSheet } from './lift.js';
import { captureStep, captureText } from './logic.js';
import { sfx } from './sounds.js';
import { byId, els, state } from './state.js';
import { showPicture } from './viewer.js';

/** The menu stays usable while the folders are read. A later opening owns a new state object. */
export async function readCaptures() {
  const captures = state.captures;
  try {
    const items = await libraryCaptures(captures.id);
    if (state.mode !== 'details' || state.captures !== captures) return;
    if (!items.length) return;
    const keep = detailChoice().kind;
    captures.items = items;
    refreshChoices(keep);
  } catch {
    if (state.mode === 'details' && state.captures === captures) {
      toast('Could not read your captures. Close the menu and try again.', { game: byId(captures.id), warn: true });
    }
  }
}

export function openCaptures() {
  const captures = state.captures;
  captures.open = true;
  captures.idx = 0;
  els.captureGrid.replaceChildren(...captures.items.map((capture, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = String(index);
    button.tabIndex = -1;
    button.setAttribute('aria-label', captureText(capture));
    const image = new Image();
    image.src = capture.path;
    image.alt = '';
    image.loading = 'lazy';
    image.draggable = false;
    button.append(image);
    return button;
  }));
  showSheet('captures');
  render();
  sfx.open();
}

function render() {
  const { captures } = state;
  const capture = captures.items[captures.idx];
  for (const [index, tile] of [...els.captureGrid.children].entries()) {
    tile.classList.toggle('focus', index === captures.idx);
    tile.setAttribute('aria-current', String(index === captures.idx));
    if (index === captures.idx && !captures.fullscreen) tile.scrollIntoView({ block: 'nearest' });
  }
  const text = `${captureText(capture)} · ${captures.idx + 1} of ${captures.items.length}`;
  els.captureMeta.textContent = text;
  showPicture(captures.fullscreen ? { src: capture.path, alt: `Capture from ${byId(captures.id).name}`, caption: text } : null);
  showHints();
}

/** Also called when a game's news closes the whole menu. */
export function closeCaptures() {
  state.captures.open = false;
  state.captures.fullscreen = false;
  showPicture(null);
}

/** @param {import('./api.js').Action} action */
export function actCaptures(action) {
  const captures = state.captures;
  if (action === 'back') {
    sfx.back();
    if (captures.fullscreen) {
      captures.fullscreen = false;
      render();
    } else backToMenu();
  } else if (action === 'ok' && !captures.fullscreen) {
    captures.fullscreen = true;
    sfx.open();
    render();
  } else if (action === 'left' || action === 'right' || action === 'up' || action === 'down') {
    if (captures.fullscreen && (action === 'up' || action === 'down')) return;
    const next = captures.fullscreen
      ? Math.max(0, Math.min(captures.items.length - 1, captures.idx + (action === 'left' ? -1 : 1)))
      : captureStep(captures.idx, captures.items.length, 3, action);
    if (next === captures.idx) return sfx.edge();
    captures.idx = next;
    sfx.move();
    render();
  }
}

els.captureGrid.addEventListener('click', (event) => {
  const tile = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-index]'));
  if (!tile || !state.captures.open) return;
  state.captures.idx = Number(tile.dataset.index);
  actCaptures('ok');
});
els.viewer.addEventListener('click', () => {
  if (state.captures.fullscreen) actCaptures('back');
});
