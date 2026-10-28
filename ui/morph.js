// @ts-check
// Morph, for both pages: one plate changing shape. Its clip and its place spring between boxes on screen: it grows out
// of what it opens from (a line of text, a card's edge, a chip), widens for another face, and goes back into what it
// came from on close. Clip, translate and opacity only, so nothing is laid out or painted again on the way. With
// Reduce Motion it neither moves nor changes shape: it fades in place (each page's CSS), and what was to run once it
// ends runs at once. Each morph tells the frame probe (probe.js, in measurement builds only), which logs its frames.

import { SPRINGS } from './springs.js';

/** @typedef {keyof typeof SPRINGS} SpringName */

/** Reduce Motion is on: a plate fades in place rather than moving or changing shape. */
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Tells the probe that morph `name` plays for `ms`. @param {string} name @param {number} ms */
const tell = (name, ms) => document.dispatchEvent(new CustomEvent('morph', { detail: { name, ms } }));

/** Plates whose clip settles when its spring ends. */
const watched = new WeakSet();
/** The shape a plate holds after going back into what it came from, until it opens again. */
const held = new WeakMap();

/**
 * @typedef {{ box: DOMRect, round?: number }} Place  a box on screen; its corners round by half its height unless
 *   `round` says otherwise, as a line of text, a pill or a chip does
 */

/**
 * The plate's clip and place that show `place` out of its own box `own`, or its own box when `place` is null.
 * @param {DOMRect} own @param {Place | null} place @param {number} round  the plate's own corners
 */
function shape(own, place, round) {
  if (!place) return { translate: '0px 0px', clipPath: `inset(0px round ${round}px)` };
  const { box } = place;
  return {
    translate: `${box.left + box.width / 2 - (own.left + own.width / 2)}px ${box.top + box.height / 2 - (own.top + own.height / 2)}px`,
    clipPath: `inset(${Math.max(0, (own.height - box.height) / 2)}px ${Math.max(0, (own.width - box.width) / 2)}px round ${place.round ?? box.height / 2}px)`,
  };
}

/**
 * The plate, laid out at its own box, goes from showing `from` to showing `to` (null: its own box) on spring `spring`.
 * With `hold` it stays at `to` until `rest`. `done` runs once it is there.
 * @param {HTMLElement} plate
 * @param {{ name: string, from: Place | null, to: Place | null, spring?: SpringName, hold?: boolean, done?: () => void }} how
 */
export function morph(plate, { name, from, to, spring = 'tap', hold = false, done }) {
  rest(plate);
  if (reduced()) {
    done?.();
    return;
  }
  const own = plate.getBoundingClientRect();
  const round = parseFloat(getComputedStyle(plate).borderTopLeftRadius);
  const { easing, ms } = SPRINGS[spring];
  const move = plate.animate([shape(own, from, round), shape(own, to, round)], { duration: ms, easing, fill: hold ? 'forwards' : 'none' });
  if (hold) held.set(plate, move);
  tell(name, ms);
  move.finished.then(() => done?.(), () => {});
}

/**
 * The plate grows out of `source`, a box on screen, on the tap spring; with `back` it goes back into it on the close
 * spring and holds there, and `done` runs.
 * @param {HTMLElement} plate
 * @param {DOMRect} source
 * @param {{ back?: boolean, done?: () => void }} [how]
 */
export function grow(plate, source, { back = false, done } = {}) {
  const place = { box: source };
  if (back) morph(plate, { name: `${plate.id}-return`, from: null, to: place, spring: 'close', hold: true, done });
  else morph(plate, { name: `${plate.id}-grow`, from: place, to: null, done });
}

/** The plate takes its own shape again, dropping one it held after going back into its source. @param {HTMLElement} plate */
export function rest(plate) {
  held.get(plate)?.cancel();
  held.delete(plate);
}

/**
 * The plate takes its other width, for another face: its box takes the wider width at once while a clip shows the
 * width it had, the clip springs to the new width on the tap spring, and the box settles there (the page's CSS:
 * style.css #settings.moving).
 * @param {HTMLElement} plate
 * @param {boolean} wide
 */
export function widen(plate, wide) {
  if (plate.classList.contains('wide') === wide) return;
  // Its faces fade where they are, and the plate takes its width with them.
  if (reduced()) {
    plate.classList.toggle('wide', wide);
    return;
  }
  if (!watched.has(plate)) {
    watched.add(plate);
    plate.addEventListener('transitionend', (e) => {
      if (e.target === plate && e.propertyName === 'clip-path') plate.classList.remove('moving');
    });
  }
  plate.classList.add('moving');
  // The clip starts at the width the plate shows now.
  void getComputedStyle(plate).clipPath;
  plate.classList.toggle('wide', wide);
  tell(`${plate.id}-${wide ? 'widen' : 'narrow'}`, SPRINGS.tap.ms);
}
