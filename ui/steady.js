// @ts-check
// Waiting for the frames to come on time before an animation starts. Right after a window shows, or while a GPU that
// dropped to its idle clocks speeds up again, the first frames come late, and an animation started then stutters where
// everyone sees it. The dock's spring (dock/main.js) and the screensaver's fade-in (screensaver/saver.js) wait.

/**
 * Calls `then` once frames have come on time two in a row and for `span` ms, or `cap` ms in at the latest. On time is
 * within half a frame of the shortest gap between frames so far, or of `frame` when that is shorter, both by the time
 * each frame was due and by when it ran: Chromium may hand a frame that ran late the time it was due. `frame` is for
 * frames that may all come late from the first, as while a GPU speeds up from its idle clocks.
 * @param {() => void} then
 * @param {{ cap: number, span?: number, frame?: number }} wait
 */
export function steady(then, { cap, span = 0, frame = Infinity }) {
  /** The gaps between the frames by when they were due. @type {number[]} */
  const due = [];
  /** Each gap by when the frame was due or by when it ran, the longer. @type {number[]} */
  const gaps = [];
  let first = 0;
  let last = 0;
  let lastRan = 0;
  /** @param {number} t */
  const next = (t) => {
    const now = performance.now();
    if (last) {
      due.push(t - last);
      gaps.push(Math.max(t - last, now - lastRan));
    }
    first ||= now;
    last = t;
    lastRan = now;
    // The frames on time at the end, and how long they took.
    const shortest = Math.min(frame, ...due);
    let inRow = 0;
    let time = 0;
    for (let i = gaps.length - 1; i >= 0 && gaps[i] <= shortest * 1.5; i--) {
      inRow++;
      time += gaps[i];
    }
    if ((inRow >= 2 && time >= span) || now - first >= cap) then();
    else requestAnimationFrame(next);
  };
  requestAnimationFrame(next);
}
