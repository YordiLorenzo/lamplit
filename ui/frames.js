// @ts-check
// One line in Lamplit's log after one of its animations: how many frames it drew, the longest wait between two and
// the 95th percentile, so the player's own runs tell whether it ran smoothly ("dock: fold 64 frames, worst 9 ms, 95%
// 8 ms").
import * as api from './api.js';

/**
 * Counts the frames drawn in the next `ms`, and logs them under `name` once that has passed. A window hidden meanwhile
 * draws no more, and the line has what it drew until then.
 * @param {string} name
 * @param {number} ms
 */
export function meter(name, ms) {
  /** @type {number[]} */
  const times = [];
  const step = (/** @type {number} */ t) => {
    times.push(t);
    if (t - times[0] < ms) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  setTimeout(() => {
    const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
    const at = (/** @type {number} */ share) => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * share))] ?? 0);
    api.log.info(`${name} ${times.length} frames, worst ${at(1)} ms, 95% ${at(0.95)} ms`);
  }, ms + 50);
}
