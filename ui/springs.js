// @ts-check
// The springs both pages move on, one set, named for what they move. Bounce only where there is momentum: the card
// lift and the island opening overshoot a little; everything a press opens, moves or dismisses settles without it.
// With Reduce Motion, what moves fades in place for FADE_MS instead.

/**
 * A damped spring's way from 0 to 1, as a CSS linear() easing, and how long it takes to come to rest: until what is
 * left of the way, or of the swing past it, is under half a percent. `response` is the undamped spring's period in
 * seconds, `damping` its damping ratio, 1 at most: below 1 it overshoots a little and settles.
 * @param {number} response
 * @param {number} damping
 */
export function spring(response, damping) {
  const omega = (2 * Math.PI) / response;
  let at;
  let seconds;
  if (damping >= 1) {
    /** @param {number} t */
    at = (t) => 1 - (1 + omega * t) * Math.exp(-omega * t);
    // (1 + x) e^-x falls to 0.005, by Newton's method from past the bend.
    let x = 7;
    for (let i = 0; i < 20; i++) x += ((1 + x) * Math.exp(-x) - 0.005) / (x * Math.exp(-x));
    seconds = x / omega;
  } else {
    const decay = damping * omega;
    const ringing = omega * Math.sqrt(1 - damping * damping);
    /** @param {number} t */
    at = (t) => 1 - Math.exp(-decay * t) * (Math.cos(ringing * t) + (decay / ringing) * Math.sin(ringing * t));
    seconds = Math.log(200 / Math.sqrt(1 - damping * damping)) / decay;
  }
  const steps = 40;
  const points = Array.from({ length: steps + 1 }, (_, i) => (i === steps ? 1 : Number(at((seconds * i) / steps).toFixed(4))));
  return { easing: `linear(${points.join(', ')})`, ms: Math.round(seconds * 1000), points };
}

/** @typedef {ReturnType<typeof spring>} Spring */

/** The springs by name. CSS has each as --name and --name-ms (nameSprings). */
export const SPRINGS = {
  /** Sheets, panels, popovers and toasts a press opens: about 425 ms. */
  tap: spring(0.36, 1),
  /** The card lift and the island opening, which carry momentum: about 520 ms, 1% past and back. */
  lift: spring(0.46, 0.82),
  /** The focus ring, the volume slot, a step along the row, small toggles: about 300 ms. */
  snap: spring(0.28, 0.9),
  /** Lowering, folding, any dismissal: about 355 ms. */
  close: spring(0.3, 1),
};

/** Reduce Motion's stand-in for all of them: an opacity fade in place. */
export const FADE_MS = 150;

/** Gives the page's CSS the springs, as --tap and --tap-ms and so on, and --fade-ms. @param {HTMLElement} root */
export function nameSprings(root) {
  for (const [name, { easing, ms }] of Object.entries(SPRINGS)) {
    root.style.setProperty(`--${name}`, easing);
    root.style.setProperty(`--${name}-ms`, `${ms}ms`);
  }
  root.style.setProperty('--fade-ms', `${FADE_MS}ms`);
}
