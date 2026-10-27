// Unit tests for ui/logic.js, the page's pure functions. Needs nothing installed: `node --test tests/logic.test.mjs`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MIRROR_MS,
  PAD_KEEPS_MS,
  STORE_ORDER,
  batteryText,
  buttonFace,
  byName,
  byPlayed,
  counts,
  detailChoices,
  focusIndex,
  folderParts,
  liftLayout,
  matcher,
  nameAfter,
  narrowed,
  nearest,
  nothingSeen,
  padBatteryText,
  playTimeText,
  playedText,
  quietMode,
  readable,
  rowKey,
  rowOf,
  sectionRows,
  sectionSummary,
  spring,
  stepAutoOff,
  stepSaverMinutes,
  storeChoices,
  storeWarning,
  typed,
  visibleSections,
  words,
} from '../ui/logic.js';
import { pageValues } from './contract.mjs';
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
  all: [],
  running: null,
  settings: { section: null, focus: null, idx: 0, rows: [], confirm: null },
  ...extra,
});
/** A game as Rust sends it. */
const game = (id, name, changes = {}) =>
  like(ipc('games')[0], { id, name, last_played: 0, play_minutes: 0, favourite: false, hidden: false, ...changes });

const { headset: headsetBase, controllers: [controllerBase, xboxBase] } = ipc('accessories');
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

describe('playTimeText', () => {
  test('nothing under a minute', () => {
    assert.equal(playTimeText(0), '');
    assert.equal(playTimeText(0, true), '');
  });
  test('minutes up to an hour', () => assert.equal(playTimeText(59), '59 min'));
  test('whole hours on the home screen, hours and minutes in Details', () => {
    assert.equal(playTimeText(754), '12 h');
    assert.equal(playTimeText(754, true), '12 h 34 min');
    assert.equal(playTimeText(120, true), '2 h');
  });
});

describe('byPlayed', () => {
  test('sorts the names Rust sorts in tests/ipc/order.json the same way', () => {
    const { games, sorted } = ipc('order');
    assert.deepEqual(games.sort(byPlayed).map((g) => g.name), sorted);
  });
});

describe('favourites and hidden games in the row', () => {
  const names = (list) => rowOf(list, { query: '', store: null, sort: 'played' }).map((g) => g.name);
  test('favourites come first, each group in the order given', () => {
    const list = [game('a', 'A'), game('b', 'B', { favourite: true }), game('c', 'C'), game('d', 'D', { favourite: true })];
    assert.deepEqual(names(list), ['B', 'D', 'A', 'C']);
  });
  test('hidden games are left out, favourite or not', () => {
    const list = [game('a', 'A', { hidden: true }), game('b', 'B', { favourite: true, hidden: true }), game('c', 'C')];
    assert.deepEqual(names(list), ['C']);
  });
});

describe('detailChoices', () => {
  const labels = (g, running = null, removing = false) => detailChoices(g, running, removing).map((c) => c.label);
  test('Play first, then favourites, art and hiding', () => {
    assert.deepEqual(labels(game('a', 'A')), ['Play', 'Add to favourites', 'Change art', 'Hide this game']);
    assert.deepEqual(labels(game('a', 'A', { favourite: true })), ['Play', 'Remove from favourites', 'Change art', 'Hide this game']);
  });
  test('the running game goes back to the game', () => assert.equal(labels(game('a', 'A'), 'a')[0], 'Back to game'));
  test('a game added by hand can be removed, after ✕ once asks', () => {
    const added = game('manual:x', 'X', { manual: true });
    assert.equal(labels(added).at(-1), 'Remove from Lamplit');
    assert.equal(labels(added, null, true).at(-1), 'Press again to remove');
    assert.equal(detailChoices(added, null).at(-1).kind, 'remove');
  });
});

describe('folderParts', () => {
  test('the path to a folder, and its own name, which the game menu shows on a line of its own', () => {
    assert.deepEqual(folderParts('C:\\Program Files\\WindowsApps\\Tomb_1.0'), ['C:\\Program Files\\WindowsApps\\', 'Tomb_1.0']);
    assert.deepEqual(folderParts('D:\\Games\\Racer\\'), ['D:\\Games\\', 'Racer']);
    assert.deepEqual(folderParts('Racer'), ['', 'Racer']);
  });
});

