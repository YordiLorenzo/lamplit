// @ts-check
// Morph, for both pages: one plate changing shape. Its clip and its place spring between boxes on screen: it grows out
// of what it opens from (a line of text, a card's edge, the status capsule), turns from one face to another, and goes
// back into what it came from on close. Clip, translate and opacity only, so nothing is laid out or painted again on the way. With
// Reduce Motion it neither moves nor changes shape: it fades in place (each page's CSS), and what was to run once it
// ends runs at once. Each morph tells the frame probe (probe.js, in measurement builds only), which logs its frames.

import { SPRINGS } from './springs.js';

/** @typedef {keyof typeof SPRINGS} SpringName */

/** Reduce Motion is on: a plate fades in place rather than moving or changing shape. */
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Tells the probe that morph `name` plays for `ms`. @param {string} name @param {number} ms */
const tell = (name, ms) => document.dispatchEvent(new CustomEvent('morph', { detail: { name, ms } }));

/** The shape a plate holds after going back into what it came from, until it opens again. */
const held = new WeakMap();

/**
 * @typedef {{ box: DOMRect, round?: number, anchor?: 'left' | 'bottom-left', still?: boolean }} Place  a box on screen;
 *   its corners round by half its height unless `round` says otherwise, as a line of text, a pill or a chip does. The
 *   plate shows its middle there, or with `anchor` its left end or its bottom-left corner: a field widening out of a
 *   pill keeps its text where it was, and a plate rising out of a field shows its bottom row first. Or, `still`, a box
 *   over the plate: the plate stays where it is and only its clip shows the box, so what the plate holds stays where
 *   it is too.
 */

/** @param {number} n */
const px = (n) => `${Math.max(0, n)}px`;

/**
 * The plate's clip and place that show `place` out of its own box `own`, or its own box when `place` is null.
 * @param {DOMRect} own @param {Place | null} place @param {number} round  the plate's own corners
 */
function shape(own, place, round) {
  if (!place) return { translate: '0px 0px', clipPath: `inset(0px round ${round}px)` };
  const { box, anchor } = place;
  if (place.still) {
    const sides = [box.top - own.top, own.right - box.right, own.bottom - box.bottom, box.left - own.left].map(px);
    return { translate: '0px 0px', clipPath: `inset(${sides.join(' ')} round ${place.round ?? round}px)` };
  }
  if (anchor) {
    const right = Math.max(0, own.width - box.width);
    const top = Math.max(0, anchor === 'left' ? (own.height - box.height) / 2 : own.height - box.height);
    const bottom = anchor === 'left' ? top : 0;
    return {
      translate: `${box.left - own.left}px ${box.top - (own.top + top)}px`,
      clipPath: `inset(${top}px ${right}px ${bottom}px 0px round ${place.round ?? box.height / 2}px)`,
    };
  }
  return {
    translate: `${box.left + box.width / 2 - (own.left + own.width / 2)}px ${box.top + box.height / 2 - (own.top + own.height / 2)}px`,
    clipPath: `inset(${Math.max(0, (own.height - box.height) / 2)}px ${Math.max(0, (own.width - box.width) / 2)}px round ${place.round ?? box.height / 2}px)`,
  };
}

/**
 * The plate, laid out at its own box, goes from showing `from` to showing `to` (null: its own box) on spring `spring`,
 * `delay` ms from now, showing `from` meanwhile. With `hold` it stays at `to` until `rest`. `done` runs once it is
 * there.
 * @param {HTMLElement} plate
 * @param {{ name: string, from: Place | null, to: Place | null, spring?: SpringName, delay?: number, hold?: boolean, done?: () => void }} how
 */
export function morph(plate, { name, from, to, spring = 'tap', delay = 0, hold = false, done }) {
  rest(plate);
  if (reduced()) {
    done?.();
    return;
  }
  const own = plate.getBoundingClientRect();
  const round = parseFloat(getComputedStyle(plate).borderTopLeftRadius);
  const { easing, ms } = SPRINGS[spring];
  const move = plate.animate([shape(own, from, round), shape(own, to, round)], { duration: ms, easing, delay, fill: hold ? 'both' : 'backwards' });
  if (hold) held.set(plate, move);
  tell(name, delay + ms);
  move.finished.then(() => done?.(), () => {});
}

/**
 * The plate grows out of `source`, a box on screen, on the tap spring; with `back` it goes back into it on the close
 * spring and holds there, and `done` runs. `anchor` keeps an end or a corner of the plate on the box (Place).
 * @param {HTMLElement} plate
 * @param {DOMRect} source
 * @param {{ back?: boolean, done?: () => void, anchor?: Place['anchor'] }} [how]
 */
export function grow(plate, source, { back = false, done, anchor } = {}) {
  const place = { box: source, anchor };
  if (back) morph(plate, { name: `${plate.id}-return`, from: null, to: place, spring: 'close', hold: true, done });
  else morph(plate, { name: `${plate.id}-grow`, from: place, to: null, done });
}

/** The plate takes its own shape again, dropping one it held after going back into its source. @param {HTMLElement} plate */
export function rest(plate) {
  held.get(plate)?.cancel();
  held.delete(plate);
}

/**
 * The plate turns from one face to another, each laid out where it shows (`from` and `to`, boxes on screen): only its
 * clip moves, from the one to the other, while `cover` has the plate hold both; `settle` gives it the new face's size
 * once its clip is there. With Reduce Motion the plate takes that size at once, and its faces fade in place (the
 * page's CSS).
 * @param {HTMLElement} plate
 * @param {{ name: string, from: DOMRect, to: DOMRect, spring?: SpringName, cover: () => void, settle: () => void }} how
 */
export function turn(plate, { name, from, to, spring = 'tap', cover, settle }) {
  if (reduced()) {
    rest(plate);
    return settle();
  }
  const round = parseFloat(getComputedStyle(plate).borderTopLeftRadius);
  cover();
  const done = () => {
    settle();
    rest(plate);
  };
  morph(plate, { name, from: { box: from, round, still: true }, to: { box: to, round, still: true }, spring, hold: true, done });
}
