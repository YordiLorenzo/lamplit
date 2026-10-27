// The pure functions of the in-game dock's page (ui/dock/logic.js), in Node: `node --test tests/dock-logic.test.mjs`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chips, counts, hints, MIRROR_MS, PAD_KEEPS_MS, spring, tiles, volumeText } from '../ui/dock/logic.js';
import { ipc, known, like } from './fixtures.mjs';

/** What the dock knows, as Rust sends it, with some parts changed. */
const data = (changes = {}) => ({
  game: ipc('dock-game'),
  sound: ipc('sound'),
  accessories: ipc('accessories'),
  quiet: ipc('quiet'),
  overlays: ipc('overlays'),
  confirm: false,
  ...changes,
});
const keys = (d) => tiles(d).map((t) => t.key);

describe('the tiles', () => {
  test('Resume first, then output, quiet mode, stats, Home and closing the game', () => {
    assert.deepEqual(keys(data()), ['resume', 'output', 'quiet', 'stats', 'home', 'close']);
  });

  test('stats only with NVIDIA\'s overlay, and no Close game without a game', () => {
    const d = data({ overlays: like(ipc('overlays'), { nvidia_overlay: false, nvidia_stats: null }), game: null });
    assert.deepEqual(keys(d), ['resume', 'output', 'quiet', 'home']);
  });

  test('the output shows the device in use, with its icon', () => {
    const output = tiles(data()).find((t) => t.key === 'output');
    assert.equal(output.value, 'TV');
    assert.equal(output.icon, 'tv');
    const nothing = tiles(data({ sound: null })).find((t) => t.key === 'output');
    assert.equal(nothing.value, '…');
    assert.equal(nothing.icon, 'speaker');
  });

  test('quiet mode and the stats say their state', () => {
    const quiet = (state) => tiles(data({ quiet: like(ipc('quiet'), { state: known('quiet_state', state) }) })).find((t) => t.key === 'quiet');
    assert.deepEqual([quiet('on').value, quiet('on').tone], ['On', 'good']);
    assert.deepEqual([quiet('partly').value, quiet('partly').tone], ['Partly on', 'warn']);
    assert.equal(quiet('off').value, 'Off');
    const stats = (on) => tiles(data({ overlays: like(ipc('overlays'), { nvidia_stats: on }) })).find((t) => t.key === 'stats').value;
    assert.deepEqual([stats(true), stats(false), stats(null)], ['On', 'Off', 'Unknown']);
  });

  test('closing a game: asked once, then again; a game that hangs is force closed', () => {
    const close = (changes) => tiles(data(changes)).find((t) => t.key === 'close');
    const responding = like(ipc('dock-game'), { responding: true, force_close: false });
    assert.deepEqual([close({ game: responding }).label, close({ game: responding }).value], ['Close game', '']);
    assert.deepEqual([close({ game: responding, confirm: true }).value, close({ game: responding, confirm: true }).tone], ['Press again', 'warn']);
    // The fixture's game isn't responding.
    assert.deepEqual([close({}).label, close({}).value, close({}).tone], ['Force close', 'Not responding', 'warn']);
    // Asked to close a while ago and still running, though it responds.
    const stuck = like(ipc('dock-game'), { responding: true, force_close: true });
    assert.deepEqual([close({ game: stuck }).label, close({ game: stuck }).value], ['Force close', '']);
  });
});

test('the volume reads as a percent, or Muted', () => {
  assert.equal(volumeText(ipc('sound')), '45%');
  assert.equal(volumeText(like(ipc('sound'), { muted: true })), 'Muted');
  assert.equal(volumeText(null), '…');
  assert.equal(volumeText(like(ipc('sound'), { volume: null })), '…');
});

test('the top line has each battery, low ones marked', () => {
  const acc = ipc('accessories');
  assert.deepEqual(chips(acc), [
    { icon: 'controller', text: '60%', tone: '' },
    { icon: 'controller', text: 'Medium', tone: '' },
    { icon: 'headset', text: '80%', tone: '' },
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
  assert.deepEqual(chips(quiet), [{ icon: 'controller', text: '5%', tone: '' }]);
  assert.deepEqual(chips(null), []);
});

test('the hints say what the buttons do where the focus is', () => {
  const d = data({ quiet: like(ipc('quiet'), { active: false }) });
  assert.deepEqual(hints('tiles', 'resume', d), [['ok', 'Resume']]);
  assert.deepEqual(hints('tiles', 'quiet', d), [['ok', 'Turn on'], ['back', 'Back to game']]);
  assert.deepEqual(hints('tiles', 'close', data({ confirm: true }))[0], ['ok', 'Force close now']);
  assert.deepEqual(hints('volume', 'resume', d), [['adjust', 'Volume'], ['ok', 'Mute'], ['back', 'Back to game']]);
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
