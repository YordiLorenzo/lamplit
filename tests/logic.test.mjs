// Unit tests for ui/logic.js, the page's pure functions. Needs nothing installed: `node --test tests/logic.test.mjs`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  batteryText,
  byPlayed,
  focusIndex,
  playedText,
  readable,
  rowKey,
  sectionRows,
  sectionSummary,
  stepAutoOff,
  storeWarning,
  visibleSections,
} from '../ui/logic.js';
import { ipc, known, like, values } from './fixtures.mjs';

const DAY = 86400;
/** A store app as Rust reports it. */
const store = (key, name, installed, account) =>
  like(ipc('stores')[0], { store: key, name, installed, running: false, account: known('account', account) });
const quiet = (state, active) => like(ipc('quiet'), { state: known('quiet_state', state), active, notes: [] });
const prefs = (changes) => like(ipc('prefs'), changes);
const setup = (needed) => like(ipc('setup'), { needed });
const overlays = (nvidia_overlay, nvidia_stats) => like(ipc('overlays'), { nvidia_overlay, nvidia_stats });

/** A Settings state with nothing loaded yet; tests fill in what they need. */
const settingsState = (extra = {}) => ({
  sound: null,
  accessories: null,
  quiet: null,
  setup: null,
  display: null,
  overlays: overlays(false, null),
  stores: new Map(),
  ...extra,
});

const { headset: headsetBase, controllers: [controllerBase] } = ipc('accessories');
/** The headset, on battery unless `extra` says otherwise. */
const headset = (extra = {}) =>
  like(headsetBase, { receiver: true, on: true, battery: 80, charge: known('charge', 'battery'), sidetone: 40, auto_off: 30, ...extra });