describe('the lifted game menu', () => {
  test('the lift springs past its place and settles back; the way down only settles', () => {
    const stops = (s) => s.easing.match(/^linear\((.*)\)$/)[1].split(', ').map(Number);
    const up = spring(210, 22);
    const down = spring(500, 45);
    for (const s of [up, down]) {
      const p = stops(s);
      assert.deepEqual([p[0], p.at(-1)], [0, 1]);
      assert.ok(s.ms > 300 && s.ms < 800, `${s.ms} ms`);
    }
    const peak = Math.max(...stops(up));
    assert.ok(peak > 1.01 && peak < 1.05, `overshoot ${peak}`);
    assert.ok(Math.max(...stops(down)) <= 1, 'no overshoot on the way down');
    // Most of the way in the first quarter, so it reads as quick.
    assert.ok(stops(down)[10] > 0.7, String(stops(down)[10]));
  });

  const screen = { width: 1920, height: 1080 };
  // The focused cover in the row, at 1080p: in the first slot, grown by 1.14.
  const cover = { x: 96, y: 1080 * 0.88 - 369.36, width: 246.24, height: 369.36 };
  test('the cover grows over its column and rises to the middle; the menu opens beside it', () => {
    const { card, menu, side } = liftLayout(cover, screen, 650);
    assert.equal(side, 1);
    assert.ok(Math.abs(card.width / card.height - cover.width / cover.height) < 1e-9, 'keeps the cover\'s shape');
    assert.ok(card.height > cover.height * 1.5, `${card.height}`);
    assert.ok(card.y + card.height / 2 < cover.y + cover.height / 2 - 100, 'rises');
    assert.ok(card.x >= 96 && menu.x >= card.x + card.width && menu.x + menu.width <= 1920 - 96, JSON.stringify({ card, menu }));
    assert.equal(menu.width, 650);
  });
  test('near the right edge, the menu opens on the left', () => {
    const { card, menu, side } = liftLayout({ ...cover, x: 1600 }, screen, 650);
    assert.equal(side, -1);
    assert.ok(card.x + card.width <= 1920 - 96, 'the card stays inside the safe area');
    assert.ok(menu.x >= 96 && menu.x + menu.width <= card.x, JSON.stringify({ card, menu }));
  });
  test('with room on neither side for the whole menu, it takes the roomier side, narrowed', () => {
    const narrow = { width: 1000, height: 1080 };
    const { card, menu, side } = liftLayout({ ...cover, x: 300 }, narrow, 650);
    assert.equal(side, 1);
    assert.equal(menu.width, menu.room);
    assert.ok(menu.x + menu.width <= 1000 - 50 + 1e-9 && menu.x >= card.x + card.width, JSON.stringify({ card, menu }));
  });
});

