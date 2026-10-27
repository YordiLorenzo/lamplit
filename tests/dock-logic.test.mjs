// The pure functions of the in-game dock's page (ui/dock/logic.js), in Node: `node --test tests/dock-logic.test.mjs`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chips, counts, hints, MIRROR_MS, outputLabel, PAD_KEEPS_MS, sessionText, spring, tiles, volumeText } from '../ui/dock/logic.js';
import { ipc, known, like } from './fixtures.mjs';

/** What the dock knows, as Rust sends it, with some parts changed. */
const data = (changes = {}) => ({
  game: ipc('dock-game'),
  sound: ipc('sound'),
  accessories: ipc('accessories'),
  quiet: ipc('quiet'),
  overlays: ipc('overlays'),
  ...changes,
});
const keys = (d) => tiles(d).map((t) => t.key);
const tile = (d, key) => tiles(d).find((t) => t.key === key);

describe('the tiles', () => {
  test('Resume first, then output, quiet mode, stats, Home and closing the game', () => {
    assert.deepEqual(keys(data()), ['resume', 'output', 'quiet', 'stats', 'home', 'close']);
  });

  test("stats only with NVIDIA's overlay, and no Close game without a game", () => {
    const d = data({ overlays: like(ipc('overlays'), { nvidia_overlay: false, nvidia_stats: null }), game: null });
    assert.deepEqual(keys(d), ['resume', 'output', 'quiet', 'home']);
  });

  test('the output names the kind of device in use, with its icon', () => {
    assert.deepEqual([tile(data(), 'output').label, tile(data(), 'output').icon], ['TV', 'tv']);
    assert.deepEqual([tile(data({ sound: null }), 'output').label, tile(data({ sound: null }), 'output').icon], ['Output', 'speaker']);
    const other = like(ipc('sound').outputs[0], { name: 'Speakers (Realtek)', kind: 'other' });
    assert.equal(outputLabel(other), 'Speakers (Realtek)');
  });

  test('quiet mode and the stats show their state by their icon, with one label each', () => {
    const quiet = (state) => tile(data({ quiet: like(ipc('quiet'), { state: known('quiet_state', state) }) }), 'quiet');
    assert.deepEqual([quiet('on').icon, quiet('on').on, quiet('on').label], ['quiet-on', true, 'Quiet']);
    assert.deepEqual([quiet('off').icon, quiet('off').on], ['quiet', false]);
    assert.deepEqual([quiet('partly').label, quiet('partly').on, quiet('partly').tone], ['Partly quiet', true, 'warn']);
    const stats = (on) => tile(data({ overlays: like(ipc('overlays'), { nvidia_stats: on }) }), 'stats');
    assert.deepEqual([stats(true).on, stats(false).on, stats(null).on, stats(null).label], [true, false, false, 'Stats']);
  });

  test('closing a game, or forcing one closed that hangs or ignored the request', () => {
    const responding = like(ipc('dock-game'), { responding: true, force_close: false });
    assert.deepEqual([tile(data({ game: responding }), 'close').label, tile(data({ game: responding }), 'close').tone], ['Close game', '']);
    // The fixture's game isn't responding.
    assert.deepEqual([tile(data(), 'close').label, tile(data(), 'close').tone], ['Force close', 'warn']);
  });
});

test('the volume reads as a percent, or Muted', () => {
  assert.equal(volumeText(ipc('sound')), '45%');
  assert.equal(volumeText(like(ipc('sound'), { muted: true })), 'Muted');
  assert.equal(volumeText(null), '…');
  assert.equal(volumeText(like(ipc('sound'), { volume: null })), '…');
});

test('under the name: how long the game has been played, or that it is not responding', () => {
  const started = ipc('dock-game').started;
  const playing = like(ipc('dock-game'), { responding: true });
  assert.equal(sessionText(playing, started + 30), 'Just started');
  assert.equal(sessionText(playing, started + 42 * 60), 'Playing for 42 min');
  assert.equal(sessionText(playing, started + 72 * 60 + 59), 'Playing for 1 h 12 min');
  assert.equal(sessionText(ipc('dock-game'), started + 60), 'Not responding');
  assert.equal(sessionText(like(playing, { started: 0 }), started), '');
  assert.equal(sessionText(null, started), '');
});

