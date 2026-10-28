// @ts-check
// One plate changing shape: Settings' plate widening for Add a game, and growing out of the line it opens from on the
// empty home screen. Clip, translate and opacity only, so nothing is laid out or painted again on the way.

import { spring } from './logic.js';

/** Sheets and panels opened by a press: critically damped, so they settle without overshoot (0.36 s response). */
const omega = (2 * Math.PI) / 0.36;
const TAP = spring(omega * omega, 2 * omega);
document.documentElement.style.setProperty('--tap', TAP.easing);
document.documentElement.style.setProperty('--tap-ms', `${TAP.ms}ms`);

/** Plates whose clip settles when its spring ends. */
const watched = new WeakSet();
/** The shape a plate holds after returning into its source, until it opens again. */
const held = new WeakMap();

/**
 * The plate takes its other width: its box takes the wider one at once while a clip shows the width it had, the clip
 * springs to the new width, and the box settles there (style.css #settings.moving).
 * @param {HTMLElement} plate
 * @param {boolean} wide
 */
export function widen(plate, wide) {
  if (plate.classList.contains('wide') === wide) return;
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
}

/**
 * The plate grows out of `source`, a box on screen: it starts as that box, its clip and its place, and springs to its
 * own. With `back` it returns into `source` and holds there, and `done` runs.
 * @param {HTMLElement} plate
 * @param {DOMRect} source
 * @param {{ back?: boolean, done?: () => void }} [how]
 */
export function grow(plate, source, { back = false, done } = {}) {
  rest(plate);
  const own = plate.getBoundingClientRect();
  const round = parseFloat(getComputedStyle(plate).borderTopLeftRadius);
  const at = {
    translate: `${source.left + source.width / 2 - (own.left + own.width / 2)}px ${source.top + source.height / 2 - (own.top + own.height / 2)}px`,
    clipPath: `inset(${Math.max(0, (own.height - source.height) / 2)}px ${Math.max(0, (own.width - source.width) / 2)}px round ${source.height / 2}px)`,
  };
  const whole = { translate: '0px 0px', clipPath: `inset(0px round ${round}px)` };
  const move = plate.animate(back ? [whole, at] : [at, whole], { duration: TAP.ms, easing: TAP.easing, fill: back ? 'forwards' : 'none' });
  if (back) held.set(plate, move);
  move.finished.then(() => done?.(), () => {});
}

/** The plate takes its own shape again, dropping one it held after returning into its source. @param {HTMLElement} plate */
export function rest(plate) {
  held.get(plate)?.cancel();
  held.delete(plate);
}