describe('finding a game', () => {
  const finds = (query, name) => matcher(query)(name);
  /** A game as Rust sends it. */
  const game = (name, store, last_played = 0) => like(ipc('games')[0], { id: name, name, store, last_played });
  const all = { query: '', store: null, sort: 'played' };

  test('words: lower case, no accents, apostrophes dropped, other punctuation splits', () => {
    assert.deepEqual(words("Tom Clancy's Ghost Recon®: Wildlands"), ['tom', 'clancys', 'ghost', 'recon', 'wildlands']);
    assert.deepEqual(words('Half-Life 2'), ['half', 'life', '2']);
    assert.deepEqual(words('Ōkami HD'), ['okami', 'hd']);
    assert.deepEqual(words('  ...  '), []);
  });
  test('the start of any word, in any case', () => {
    for (const q of ['red', 'Dead', 'REDEMPTION', '2', 'red dead', 'dead red']) assert.ok(finds(q, 'Red Dead Redemption 2'), q);
  });
  test('initials and runs of word starts', () => {
    for (const q of ['rdr', 'rdr2', 'reddead', 'rdredemption']) assert.ok(finds(q, 'Red Dead Redemption 2'), q);
    assert.ok(finds('tlou', 'The Last of Us Part I'));
    assert.ok(finds('fc26', 'EA SPORTS FC 26'));
    assert.ok(finds('ac', "Assassin's Creed Mirage"), 'the apostrophe leaves the s on its word');
  });
  test('punctuation and accents in the name or the search are ignored', () => {
    assert.ok(finds('cities skylines', 'Cities: Skylines II'));
    assert.ok(finds('halflife', 'Half-Life 2'));
    assert.ok(finds('life', 'Half-Life 2'));
    assert.ok(finds('clancys', "Tom Clancy's Ghost Recon Wildlands"));
    assert.ok(finds("clancy's", "Tom Clancy's Ghost Recon Wildlands"));
    assert.ok(finds('okami', 'Ōkami HD'));
    assert.ok(finds('skate', 'skate.'));
  });
  test('not the middle of a word, and every word of the search counts', () => {
    assert.ok(!finds('edemption', 'Red Dead Redemption 2'));
    assert.ok(!finds('tf2', 'Titanfall 2'), 'f is inside titanfall');
    assert.ok(!finds('red zebra', 'Red Dead Redemption 2'));
    assert.ok(!finds('rdx', 'Red Dead Redemption 2'));
  });
  test('an empty search, or one of spaces, finds everything', () => {
    assert.ok(finds('', 'Anything'));
    assert.ok(finds('   ', 'Anything'));
  });

  const library = [
    game('Zuma', 'steam', 0),
    game('Red Dead Redemption 2', 'rockstar', 50),
    game('Game 10', null, 0),
    game('Édith Finch', 'epic', 0),
    game('Game 2', null, 0),
    game('Portal 2', 'steam', 90),
  ];
  const names = (find) => rowOf(library, { ...all, ...find }).map((g) => g.name);
  test('the row by default is the order Rust sends', () => {
    assert.deepEqual(names({}), [...library].sort(byPlayed).map((g) => g.name));
    assert.deepEqual(names({}).slice(0, 2), ['Portal 2', 'Red Dead Redemption 2']);
  });
  test('A to Z ignores accents and puts numbers in number order', () => {
    assert.deepEqual(names({ sort: 'name' }), ['Édith Finch', 'Game 2', 'Game 10', 'Portal 2', 'Red Dead Redemption 2', 'Zuma']);
    assert.equal(byName(game('portal', null), game('Portal', null)), 0);
  });
  test('the store filter, with pc for games outside any store', () => {
    assert.deepEqual(names({ store: 'steam' }), ['Portal 2', 'Zuma']);
    assert.deepEqual(names({ store: 'pc', sort: 'name' }), ['Game 2', 'Game 10']);
    assert.deepEqual(names({ store: 'xbox' }), []);
  });
  test('search, store and sort together', () => {
    assert.deepEqual(names({ query: 'g', store: 'pc', sort: 'name' }), ['Game 2', 'Game 10']);
    assert.deepEqual(names({ query: '2' }), ['Portal 2', 'Red Dead Redemption 2', 'Game 2']);
  });
  test('the row is narrowed by a search or a store, not by the sort', () => {
    assert.ok(!narrowed(all));
    assert.ok(!narrowed({ ...all, sort: 'name' }));
    assert.ok(!narrowed({ ...all, query: '  ' }));
    assert.ok(narrowed({ ...all, query: 'r' }));
    assert.ok(narrowed({ ...all, store: 'pc' }));
  });

  test('the store choices: All, then the stores with games, in Rust order, PC last', () => {
    assert.deepEqual(storeChoices(library, null), [null, 'steam', 'epic', 'rockstar', 'pc']);
    assert.deepEqual(storeChoices([], null), [null]);
  });
  test('the chosen store stays a choice after its games have gone', () => {
    assert.deepEqual(storeChoices(library, 'xbox'), [null, 'steam', 'epic', 'rockstar', 'xbox', 'pc']);
  });
  test('every store the page knows has its place in the choices', () => {
    assert.deepEqual([...STORE_ORDER].sort(), [...pageValues('StoreKey'), 'pc'].sort());
  });

  test('typing: letters add on, delete takes the last one off', () => {
    assert.equal(typed('rd', 'r'), 'rdr');
    assert.equal(typed('rdr', 'delete'), 'rd');
    assert.equal(typed('', 'delete'), '');
  });
  test('a space only goes between words', () => {
    assert.equal(typed('red', 'space'), 'red ');
    assert.equal(typed('red ', 'space'), 'red ');
    assert.equal(typed('', 'space'), '');
  });
  test('the search stops growing at 30 characters', () => {
    const long = 'a'.repeat(30);
    assert.equal(typed(long, 'b'), long);
    assert.equal(typed(long, 'space'), long);
    assert.equal(typed(long, 'delete').length, 29);
    assert.equal(typed(long, 'b', 40), `${long}b`);
  });

  describe('typing a name', () => {
    /** Types `keys` from an empty name, as the names keyboard does. */
    const type = (keys, max = 40) => keys.reduce((n, k) => nameAfter(n, k, max), { text: '', caps: true });
    const letters = (word) => [...word];
    test('each word starts with a capital', () => {
      assert.deepEqual(type([...letters('far'), 'space', ...letters('cry'), 'space', '6']), { text: 'Far Cry 6', caps: true });
    });
    test('Shift turns a capital off, or on for the next letter', () => {
      const name = type([...letters('call'), 'space', 'shift', ...letters('of'), 'space', ...letters('duty')]);
      assert.equal(name.text, 'Call of Duty');
      assert.equal(type([...letters('half'), '-', 'shift', ...letters('life')]).text, 'Half-Life');
    });
    test('delete and clear, and the capital they leave', () => {
      assert.deepEqual(type([...letters('ab'), 'space', 'delete']), { text: 'Ab', caps: false });
      assert.deepEqual(type([...letters('ab'), 'space', 'c', 'delete']), { text: 'Ab ', caps: true });
      assert.deepEqual(type([...letters('ab'), 'clear']), { text: '', caps: true });
    });
    test('signs and digits leave the capital as it was, and the name stops at its length', () => {
      assert.deepEqual(type(['shift', ':', 'x']), { text: ':x', caps: false });
      assert.equal(type(letters('abcdef'), 4).text, 'Abcd');
    });
  });

  describe('moving in rows', () => {
    // Three keys in a row, a wide key under the first two, and choices of different widths that wrap onto a second
    // line below that.
    const box = (x, y, width = 60, height = 60) => ({ x, y, width, height });
    const boxes = [
      box(0, 0), box(70, 0), box(140, 0), // 0 1 2
      box(0, 70, 120), // 3: wide
      box(0, 160, 40, 40), box(110, 160, 100, 40), // 4 5: choices, first line
      box(40, 210, 60, 40), // 6: second line
    ];
    const go = (from, dir) => nearest(boxes[from], boxes, dir);
    test('left and right stay in the row, and stop at its ends', () => {
      assert.equal(go(0, 'right'), 1);
      assert.equal(go(2, 'left'), 1);
      assert.equal(go(2, 'right'), -1);
      assert.equal(go(3, 'right'), -1);
      assert.equal(go(5, 'right'), -1, 'not on to the second line');
    });
    test('up and down go to the next row, onto the box nearest to the side', () => {
      assert.equal(go(2, 'down'), 3);
      assert.equal(go(1, 'down'), 3);
      assert.equal(go(3, 'up'), 0);
      assert.equal(go(5, 'down'), 6);
      assert.equal(go(0, 'up'), -1);
      assert.equal(go(6, 'down'), -1);
    });
    test('a line of choices is not skipped for a box further on that sits more in line', () => {
      // Box 6 is almost straight below box 3 and box 4 a little to the side, but box 4's line comes first.
      assert.equal(go(3, 'down'), 4);
      assert.equal(go(6, 'up'), 4);
    });
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

describe('padBatteryText', () => {
  const [dualsense, xbox] = ipc('accessories').controllers;
  test('a percent, with the charge state', () => assert.equal(padBatteryText(dualsense.battery), '60%'));
  test('a rough level from an Xbox-style controller', () => assert.equal(padBatteryText(xbox.battery), 'Medium'));
  test('every level Rust sends is named', () => {
    for (const level of values.battery_level) {
      assert.notEqual(padBatteryText(like(xbox.battery, { level })), 'Unknown', level);
    }
  });
  test('none reported', () => assert.equal(padBatteryText(null), 'Not reported over this link'));
});

describe('buttonFace', () => {
  test('PlayStation controllers show their symbols, every other kind the Xbox letters', () => {
    const faces = Object.fromEntries(values.pad_kind.map((kind) => [kind, buttonFace(kind, 'ok')[1]]));
    assert.deepEqual(faces, { dualsense: '✕', playstation: '✕', xbox: 'A', other: 'A' });
    assert.deepEqual(['back', 'triangle', 'square', 'menu'].map((b) => buttonFace('xbox', b)[1]), ['B', 'Y', 'X', '≡']);
    assert.deepEqual(['back', 'triangle', 'square', 'menu'].map((b) => buttonFace('dualsense', b)[1]), ['○', '△', '□', '≡']);
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
  /** A DualSense, with its battery and jack once a full report came (`headphones` not null). */
  const pad = (bluetooth, headphones, charge = 'battery') =>
    like(controllerBase, {
      id: bluetooth ? 'bt' : 'usb',
      connection: known('connection', bluetooth ? 'bluetooth' : 'usb'),
      battery: headphones === null ? null : like(controllerBase.battery, { percent: 60, charge: known('charge', charge) }),
      headphones,
    });
  const xbox = (connection, level) =>
    like(xboxBase, { connection: known('connection', connection), battery: level && like(xboxBase.battery, { level: known('battery_level', level) }) });
  const state = (...controllers) => settingsState({ accessories: { headset: headset(), controllers } });
  const rows = (...controllers) => sectionRows('controllers', state(...controllers));
  const row = (list, label) => list.find((r) => r.label === label);
  test('headphones in a Bluetooth controller get no sound, and say so', () => {
    const list = rows(pad(true, true));
    assert.deepEqual(row(list, 'Headphones'), { label: 'Headphones', value: 'Plugged in · sound needs the USB cable', tone: 'warn' });
    assert.ok(list.some((r) => r.kind === 'padoff'));
  });
  test('a controller that reports no status', () => {
    assert.equal(row(rows(pad(true, null)), 'Battery').value, 'Not reported over this link');
  });
  test('a controller on a cable can only be unplugged, not turned off', () => {
    const list = rows(pad(false, true, 'charging'));
    assert.deepEqual(row(list, 'Headphones'), { label: 'Headphones', value: 'Plugged in', tone: '' });
    assert.ok(!list.some((r) => r.kind === 'padoff'));
  });
  test('each controller is headed with its name and connection', () => {
    const headings = rows(pad(true, false), xbox('wireless', 'low'), xbox('usb', null)).filter((r) => r.heading).map((r) => r.heading);
    assert.deepEqual(headings, [
      'Controller 1 · DualSense · Bluetooth',
      'Controller 2 · Xbox controller · Wireless',
      'Controller 3 · Xbox controller · USB cable',
    ]);
  });
  test('an Xbox-style controller has a battery row only, and no touchpad switch on its own', () => {
    const list = rows(xbox('wireless', 'low'));
    assert.deepEqual(list.filter((r) => !r.heading), [{ label: 'Battery', value: 'Low' }]);
    assert.ok(rows(xbox('usb', null), pad(false, false)).some((r) => r.kind === 'touchmouse'));
    assert.ok(rows().some((r) => r.kind === 'touchmouse'));
  });
  test('the summary gives each battery', () => {
    assert.deepEqual(sectionSummary('controllers', state(pad(true, false), xbox('wireless', 'medium'), xbox('usb', null))), ['3 connected · 60%, medium, ?']);
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
  test("the quiet row follows the player's switch, and says when Windows stays quiet on its own", () => {
    const row = (state, active) => {
      const r = sectionRows('popups', settingsState({ quiet: quiet(state, active) })).find((r) => r.kind === 'quiet');
      return [r.value, r.tone];
    };
    assert.deepEqual(row('on', true), ['On', 'good']);
    assert.deepEqual(row('partly', true), ['On · some pop-ups still show', 'warn']);
    assert.deepEqual(row('off', false), ['Off', '']);
    assert.deepEqual(row('on', false), ['Off · Windows is quiet on its own', '']);
    assert.deepEqual(row('partly', false), ['Off · some pop-ups are off in Windows', '']);
    // Only switching off over a quiet Windows has something to explain.
    assert.equal(quietMode(quiet('off', false)).note, '');
    assert.match(quietMode(quiet('on', false)).note, /already quiet/);
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
    store('battlenet', 'Battle.net', false, 'signed-out'),
    store('gog', 'GOG Galaxy', false, 'unknown'),
    store('amazon', 'Amazon Games', false, 'unknown'),
    store('itch', 'itch.io', false, 'unknown'),
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

describe('Hidden games', () => {
  const library = [game('z', 'Zuma', { hidden: true }), game('t', 'Tool, not a game', { hidden: true }), game('p', 'Portal 2')];
  test('the section shows only while a game is hidden', () => {
    const keys = (state) => visibleSections(state).map((s) => s.key);
    assert.ok(!keys(settingsState({ all: [game('p', 'Portal 2')] })).includes('hidden'));
    assert.ok(keys(settingsState({ all: library })).includes('hidden'));
  });
  test('the summary counts them', () => {
    assert.deepEqual(sectionSummary('hidden', settingsState({ all: library })), ['2 games']);
    assert.deepEqual(sectionSummary('hidden', settingsState({ all: library.slice(1) })), ['1 game']);
  });
  test('each one can be shown again, by name', () => {
    const rows = sectionRows('hidden', settingsState({ all: library }));
    assert.deepEqual(rows.map((r) => [r.kind, r.id, r.label, r.value]), [['unhide', 't', 'Tool, not a game', 'Show'], ['unhide', 'z', 'Zuma', 'Show']]);
  });
  test('after the last one is shown again, the open section says so', () =>
    assert.deepEqual(sectionRows('hidden', settingsState()), [{ label: 'No hidden games', value: '' }]));
});

describe('Power', () => {
  const library = [game('cp', 'Cyberpunk 2077')];
  /** The rows with ✕ pressed once on `confirm`, while `running` runs. */
  const rows = (confirm, running = null) =>
    sectionRows('power', settingsState({ all: library, running, settings: { section: 'power', focus: null, idx: 0, rows: [], confirm } }));
  test('Add a game is there with or without games, before Hidden games', () => {
    const keys = (state) => visibleSections(state).map((s) => s.key);
    assert.ok(keys(settingsState()).includes('add'));
    assert.deepEqual(keys(settingsState({ all: [game('h', 'H', { hidden: true })] })).slice(-3), ['add', 'hidden', 'power']);
    assert.deepEqual(sectionSummary('add', settingsState()), ['A program or an exe on this PC']);
  });
  test('Power is the last section, always there', () => {
    assert.equal(visibleSections(settingsState()).at(-1).key, 'power');
    assert.deepEqual(rows(null).map((r) => [r.kind, r.id, r.label, r.value]), [
      ['power', 'sleep', 'Sleep', ''],
      ['power', 'restart', 'Restart', ''],
      ['power', 'shutdown', 'Shut down', ''],
    ]);
  });
  test('✕ once asks to confirm, on that row only', () => {
    const asked = rows('shutdown');
    assert.deepEqual(asked.filter((r) => r.value).map((r) => [r.id, r.value, r.tone]), [['shutdown', 'Press again to confirm', 'warn']]);
    assert.equal(asked.length, 3);
  });
  test('restart and shut down name the running game that will close', () => {
    for (const id of ['restart', 'shutdown']) {
      const asked = rows(id, 'cp');
      const at = asked.findIndex((r) => r.id === id);
      assert.deepEqual(asked[at + 1], { label: 'Cyberpunk 2077 is running and will close', value: '' }, id);
    }
  });
  test('sleep leaves the running game open, so it names none', () => assert.equal(rows('sleep', 'cp').length, 3));
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

describe('Settings > Screensaver', () => {
  const saver = (changes) => settingsState({ prefs: prefs(changes) });
  const shown = (state) => sectionRows('screensaver', state).filter((r) => r.kind).map((r) => [r.kind, r.value]);
  test('the delay as Rust holds it, and Show it now', () => {
    assert.deepEqual(shown(saver({})), [['saverafter', '5 min'], ['savernow', '']]);
    assert.deepEqual(shown(saver({ screensaver_minutes: 0 })), [['saverafter', 'Off'], ['savernow', '']]);
  });
  test("Rust's defaults until the prefs are in", () => {
    assert.deepEqual(shown(settingsState()), shown(saver({})));
  });
  test('the summary names the delay, or Off', () => {
    assert.deepEqual(sectionSummary('screensaver', saver({ screensaver_minutes: 10 })), ['After 10 min']);
    assert.deepEqual(sectionSummary('screensaver', saver({ screensaver_minutes: 0 })), ['Off']);
  });
  test('← and → step through the delays and stop at either end', () => {
    assert.equal(stepSaverMinutes(5, 1), 10);
    assert.equal(stepSaverMinutes(5, -1), 2);
    assert.equal(stepSaverMinutes(2, -1), 0);
    assert.equal(stepSaverMinutes(0, -1), 0);
    assert.equal(stepSaverMinutes(20, 1), 20);
    // A delay written by hand into prefs.json steps to the nearest listed one on the side pressed.
    assert.equal(stepSaverMinutes(7, 1), 10);
    assert.equal(stepSaverMinutes(7, -1), 5);
  });
});

test('a press Steam mirrors as a key counts once, in either order', () => {
  const seen = nothingSeen();
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
