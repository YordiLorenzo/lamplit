// ui/steady.js: when an animation that waits for the frames to come on time starts, from frames fed by hand.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { steady } from '../ui/steady.js';

/**
 * Runs steady over frames that come `gaps` ms apart (the first at 0), each running on time, and says at which frame's
 * time `then` was called, or null.
 * @param {number[]} gaps @param {Parameters<typeof steady>[1]} wait
 */
function startsAt(gaps, wait) {
  const start = 1000;
  let now = start;
  /** @type {((t: number) => void)[]} */
  let waiting = [];
  const saved = { raf: globalThis.requestAnimationFrame, performance: globalThis.performance };
  globalThis.requestAnimationFrame = (callback) => waiting.push(callback);
  Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true, writable: true });
  let at = null;
  try {
    steady(() => (at ??= now), wait);
    for (const gap of [0, ...gaps]) {
      now += gap;
      const due = waiting;
      waiting = [];
      for (const callback of due) callback(now);
    }
  } finally {
    globalThis.requestAnimationFrame = saved.raf;
    Object.defineProperty(globalThis, 'performance', { value: saved.performance, configurable: true, writable: true });
  }
  return at === null ? null : at - start;
}

describe('waiting for frames on time (steady)', () => {
  // A screen at 100 Hz, which keeps the sums whole.
  const tick = 10;
  test('two frames on time in a row are enough by default', () => {
    assert.equal(startsAt([tick, tick, tick], { cap: 100 }), 2 * tick);
  });
  test('frames late after the first wait until two come on time', () => {
    assert.equal(startsAt([40, tick, tick, tick], { cap: 100 }), 40 + 2 * tick);
  });
  test('a span waits for that long of frames on time, and a late frame starts it over', () => {
    assert.equal(startsAt([...Array(5).fill(tick), 60, ...Array(10).fill(tick)], { cap: 1000, span: 60 }), 5 * tick + 60 + 6 * tick);
  });
  test('frames all late from the first wait, given the longest a frame can take', () => {
    const late = Array(20).fill(45);
    // Without it, the late frames set the measure and pass as on time.
    assert.equal(startsAt(late, { cap: 500 }), 90);
    assert.equal(startsAt([...late, tick, tick], { cap: 2000, frame: 1000 / 60 }), 20 * 45 + 2 * tick);
  });
  test('the cap ends the wait', () => {
    assert.equal(startsAt(Array(20).fill(45), { cap: 500, frame: 1000 / 60 }), 540);
  });
});
