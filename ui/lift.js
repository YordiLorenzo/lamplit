// @ts-check
// A game's menu lifts its cover toward the player: the cover grows out of the row and rises to the middle of the
// screen on a spring, its shadow deepens, a band of light sweeps across it, and it turns a little toward the menu.
// The menu is one plate that grows out of the card's edge on the side with room, from a sliver to its full size, and
// Change art is another face of the same plate, which grows from the menu's size to its own (morph.js). The rest of
// the screen blurs and dims. Lowering plays it back: the plate goes back into the card's edge, the cover settles into
// its place in the row, and the row shows its own cover again once it has landed. Only transform, clip and opacity
// change while it moves, so it stays on the compositor at 60 fps on a 4K screen.

import { liftLayout } from './logic.js';
import { morph, rest, turn } from './morph.js';
import { SPRINGS } from './springs.js';
import { els, state } from './state.js';
import { paintVeil } from './veil.js';

/** The cover rises on the lift spring (style.css --lift), 1% past its place and back, and lowers on the close one. */
const CLOSE = SPRINGS.close;

/** @typedef {{ image: string, art: boolean, name: string }} Look  a cover's art (library.js coverLook) */

/** Ends a lowering once the card has landed; a lift started meanwhile cancels it. */
let landing = 0;

/** The plate grows once the card is most of the way up, so it comes out of the card rather than ahead of it. */
const GROW_AFTER_MS = 150;

/** Where the card ends up, and the side its menu opens on (1 for the right), from the last lift. */
let at = { card: { x: 0, y: 0, width: 0, height: 0 }, side: 1 };

/**
 * The sliver the menu's plate grows out of and goes back into: along the card's edge on the menu's side, 4vh short of
 * its top and bottom, its corners rounded as the card's.
 * @returns {import('./morph.js').Place}
 */
function sliver() {
  const vh = innerHeight / 100;
  const { card, side } = at;
  const width = 3 * vh;
  const x = side > 0 ? card.x + card.width - width / 2 : card.x - width / 2;
  return { box: new DOMRect(x, card.y + 4 * vh, width, card.height - 8 * vh), round: width / 2 };
}

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
    '--grow-after': `${GROW_AFTER_MS}ms`,
  };
  for (const [name, value] of Object.entries(vars)) els.lift.style.setProperty(name, value);
  at = { card, side };
  face(look, false);
  state.lifted = id;
  if (!els.lift.classList.contains('shown')) {
    // Shown at rest without a transition (the last lift may have rested elsewhere), then lifted from there.
    els.lift.classList.add('shown', 'instant');
    void els.lift.offsetWidth;
    els.lift.classList.remove('instant');
  }
  els.lift.classList.remove('away');
  // The veil, drawn from what shows now, before the card's cover leaves the row.
  paintVeil(els.veil);
  els.lift.classList.add('on');
  els.sheet.classList.remove('turned');
  // Its size for the card's place just set: the menu's width there may wrap its name differently.
  fit(fitted());
  // The plate grows out of the card's edge, on the tap spring, once the card is most of the way up; its rows fade in
  // from 45% of the way (style.css).
  morph(els.sheet, { name: 'sheet-grow', from: sliver(), to: null, delay: GROW_AFTER_MS });
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
  // The plate goes back into the card's edge as it fades.
  morph(els.sheet, { name: 'sheet-return', from: null, to: sliver(), spring: 'close', hold: true });
  clearTimeout(landing);
  // A timer rather than transitionend, which an interrupted transition never sends.
  landing = setTimeout(land, CLOSE.ms);
}

function land() {
  els.lift.classList.remove('shown', 'away');
  rest(els.sheet);
  state.lifted = null;
  els.track.querySelector('.cover.lifted')?.classList.remove('lifted');
}

/** Lands a lowering card at once: focus has moved to another game, so the slot it was heading for isn't its own. */
export function settle() {
  if (els.lift.classList.contains('on') || els.lift.classList.contains('away') || !state.lifted) return;
  clearTimeout(landing);
  land();
}

/** How long the card's art takes to cross-fade into the next. */
const CROSS_MS = 180;

/**
 * The art on the card: the game's, or a choice Change art previews. Moving through the choices, the card cross-fades
 * from one to the next; `fade` false puts it in at once, as on a card about to lift.
 * @param {Look} look
 * @param {boolean} [fade]
 */
export function face({ image, art, name }, fade = true) {
  const was = els.face.dataset.image;
  if (fade && was && was !== image) {
    // The art that was stays over the new one and fades out.
    const old = document.createElement('div');
    old.className = 'was';
    old.style.backgroundImage = was;
    els.face.prepend(old);
    // Held at nothing once faded, until it goes: a frame between the fade's end and its removal would show it again.
    old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CROSS_MS, easing: 'ease', fill: 'forwards' }).finished.then(() => old.remove(), () => old.remove());
  }
  els.face.dataset.image = image;
  els.face.style.backgroundImage = image;
  els.face.classList.toggle('has-art', art);
  /** @type {HTMLElement} */ (els.face.querySelector('.name')).textContent = name;
}

/** The plate covers both faces while its clip moves from one to the other (showSheet). */
let held = false;

/** The plate takes the size and place of `face`, the menu or Change art, which is laid out where it shows. */
function fit(/** @type {HTMLElement} */ face) {
  els.sheet.classList.toggle('art', face === els.artPick);
  els.sheet.style.setProperty('--sheet-h', `${face.getBoundingClientRect().height}px`);
}

/** The face whose size the plate has. */
const fitted = () => (els.sheet.classList.contains('art') ? els.artPick : els.details);

// A face that changes size (Change art's keyboard opening, the menu's choices changing) takes the plate with it.
const resized = new ResizeObserver(() => {
  if (!held) fit(fitted());
});
resized.observe(els.details);
resized.observe(els.artPick);

/**
 * Which face of the plate beside the card shows: the menu, or Change art. Each face is laid out where it shows, so
 * with the menu up only the plate's clip moves, from the face that goes to the one that comes (morph.js `still`):
 * into Change art on the tap spring, back to the menu on the close one. Meanwhile the plate covers both faces, and
 * takes the size of the one that came once its clip is there.
 * @param {'menu' | 'art'} which
 */
export function showSheet(which) {
  const art = which === 'art';
  const up = els.lift.classList.contains('on') && els.details.classList.contains('on') === art;
  const [from, to] = art ? [els.details, els.artPick] : [els.artPick, els.details];
  from.classList.remove('on');
  to.classList.add('on');
  held = false;
  if (!up) return fit(to);
  // The face that comes fades in from 45% of the plate's way, without waiting on the card (style.css).
  els.sheet.classList.add('turned');
  const [was, will] = [from.getBoundingClientRect(), to.getBoundingClientRect()];
  turn(els.sheet, {
    name: art ? 'sheet-to-art' : 'sheet-to-menu',
    from: was,
    to: will,
    spring: art ? 'tap' : 'close',
    // Both faces are centred on the card, and Change art is the wider: its width, and the taller one's height.
    cover: () => {
      held = true;
      els.sheet.classList.add('art');
      els.sheet.style.setProperty('--sheet-h', `${Math.max(was.height, will.height)}px`);
    },
    settle: () => {
      held = false;
      fit(els.artPick.classList.contains('on') ? els.artPick : els.details);
    },
  });
}
