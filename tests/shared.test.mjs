// The pieces both pages share, next to steady.js in ui/: the named springs and the icons.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ICONS } from '../ui/icons.js';
import { FADE_MS, SPRINGS, spring } from '../ui/springs.js';

/** The stops of a linear() easing. @param {string} easing */
const stops = (easing) => easing.match(/^linear\((.*)\)$/)[1].split(', ').map(Number);

describe('the springs', () => {
  test('one set, named for what they move, timed as the menu audit has them', () => {
    // Response and damping from the audit's table, and how long each takes to come to rest.
    const table = { tap: [0.36, 1, 426], lift: [0.46, 0.82, 523], snap: [0.28, 0.9, 303], close: [0.3, 1, 355] };
    assert.deepEqual(Object.keys(SPRINGS), Object.keys(table));
    for (const [name, [response, damping, ms]] of Object.entries(table)) {
      assert.deepEqual(SPRINGS[name], spring(response, damping), name);
      assert.ok(Math.abs(SPRINGS[name].ms - ms) <= 2, `${name} ${SPRINGS[name].ms} ms`);
      const p = stops(SPRINGS[name].easing);
      assert.deepEqual([p[0], p.at(-1), p.length], [0, 1, 41], name);
    }
    assert.equal(FADE_MS, 150);
  });

  test('bounce only where there is momentum: the lift goes 1% past and back, what a press opens or closes never does', () => {
    const peak = (s) => Math.max(...stops(s.easing));
    assert.ok(peak(SPRINGS.lift) > 1.008 && peak(SPRINGS.lift) < 1.015, `lift ${peak(SPRINGS.lift)}`);
    for (const name of ['tap', 'close']) assert.equal(peak(SPRINGS[name]), 1, name);
    // The focus ring's spring is a hair under critical: nothing past its place anyone could see.
    assert.ok(peak(SPRINGS.snap) < 1.002, `snap ${peak(SPRINGS.snap)}`);
  });

  test('a critically damped spring comes to rest within half a percent of its place, and is most of the way early', () => {
    const { points, ms } = spring(0.3, 1);
    // x(t) = 1 - (1 + wt) e^-wt at the time it says it rests.
    const w = (2 * Math.PI) / 0.3;
    const left = (1 + (w * ms) / 1000) * Math.exp((-w * ms) / 1000);
    assert.ok(Math.abs(left - 0.005) < 0.0002, String(left));
    assert.ok(points.every((p, i) => i === 0 || p >= points[i - 1]), 'it never goes back');
    assert.ok(points[20] > 0.85, `half its time in: ${points[20]}`);
  });
});

describe('the icons', () => {
  /** The three that fill their shape to show a state. */
  const FILLED = ['i-play', 'i-star-on', 'i-quiet-on'];

  test('one stroked style: round 2-unit strokes in the text colour, the button marks 2.4, three filled for a state', () => {
    const wrong = [];
    for (const [id, shapes] of Object.entries(ICONS)) {
      if (!/^(btn|i)-[a-z-]+$/.test(id)) wrong.push(`${id}: its name`);
      if (FILLED.includes(id)) {
        if (!/^<path fill="currentColor"[^>]*\/>$/.test(shapes)) wrong.push(`${id}: not one filled shape`);
        continue;
      }
      const width = id.startsWith('btn-') ? 2.4 : 2;
      const open = `<g fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">`;
      const inside = shapes.slice(open.length, -'</g>'.length);
      if (!shapes.startsWith(open) || !shapes.endsWith('</g>')) wrong.push(`${id}: not strokes of ${width}`);
      else if (/fill=|stroke|<g/.test(inside)) wrong.push(`${id}: a shape of its own fill or stroke`);
    }
    assert.deepEqual(wrong, []);
  });

  test("the game menu's rows each have one, and Close game is not the power symbol", () => {
    for (const id of ['i-play', 'i-star', 'i-star-on', 'i-photo', 'i-eye-off', 'i-close-game', 'i-remove', 'i-power', 'i-restart', 'i-sleep']) {
      assert.ok(id in ICONS, id);
    }
    assert.notEqual(ICONS['i-close-game'], ICONS['i-power']);
    // The app's window, with an x in it.
    assert.match(ICONS['i-close-game'], /<rect [^>]*\/><path d="M3.5 8.5h17"\/><path d="M[\d.]+ [\d.]+l4.4 4.4M[\d.]+ [\d.]+l-4.4 4.4"\/>/);
    // The power symbol the dock drew for Close game, kept for Power.
    assert.ok(ICONS['i-power'].includes('<path d="M12 3.8v7.4"/><path d="M7.2 6.6a7.5 7.5 0 1 0 9.6 0"/>'));
  });

  test("the dock's glyphs are the base: each is there with its shapes, at 2 units", () => {
    // From dock.html: the shapes of a few, which the shared set keeps.
    for (const [id, shape] of [
      ['i-volume', '<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/>'],
      ['i-headset', '<path d="M4.5 15v-3a7.5 7.5 0 0 1 15 0v3"/>'],
      ['i-home', '<path d="M3.5 11.5 12 4.5l8.5 7"/>'],
      ['btn-up', '<path d="M12 18.5V5.5M6.8 10.7 12 5.5l5.2 5.2"/>'],
    ]) {
      assert.ok(ICONS[id].includes(shape), id);
    }
  });
});
