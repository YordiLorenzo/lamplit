// @ts-check
// A game's menu lifts its cover toward the player: the cover grows out of the row and rises to the middle of the
// screen on a spring, its shadow deepens, a band of light sweeps across it, and it turns a little toward the menu,
// which opens beside it on the side with room. The rest of the screen blurs and dims. Lowering plays it back: the
// cover settles into its place in the row, and the row shows its own cover again once it has landed. Only transform
// and opacity change while it moves, so it stays on the compositor at 60 fps on a 4K screen.

import { liftLayout, spring } from './logic.js';
import { els, state } from './state.js';

/** The lift: about 620 ms with a 2% overshoot. */
const OPEN = spring(210, 22);
/** The way back: about 460 ms, no overshoot. */
const CLOSE = spring(500, 45);
for (const [name, value] of [
  ['--lift-open', OPEN.easing],
  ['--lift-open-ms', `${OPEN.ms}ms`],
  ['--lift-close', CLOSE.easing],
  ['--lift-close-ms', `${CLOSE.ms}ms`],
]) {
  document.documentElement.style.setProperty(name, value);
}

/** @typedef {{ image: string, art: boolean, name: string }} Look  a cover's art (library.js coverLook) */

/** Ends a lowering once the card has landed; a lift started meanwhile cancels it. */
let landing = 0;

/**
 * Lifts the cover of game `id`, which rests in the row at `from`, and opens the menu beside it.
 * @param {string} id
 * @param {import('./logic.js').Box} from
 * @param {Look} look
 */
export function lift(id, from, look) {
  clearTimeout(landing);
  const { card, menu, side } = liftLayout(from, { width: innerWidth, height: innerHeight }, innerWidth * 0.34);
  // The card is laid out where it ends up; at rest it is moved and scaled back onto the cover in the row.
  const dx = from.x + from.width / 2 - (card.x + card.width / 2);
  const dy = from.y + from.height / 2 - (card.y + card.height / 2);
  const px = (/** @type {number} */ n) => `${n.toFixed(1)}px`;
  const vars = {
    '--card-x': px(card.x),
    '--card-y': px(card.y),
    '--card-w': px(card.width),
    '--card-h': px(card.height),
    '--from': `translate(${px(dx)}, ${px(dy)}) scale(${(from.width / card.width).toFixed(4)})`,
    '--side': String(side),
    '--menu-x': px(menu.x),
    '--menu-w': px(menu.width),
    // Change art takes all the room on that side.
    '--wide-x': px(side > 0 ? menu.x : menu.x + menu.width - menu.room),
    '--wide-w': px(menu.room),
  };
  for (const [name, value] of Object.entries(vars)) els.lift.style.setProperty(name, value);
  face(look);
  state.lifted = id;
  if (!els.lift.classList.contains('shown')) {
    // Shown at rest without a transition (the last lift may have rested elsewhere), then lifted from there.
    els.lift.classList.add('shown', 'instant');
    void els.lift.offsetWidth;
    els.lift.classList.remove('instant');
  }
  els.lift.classList.remove('away');
  els.lift.classList.add('on');
}

/**
 * Lowers the card back onto its cover, or, `away`, lets it drop out of sight: its game has left the row.
 * @param {boolean} [away]
 */
export function lower(away = false) {
  els.lift.classList.remove('on');
  els.lift.classList.toggle('away', away);
  els.details.classList.remove('on');
  els.artPick.classList.remove('on');
  clearTimeout(landing);
  // A timer rather than transitionend, which an interrupted transition never sends.
  landing = setTimeout(land, CLOSE.ms);
}

function land() {
  els.lift.classList.remove('shown', 'away');
  state.lifted = null;
  els.track.querySelector('.cover.lifted')?.classList.remove('lifted');
}

/** Lands a lowering card at once: focus has moved to another game, so the slot it was heading for isn't its own. */
export function settle() {
  if (els.lift.classList.contains('on') || els.lift.classList.contains('away') || !state.lifted) return;
  clearTimeout(landing);
  land();
}

/** The art on the card: the game's, or a choice Change art previews. @param {Look} look */
export function face({ image, art, name }) {
  els.face.style.backgroundImage = image;
  els.face.classList.toggle('has-art', art);
  /** @type {HTMLElement} */ (els.face.querySelector('.name')).textContent = name;
}

/** Which sheet shows beside the card: the menu, or Change art. @param {'menu' | 'art'} which */
export function showSheet(which) {
  els.details.classList.toggle('on', which === 'menu');
  els.artPick.classList.toggle('on', which === 'art');
}