describe('readable', () => {
  test('keeps the hue and lifts a dark colour', () => {
    const [r, g, b] = readable([60, 0, 0]);
    assert.ok(r > g && r > b, `still red: ${[r, g, b]}`);
    assert.ok(r > 150, `lighter: ${r}`);
  });
  test('turns a grey into the neutral accent', () => {
    assert.deepEqual(readable([128, 128, 128]), [200, 206, 222]);
    assert.deepEqual(readable([0, 0, 0]), [200, 206, 222]);
  });
  test('keeps a green or blue colour on the same side of its hue', () => {
    // Green with a little blue leans to blue, and blue with a little green leans to green.
    const [r, g, b] = readable([0, 200, 40]);
    assert.ok(g > b && b > r, `green, leaning blue: ${[r, g, b]}`);
    const [r2, g2, b2] = readable([20, 40, 220]);
    assert.ok(b2 > g2 && g2 > r2, `blue, leaning green: ${[r2, g2, b2]}`);
  });
  test('gives whole numbers in range', () => {
    for (const rgb of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [12, 200, 180]]) {
      for (const v of readable(rgb)) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${rgb} -> ${v}`);
    }
  });
});

describe('playedText', () => {
  const now = 1_800_000_000;
  test('never played says nothing', () => assert.equal(playedText(0, now), ''));
  test('the day boundaries', () => {
    assert.equal(playedText(now - 60, now), 'Played today');
    assert.equal(playedText(now - DAY, now), 'Played yesterday');
    assert.equal(playedText(now - 2 * DAY, now), 'Played 2 days ago');
    assert.equal(playedText(now - 13 * DAY, now), 'Played 13 days ago');
    assert.equal(playedText(now - 14 * DAY, now), 'Played 2 weeks ago');
    assert.equal(playedText(now - 59 * DAY, now), 'Played 8 weeks ago');
    assert.equal(playedText(now - 60 * DAY, now), 'Played 2 months ago');
  });
  test('a clock that is behind still says today', () => assert.equal(playedText(now + 3600, now), 'Played today'));
});

describe('byPlayed', () => {
  test('sorts the names Rust sorts in tests/ipc/order.json the same way', () => {
    const { games, sorted } = ipc('order');
    assert.deepEqual(games.sort(byPlayed).map((g) => g.name), sorted);
  });
});

describe('storeWarning', () => {
  const stores = new Map([
    ['steam', store('steam', 'Steam', true, 'signed-in')],
    ['ea', store('ea', 'EA app', true, 'signed-out')],
    ['epic', store('epic', 'Epic Games Launcher', false, 'signed-out')],
  ]);
  const game = (requires) => ({ requires });
  test('no warning when every store app is ready', () => assert.equal(storeWarning(game(['steam']), stores), null));
  test('a store app that is not installed', () =>
    assert.equal(storeWarning(game(['epic']), stores), "Epic Games Launcher isn't installed"));
  test('a store app that needs a sign-in', () =>
    assert.equal(storeWarning(game(['steam', 'ea']), stores), 'EA app: sign in needed'));
  test('a store the list does not have yet is skipped', () => assert.equal(storeWarning(game(['xbox']), stores), null));
});

describe('batteryText', () => {
  test('unknown level', () => assert.equal(batteryText(null, null), 'Unknown'));
  test('on battery shows just the level', () => assert.equal(batteryText(40, 'battery'), '40%'));
  test('charging states are named', () => {
    assert.equal(batteryText(80, 'charging'), '80% · charging');
    assert.equal(batteryText(100, 'full'), '100% · full');
    assert.equal(batteryText(90, 'not-charging'), '90% · not charging');
  });
  test('every charge state Rust sends but the battery one is named', () => {
    for (const charge of values.charge.filter((c) => c !== 'battery')) assert.notEqual(batteryText(50, charge), '50%', charge);
  });
});

describe('stepAutoOff', () => {
  test('steps through the listed times', () => {
    assert.equal(stepAutoOff(30, 1), 60);
    assert.equal(stepAutoOff(30, -1), 20);
    assert.equal(stepAutoOff(5, -1), 0);
  });
  test('stays put at either end', () => {
    assert.equal(stepAutoOff(60, 1), 60);
    assert.equal(stepAutoOff(0, -1), 0);
  });
  test('a time missing from the list steps to the nearest one on the side pressed', () => {
    assert.equal(stepAutoOff(45, 1), 60);
    assert.equal(stepAutoOff(45, -1), 30);
    assert.equal(stepAutoOff(90, -1), 60);
  });
});

describe('Settings sections', () => {
  const keys = (state) => visibleSections(state).map((s) => s.key);
  test('the Headset section shows only with its receiver plugged in', () => {
    assert.ok(!keys(settingsState()).includes('headset'));
    const unplugged = { headset: headset({ receiver: false }), controllers: [] };
    assert.ok(!keys(settingsState({ accessories: unplugged })).includes('headset'));
    assert.ok(keys(settingsState({ accessories: { headset: headset(), controllers: [] } })).includes('headset'));
  });
  test('the Headset section names the supported model', () => {
    const rows = sectionRows('headset', settingsState({ accessories: { headset: headset(), controllers: [] } }));
    assert.equal(rows[0].heading, 'Logitech PRO X 2 LIGHTSPEED');
    assert.deepEqual(
      rows.filter((r) => r.adjust).map((r) => [r.kind, r.value]),
      [['sidetone', '40%'], ['autooff', '30 min']]
    );
  });
  test('the headset says whether Lamplit knows it is on', () => {
    const value = (on) => sectionRows('headset', settingsState({ accessories: { headset: headset({ on }), controllers: [] } }))[1].value;
    assert.equal(value(null), 'Checking…');
    assert.equal(value(false), 'Off');
    assert.equal(value(true), 'On');
  });
  test('a low headset battery warns only while on battery', () => {
    const summary = (h) => sectionSummary('headset', settingsState({ accessories: { headset: h, controllers: [] } }));
    assert.deepEqual(summary(headset({ battery: 10 })), ['On · 10%', 'warn']);
    assert.deepEqual(summary(headset({ battery: 10, charge: known('charge', 'charging') })), ['On · 10% · charging', 'good']);
  });
});

describe('Controllers', () => {
  const pad = (bluetooth, status) => like(controllerBase, { id: bluetooth ? 'bt' : 'usb', bluetooth, status });
  const status = (charge, headphones) => like(controllerBase.status, { battery: 60, charge: known('charge', charge), headphones });
  const rows = (...controllers) => sectionRows('controllers', settingsState({ accessories: { headset: headset(), controllers } }));
  const row = (list, label) => list.find((r) => r.label === label);
  test('headphones in a Bluetooth controller get no sound, and say so', () => {
    const list = rows(pad(true, status('battery', true)));
    assert.deepEqual(row(list, 'Headphones'), { label: 'Headphones', value: 'Plugged in · sound needs the USB cable', tone: 'warn' });
    assert.ok(list.some((r) => r.kind === 'padoff'));
  });
  test('a controller that reports no status', () => {
    assert.equal(row(rows(pad(true, null)), 'Battery').value, 'Not reported over this link');
  });
  test('a controller on a cable can only be unplugged, not turned off', () => {
    const list = rows(pad(false, status('charging', true)));
    assert.deepEqual(row(list, 'Headphones'), { label: 'Headphones', value: 'Plugged in', tone: '' });
    assert.ok(!list.some((r) => r.kind === 'padoff'));
  });
});

describe('Sound and System summaries', () => {
  const sound = ipc('sound');
  const device = (name) => like(sound.outputs[0], { id: name, windows_name: name, name, kind: 'tv', default: true });
  test('a muted output says so', () => {
    const muted = like(sound, { outputs: [device('TV')], inputs: [], volume: 40, muted: true });
    assert.deepEqual(sectionSummary('sound', settingsState({ sound: muted })), ['TV · muted']);
    assert.deepEqual(sectionSummary('sound', settingsState({ sound: { ...muted, muted: false } })), ['TV · 40%']);
  });
  test('setup that is needed warns, else the display shows', () => {
    assert.deepEqual(sectionSummary('system', settingsState({ setup: setup(true), display: '1920 × 1080 at 60 Hz' })), ['Setup needed', 'warn']);
    assert.deepEqual(sectionSummary('system', settingsState({ setup: setup(false), display: '1920 × 1080 at 60 Hz' })), ['1920 × 1080 at 60 Hz']);
  });
  test('System offers setup only while it is needed, and the art switch always', () => {
    const kinds = (needed) => sectionRows('system', settingsState({ setup: setup(needed), prefs: prefs({ online_art: true }) })).map((r) => r.kind);
    assert.deepEqual(kinds(true), ['setup', 'onlineart', undefined]);
    assert.deepEqual(kinds(false), ['onlineart', undefined]);
  });
});

describe('Overlay and pop-ups', () => {
  test('without the NVIDIA overlay the stats row is only information', () => {
    const state = settingsState({ quiet: quiet('on', true) });
    const stats = sectionRows('popups', state)[0];
    assert.equal(stats.kind, undefined);
    assert.equal(stats.value, 'Not available');
    assert.deepEqual(sectionSummary('popups', state), ['Quiet']);
  });
  test('with the overlay the stats row can be switched', () => {
    const state = settingsState({ overlays: overlays(true, false), quiet: quiet('off', false) });
    assert.equal(sectionRows('popups', state)[0].kind, 'stats');
    assert.deepEqual(sectionSummary('popups', state), ['Stats off · pop-ups on']);
  });
  test("an overlay whose state the log doesn't tell can still be switched", () => {
    const stats = sectionRows('popups', settingsState({ overlays: overlays(true, null), quiet: quiet('off', false) }))[0];
    assert.deepEqual([stats.kind, stats.value], ['stats', 'Unknown']);
  });
  test('every quiet state Rust sends is named, in the row and the summary', () => {
    for (const state of values.quiet_state) {
      const shown = settingsState({ quiet: quiet(state, state !== 'off') });
      assert.notEqual(sectionRows('popups', shown).find((r) => r.kind === 'quiet').value, '…', state);
      assert.notEqual(sectionSummary('popups', shown)[0], '…', state);
    }
  });
});

describe('Stores', () => {
  // Rust sends every store, installed or not, as on a PC without store apps here. The Xbox store counts as there:
  // its games start without an app.
  const none = [
    store('steam', 'Steam', false, 'signed-out'),
    store('epic', 'Epic Games Launcher', false, 'signed-out'),
    store('ea', 'EA app', false, 'signed-out'),
    store('ubisoft', 'Ubisoft Connect', false, 'signed-out'),
    store('rockstar', 'Rockstar Games Launcher', false, 'signed-out'),
    store('gog', 'GOG Galaxy', false, 'unknown'),
    store('xbox', 'Xbox app', true, 'unknown'),
  ];
  /** Rust's list, with these stores as given. */
  const withStores = (...list) => settingsState({ stores: new Map([...none, ...list].map((s) => [s.store, s])) });
  test('no store app installed says so, in the summary and the section', () => {
    const state = withStores();
    assert.deepEqual(sectionSummary('stores', state), ['No store apps']);
    assert.deepEqual(sectionRows('stores', state), [{ label: 'No store apps found', value: '' }]);
  });
  test('a signed-out store app warns', () => {
    const state = withStores(store('steam', 'Steam', true, 'signed-in'), store('ea', 'EA app', true, 'signed-out'));
    assert.deepEqual(sectionSummary('stores', state), ['EA app: sign in', 'warn']);
  });
  test('all signed in, with stores that report no account left out', () => {
    const state = withStores(store('steam', 'Steam', true, 'signed-in'), store('gog', 'GOG Galaxy', true, 'unknown'));
    assert.deepEqual(sectionSummary('stores', state), ['All signed in', 'good']);
  });
  test("Steam's DevTools port can be switched only with Steam installed, and warns what it allows", () => {
    const steam = (installed) => withStores(store('steam', 'Steam', installed, 'signed-in'));
    const port = (state) => sectionRows('stores', { ...state, prefs: prefs({ steam_devtools: false }) });
    const rows = port(steam(true));
    assert.equal(rows.find((r) => r.kind === 'steamport')?.value, 'Off');
    assert.ok(rows.some((r) => r.label?.includes('any program on this PC can control Steam')));
    assert.ok(!port(steam(false)).some((r) => r.kind === 'steamport'));
  });
  test('a saved sign-in or an unknown account is not called signed in', () => {
    const remembered = withStores(store('epic', 'Epic Games Launcher', true, 'remembered'));
    assert.deepEqual(sectionSummary('stores', remembered), ['1 installed']);
    const unknown = withStores(store('gog', 'GOG Galaxy', true, 'unknown'));
    assert.deepEqual(sectionSummary('stores', unknown), ['1 installed']);
  });
  test('every account Rust reports is named, but the one no store keeps', () => {
    for (const account of values.account.filter((a) => a !== 'unknown')) {
      const [row] = sectionRows('stores', withStores(store('ea', 'EA app', true, account)));
      assert.ok(!['Running', 'Not running'].includes(row.value), account);
    }
  });
});

describe('focus in Settings', () => {
  const rows = [
    { heading: 'Output' },
    { kind: 'device', id: 'tv', label: 'TV' },
    { kind: 'volume', adjust: true, label: 'Volume' },
    { label: 'Display' },
    { kind: 'store', store: 'steam', label: 'Steam' },
    { kind: 'section', key: 'sound', label: 'Sound' },
  ];
  test('a row key names what the row is about', () => {
    assert.equal(rowKey(rows[1]), 'device:tv');
    assert.equal(rowKey(rows[2]), 'volume:');
    assert.equal(rowKey(rows[4]), 'store:steam');
    assert.equal(rowKey(rows[5]), 'section:sound');
  });
  test('focus follows its row when rows are added above it', () => {
    const shifted = [rows[0], { kind: 'device', id: 'hs', label: 'Headset' }, ...rows.slice(1)];
    assert.equal(focusIndex(rows, 'volume:'), 2);
    assert.equal(focusIndex(shifted, 'volume:'), 3);
  });
  test('without that row, the first focusable row', () => {
    assert.equal(focusIndex(rows, null), 1);
    assert.equal(focusIndex(rows, 'padoff:gone'), 1);
  });
  test('nothing to focus', () => assert.equal(focusIndex([{ heading: 'x' }, { label: 'y' }], null), -1));
});