test('the top line has each battery with its level, low ones marked', () => {
  const acc = ipc('accessories');
  assert.deepEqual(chips(acc), [
    { icon: 'controller', text: '60%', level: 60, tone: '' },
    { icon: 'controller', text: 'Medium', level: 55, tone: '' },
    { icon: 'headset', text: '80%', level: 80, tone: '' },
  ]);
  const [dualsense, xbox] = acc.controllers;
  const low = like(acc, {
    headset: { on: true, battery: 10, charge: known('charge', 'battery') },
    controllers: [
      like(dualsense, { battery: { percent: 15, level: null, charge: known('charge', 'battery') } }),
      like(xbox, { battery: { percent: null, level: known('battery_level', 'low'), charge: null } }),
    ],
  });
  assert.deepEqual(chips(low).map((c) => c.tone), ['warn', 'warn', 'warn']);
  // Charging isn't low, a controller without a battery report and a headset that is off show nothing.
  const quiet = like(acc, {
    headset: { on: false },
    controllers: [like(dualsense, { battery: { percent: 5, level: null, charge: known('charge', 'charging') } }), like(xbox, { battery: null })],
  });
  assert.deepEqual(chips(quiet), [{ icon: 'controller', text: '5%', level: 5, tone: '' }]);
  assert.deepEqual(chips(null), []);
});

test('the hints say what the buttons do where the focus is', () => {
  const d = data({ quiet: like(ipc('quiet'), { active: false }) });
  assert.deepEqual(hints('tiles', 'resume', d), [['ok', 'Resume'], ['up', 'Volume']]);
  assert.deepEqual(hints('tiles', 'quiet', d), [['ok', 'Turn on'], ['up', 'Volume'], ['back', 'Back to game']]);
  assert.deepEqual(hints('tiles', 'close', d)[0], ['ok', 'Hold to force close']);
  assert.deepEqual(hints('tiles', 'close', data({ game: like(ipc('dock-game'), { force_close: false }) }))[0], ['ok', 'Hold to close game']);
  assert.deepEqual(hints('volume', 'resume', d), [['adjust', 'Volume'], ['ok', 'Mute'], ['down', 'Back']]);
  assert.deepEqual(hints('outputs', 'output', d), [['ok', 'Use'], ['back', 'Back']]);
});

test('the spring overshoots a little, settles at 1, and is quick', () => {
  const { easing, ms } = spring(0.46, 0.7);
  const points = easing.slice('linear('.length, -1).split(', ').map(Number);
  assert.equal(points[0], 0);
  assert.equal(points.at(-1), 1);
  const peak = Math.max(...points);
  assert.ok(peak > 1.02 && peak < 1.1, `peak ${peak}`);
  assert.ok(ms > 300 && ms < 700, `${ms} ms`);
  // Critically damped would never overshoot; this one comes close to it.
  assert.ok(Math.max(...spring(0.46, 0.99).easing.slice(7, -1).split(', ').map(Number)) <= 1.0001);
});

test('a press Steam mirrors as a key counts once, in either order', () => {
  const seen = { lastPad: -Infinity, lastKey: { action: '', at: 0 } };
  // Key first, then the pad's own press: one press.
  assert.equal(counts(seen, 'ok', 'key', 10_000), true);
  assert.equal(counts(seen, 'ok', 'pad', 10_000 + MIRROR_MS - 1), false);
  // A second real press right after counts.
  assert.equal(counts(seen, 'ok', 'pad', 10_000 + MIRROR_MS + 50), true);
  // Pad first: keys are the mirror for a while, then count again.
  assert.equal(counts(seen, 'left', 'key', 10_400), false);
  assert.equal(counts(seen, 'left', 'key', 10_350 + PAD_KEEPS_MS + 1), true);
  // The mouse always counts.
  assert.equal(counts(seen, 'ok', 'mouse', 10_351), true);
});
