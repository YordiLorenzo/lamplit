// @ts-check
// What the page shows, worked out from plain data. Nothing here touches the DOM or Tauri, so tests/logic.test.mjs
// runs it in Node.

/**
 * @typedef {import('./api.js').Game} Game
 * @typedef {import('./api.js').StoreKey} StoreKey
 * @typedef {import('./api.js').StoreStatus} StoreStatus
 * @typedef {import('./api.js').Charge} Charge
 * @typedef {import('./api.js').PadKind} PadKind
 * @typedef {import('./api.js').PadBattery} PadBattery
 * @typedef {import('./state.js').Row} Row
 * @typedef {typeof import('./state.js').state} State
 */

// ---------- the button hints ----------

/** @typedef {'ok' | 'back' | 'triangle' | 'square' | 'menu' | 'adjust'} HintButton */

/**
 * How each button the hints name looks, as [class, glyph]: PlayStation's symbols, or Xbox's letters, which most
 * other controllers share.
 * @type {Record<'playstation' | 'xbox', Record<HintButton, [string, string]>>}
 */
const FACES = {
  playstation: {
    ok: ['cross', '✕'],
    back: ['circle', '○'],
    triangle: ['options', '△'],
    square: ['options', '□'],
    menu: ['options', '≡'],
    adjust: ['options', '↔'],
  },
  xbox: {
    ok: ['xbox-a', 'A'],
    back: ['xbox-b', 'B'],
    triangle: ['xbox-y', 'Y'],
    square: ['xbox-x', 'X'],
    menu: ['options', '≡'],
    adjust: ['options', '↔'],
  },
};

/**
 * The class and glyph of a button on the kind of controller in use.
 * @param {PadKind} kind
 * @param {HintButton} button
 */
export const buttonFace = (kind, button) =>
  FACES[kind === 'dualsense' || kind === 'playstation' ? 'playstation' : 'xbox'][button];

// ---------- the controller and the keyboard ----------

/** How long a mirrored key and the pad's own press can be apart and still be one press. */
export const MIRROR_MS = 300;
/** After a pad press, keys are Steam mirroring the pad, and are ignored this long. */
export const PAD_KEEPS_MS = 2000;

/** @typedef {{ lastPad: number, lastKey: { action: string, at: number } }} Seen what a window had from the pad and the keys */

/** @returns {Seen} */
export const nothingSeen = () => ({ lastPad: -Infinity, lastKey: { action: '', at: 0 } });

/** The pad was used a moment ago, so keys now are Steam mirroring it. @param {Seen} seen @param {number} now */
export const padInUse = (seen, now) => now - seen.lastPad < PAD_KEEPS_MS;

/**
 * Whether an input counts. Steam mirrors the controller as keys while a window other than a game is in front, so the
 * same press comes once from Rust and once as a key, in either order. A key that comes first, while the pad is idle,
 * is the press the pad's own then repeats: without this, one press of ✕ could ask "Shut down?" and answer it.
 * @param {Seen} seen  updated in place
 * @param {string} action
 * @param {'pad' | 'key' | 'mouse'} source
 * @param {number} now  milliseconds
 */
export function counts(seen, action, source, now) {
  if (source === 'pad') {
    seen.lastPad = now;
    if (action === seen.lastKey.action && now - seen.lastKey.at < MIRROR_MS) {
      // That key had one press behind it: a second press right after is a real one.
      seen.lastKey = { action: '', at: 0 };
      return false;
    }
  } else if (source === 'key') {
    if (padInUse(seen, now)) return false;
    seen.lastKey = { action, at: now };
  }
  return true;
}

// ---------- the focused game ----------

/** Keeps the hue, lifts saturation and lightness so the colour reads on a dark screen. @param {number[]} rgb */
export function readable([r, g, b]) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  if (s < 0.12) return [200, 206, 222];
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  s = Math.min(0.85, Math.max(0.45, s));
  const c = (1 - Math.abs(2 * 0.62 - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 0.62 - c / 2;
  const [R, G, B] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [R, G, B].map((v) => Math.round((v + m) * 255));
}

/**
 * A picture's accent: the average of its pixels, where vivid, mid-bright ones count most and dark and washed-out ones
 * barely, made readable.
 * @param {ArrayLike<number>} rgba  the pixels as a canvas gives them back
 */
export function accentOf(rgba) {
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const max = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
    const min = Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
    const sat = max ? (max - min) / max : 0;
    const lum = max / 255;
    const wt = sat * sat * (lum > 0.2 && lum < 0.95 ? 1 : 0.15) + 0.002;
    r += rgba[i] * wt;
    g += rgba[i + 1] * wt;
    b += rgba[i + 2] * wt;
    w += wt;
  }
  return readable([r / w, g / w, b / w]);
}

/** @param {number} ts Unix seconds, 0 for never @param {number} [now] Unix seconds */
export function playedText(ts, now = Date.now() / 1000) {
  if (!ts) return '';
  const days = Math.floor((now - ts) / 86400);
  if (days <= 0) return 'Played today';
  if (days === 1) return 'Played yesterday';
  if (days < 14) return `Played ${days} days ago`;
  if (days < 60) return `Played ${Math.round(days / 7)} weeks ago`;
  return `Played ${Math.round(days / 30)} months ago`;
}

/**
 * Time played: minutes up to an hour, then whole hours ("12 h") for the home screen, or hours and minutes
 * ("12 h 5 min") when `exact`. Nothing under a minute.
 * @param {number} minutes @param {boolean} [exact]
 */
export function playTimeText(minutes, exact = false) {
  if (minutes < 1) return '';
  if (minutes < 60) return `${minutes} min`;
  const [h, m] = [Math.floor(minutes / 60), minutes % 60];
  return exact && m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * The cover row's order, the one Rust sends (library/mod.rs): last played first, then by name in lower case, compared
 * character by character rather than by the language's rules, which Rust doesn't know.
 * @param {Game} a
 * @param {Game} b
 */
export function byPlayed(a, b) {
  if (a.last_played !== b.last_played) return b.last_played - a.last_played;
  const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The choices in a game's menu, in order. A game added by hand can be removed again; ✕ once asks (`removing`), ✕
 * again removes it.
 * @param {Game} g
 * @param {string | null} running  the id of the game that runs
 * @param {boolean} [removing]
 * @returns {{ kind: 'play' | 'favourite' | 'art' | 'hide' | 'remove', label: string }[]}
 */
export function detailChoices(g, running, removing = false) {
  return [
    { kind: 'play', label: running === g.id ? 'Back to game' : 'Play' },
    { kind: 'favourite', label: g.favourite ? 'Remove from favourites' : 'Add to favourites' },
    { kind: 'art', label: 'Change art' },
    { kind: 'hide', label: 'Hide this game' },
    ...(g.manual ? [{ kind: /** @type {const} */ ('remove'), label: removing ? 'Press again to remove' : 'Remove from Lamplit' }] : []),
  ];
}

// ---------- the lifted game menu ----------

/**
 * A damped spring from 0 to 1 (mass 1), as a CSS linear() easing and the time it takes to come to rest. Below
 * critical damping (2 × √stiffness) it overshoots and settles back, as a card lifted by hand would.
 * @param {number} stiffness
 * @param {number} damping
 */
export function spring(stiffness, damping) {
  const dt = 1 / 1000;
  let x = 0, v = 0, t = 0;
  /** @type {number[]} position every millisecond */
  const path = [0];
  // At rest: within 0.1% of the end and barely moving. Semi-implicit Euler is stable at this step for these springs.
  while (t < 3 && (Math.abs(1 - x) > 0.001 || Math.abs(v) > 0.01)) {
    v += (stiffness * (1 - x) - damping * v) * dt;
    x += v * dt;
    t += dt;
    path.push(x);
  }
  path[path.length - 1] = 1;
  const stops = 40;
  const points = Array.from({ length: stops + 1 }, (_, i) => +path[Math.round((i / stops) * (path.length - 1))].toFixed(4));
  return { easing: `linear(${points.join(', ')})`, ms: Math.round(t * 1000) };
}

/**
 * Where a lifted cover and its menu go. The cover grows from its place in the row (`from`) to `height` and rises to
 * the middle of the screen, staying over its column inside the safe area (5% at each edge). The menu, `menuWidth`
 * wide, opens beside it on the side that has room for it, else on the roomier side, narrowed to fit. `side` is 1 for
 * the right and -1 for the left.
 * @param {Box} from
 * @param {{ width: number, height: number }} screen
 * @param {number} menuWidth
 */
export function liftLayout(from, screen, menuWidth) {
  const safeX = screen.width * 0.05, gap = screen.height * 0.035;
  const height = screen.height * 0.56;
  const width = (height * from.width) / from.height;
  const x = Math.max(safeX, Math.min(screen.width - safeX - width, from.x + from.width / 2 - width / 2));
  const card = { x, y: screen.height * 0.46 - height / 2, width, height };
  const right = screen.width - safeX - (x + width + gap);
  const left = x - gap - safeX;
  const side = right >= menuWidth || right >= left ? 1 : -1;
  const room = side > 0 ? right : left;
  const menu = { width: Math.min(menuWidth, room), x: 0, room };
  menu.x = side > 0 ? x + width + gap : x - gap - menu.width;
  return { card, menu, side };
}

/**
 * Lamplit knows up front when a store app the game needs isn't signed in or isn't installed.
 * @param {Game} g
 * @param {Map<StoreKey, StoreStatus>} stores
 */
export function storeWarning(g, stores) {
  for (const key of g.requires) {
    const s = stores.get(key);
    if (!s) continue;
    if (!s.installed) return `${s.name} isn't installed`;
    if (s.account === 'signed-out') return `${s.name}: sign in needed`;
  }
  return null;
}

// ---------- finding a game ----------

/**
 * What narrows and orders the cover row, chosen in the Find panel.
 * @typedef {object} Find
 * @property {string} query  as typed
 * @property {StoreKey | 'pc' | null} store  'pc' for games outside any store, null for every game
 * @property {'played' | 'name'} sort  last played first (the order Rust sends), or A to Z
 */

/** The store filter's order, the one Rust lists its stores in (stores/mod.rs ALL), then games outside any store. */
export const STORE_ORDER = /** @type {const} */ ([
  'steam', 'epic', 'ea', 'ubisoft', 'rockstar', 'battlenet', 'gog', 'amazon', 'itch', 'xbox', 'pc',
]);

/** The longest search the field shows. */
export const MAX_QUERY = 30;

/**
 * A name or a search as words to match: lower case, accents dropped, apostrophes left out ("Assassin's" is
 * "assassins"), and any other punctuation a break between words ("Half-Life" is "half life", "Cities:" is "cities").
 * @param {string} text
 */
export function words(text) {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’ʼ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whether `q` is spelt by the starts of `names[i]`, `names[i + 1]` and so on, at least one letter from each: "rdr"
 * and "reddead" in Red Dead Redemption.
 * @param {string} q @param {string[]} names @param {number} i
 * @returns {boolean}
 */
function spelt(q, names, i) {
  if (!q) return true;
  const word = names[i] ?? '';
  let n = 0;
  while (n < q.length && q[n] === word[n]) n++;
  for (; n > 0; n--) if (spelt(q.slice(n), names, i + 1)) return true;
  return false;
}

/**
 * A test for game names: each word of the search has to start one of the name's words, or spell the starts of
 * several in a row, in any order. "red dead", "dead", "rdr" and "rdr2" all find Red Dead Redemption 2; "edemption"
 * doesn't.
 * @param {string} query
 * @returns {(name: string) => boolean}
 */
export function matcher(query) {
  const wanted = words(query);
  return (name) => {
    const names = words(name);
    return wanted.every((q) => names.some((_, i) => spelt(q, names, i)));
  };
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** A to Z in the player's language, with numbers in number order: "Game 2" before "Game 10". @param {Game} a @param {Game} b */
export const byName = (a, b) => collator.compare(a.name, b.name) || byPlayed(a, b);

/**
 * The cover row: the games the search and the store filter let through, hidden games left out, favourites first and
 * then the chosen order. Everything that decides which games the row shows, and in what order, belongs here.
 * @template {Game} G
 * @param {G[]} games
 * @param {Find} find
 * @returns {G[]}
 */
export function rowOf(games, { query, store, sort }) {
  const named = matcher(query);
  const order = sort === 'name' ? byName : byPlayed;
  return games
    .filter((g) => !g.hidden && (!store || (g.store ?? 'pc') === store) && named(g.name))
    .sort((a, b) => Number(b.favourite) - Number(a.favourite) || order(a, b));
}

/** Whether the row leaves games out, so the home screen says so and ○ brings every game back. @param {Find} find */
export const narrowed = (find) => words(find.query).length > 0 || find.store !== null;

/**
 * The store filter's choices: every store with a game in the library, and the one chosen even when its games have
 * gone since. null is every store.
 * @param {Game[]} games
 * @param {Find['store']} chosen
 */
export function storeChoices(games, chosen) {
  const have = new Set([...games.map((g) => g.store ?? 'pc'), chosen]);
  return [null, ...STORE_ORDER.filter((s) => have.has(s))];
}

/**
 * The search after a key: a letter or digit, 'space' or 'delete'. A space only goes between words, and the search
 * stops growing at the field's length, `max`.
 * @param {string} query
 * @param {string} key
 * @param {number} [max]
 */
export function typed(query, key, max = MAX_QUERY) {
  if (key === 'delete') return [...query].slice(0, -1).join('');
  if (key === 'space') return !query || query.endsWith(' ') || query.length >= max ? query : `${query} `;
  return query.length < max ? query + key : query;
}

/**
 * A name typed on the names keyboard, and whether its next letter is a capital: at the start of the name and of each
 * word, as game names are written, unless Shift turned that off. Shift turns it on for the next letter anywhere else.
 * @typedef {{ text: string, caps: boolean }} Name
 */

/**
 * The name after a key: a letter, digit or sign, 'space', 'delete', 'clear' or 'shift'.
 * @param {Name} name
 * @param {string} key
 * @param {number} max
 * @returns {Name}
 */
export function nameAfter({ text, caps }, key, max) {
  const wordStart = (/** @type {string} */ t) => !t || t.endsWith(' ');
  if (key === 'shift') return { text, caps: !caps };
  if (key === 'clear') return { text: '', caps: true };
  if (key === 'delete' || key === 'space') {
    const next = typed(text, key, max);
    return { text: next, caps: wordStart(next) };
  }
  if (text.length >= max) return { text, caps };
  const letter = key.toLowerCase() !== key.toUpperCase();
  if (!letter) return { text: text + key, caps };
  return { text: text + (caps ? key.toUpperCase() : key), caps: false };
}

/** @typedef {{ x: number, y: number, width: number, height: number }} Box */

/**
 * The box a direction moves to on a screen laid out in rows (the Find panel's keys and choices), or -1 when nothing
 * lies that way. ← and → go to the next box in the row. ↑ and ↓ go to the next row, onto its box nearest to the side,
 * so a row of choices that wraps onto a second line isn't skipped.
 * @param {Box} from
 * @param {Box[]} boxes
 * @param {'up' | 'down' | 'left' | 'right'} dir
 */
export function nearest(from, boxes, dir) {
  /** @param {Box} b */
  const centre = (b) => [b.x + b.width / 2, b.y + b.height / 2];
  const [fx, fy] = centre(from);
  const sideways = dir === 'left' || dir === 'right';
  const ahead = boxes
    .map((b, i) => {
      const [x, y] = centre(b);
      const along = { left: fx - x, right: x - fx, up: fy - y, down: y - fy }[dir];
      return { i, along, across: sideways ? Math.abs(y - fy) : Math.abs(x - fx) };
    })
    .filter((b) => b.along > 1 && (!sideways || b.across < from.height / 2));
  if (!ahead.length) return -1;
  const next = Math.min(...ahead.map((b) => b.along));
  return ahead.filter((b) => b.along < next + from.height / 2).reduce((a, b) => (b.across < a.across ? b : a)).i;
}

// ---------- the Settings screen ----------

export const SECTIONS = [
  { key: 'sound', title: 'Sound' },
  { key: 'headset', title: 'Headset' },
  { key: 'controllers', title: 'Controllers' },
  { key: 'popups', title: 'Overlay and pop-ups' },
  { key: 'stores', title: 'Stores' },
  { key: 'screensaver', title: 'Screensaver' },
  { key: 'system', title: 'System' },
  { key: 'add', title: 'Add a game' },
  { key: 'hidden', title: 'Hidden games' },
  { key: 'power', title: 'Power' },
];
/** The rows of Settings > Power. Restart and Shut down close a game that runs; it stays open while the PC sleeps. */
const POWER = [
  { id: 'sleep', label: 'Sleep', closesGame: false },
  { id: 'restart', label: 'Restart', closesGame: true },
  { id: 'shutdown', label: 'Shut down', closesGame: true },
];
/** The auto-off times the headset offers, in minutes; 0 is never. */
const AUTO_OFF = [0, 5, 10, 15, 20, 30, 60];
const CHARGE = { charging: 'charging', full: 'full', 'not-charging': 'not charging' };
const LEVEL = { empty: 'Empty', low: 'Low', medium: 'Medium', full: 'Full' };
const CONNECTION = { usb: 'USB cable', bluetooth: 'Bluetooth', wireless: 'Wireless' };
const ACCOUNT = {
  'signed-in': ['Signed in', 'good'],
  remembered: ['Signs in when started', ''],
  'signed-out': ['Not signed in', 'warn'],
};
/** @param {boolean | null | undefined} v */
const onOff = (v) => (v ? 'On' : 'Off');

/** The screensaver's settings until Rust's prefs are in, as prefs.rs has them. */
export const SAVER_DEFAULT = /** @type {const} */ ({ minutes: 5, style: 'mix' });
/** The delays Settings > Screensaver offers, in minutes; 0 is never. */
const SAVER_MINUTES = [0, 2, 5, 10, 20];
/** @type {import('./api.js').ScreensaverStyle[]} */
const SAVER_STYLES = ['mix', '2d', '3d'];
const SAVER_STYLE_NAME = { mix: '2D and 3D', '2d': '2D', '3d': '3D' };
/** @param {number} minutes */
const saverAfter = (minutes) => (minutes ? `${minutes} min` : 'Off');

/**
 * The next delay or style in the direction pressed, stopping at either end. A delay Rust holds that isn't in the list
 * steps to the nearest listed one on that side.
 * @param {'minutes' | 'style'} what
 * @param {number | string} now
 * @param {number} dir -1 or 1
 */
export function stepSaver(what, now, dir) {
  if (what === 'minutes') {
    const m = Number(now);
    return (dir > 0 ? SAVER_MINUTES.find((x) => x > m) : SAVER_MINUTES.findLast((x) => x < m)) ?? m;
  }
  const at = SAVER_STYLES.indexOf(/** @type {import('./api.js').ScreensaverStyle} */ (now));
  return SAVER_STYLES[Math.max(0, Math.min(SAVER_STYLES.length - 1, at + dir))];
}

/**
 * The store apps the Stores section lists: the installed ones. Not the Xbox app: Xbox games start without it, so Rust
 * reports the Xbox store as always there, and has nothing to say about the app itself.
 * @param {State} state
 */
const storeApps = (state) => [...state.stores.values()].filter((s) => s.installed && s.store !== 'xbox');

/** @param {number | null} level @param {Charge | null} charge */
export function batteryText(level, charge) {
  if (level == null) return 'Unknown';
  return CHARGE[charge] ? `${level}% · ${CHARGE[charge]}` : `${level}%`;
}

/** A controller's battery: the percent, else the rough level an Xbox-style controller gives. @param {PadBattery | null} b */
export function padBatteryText(b) {
  if (!b) return 'Not reported over this link';
  return b.percent != null ? batteryText(b.percent, b.charge) : LEVEL[b.level];
}

/**
 * The next auto-off time in the direction pressed. A time the headset reports that isn't in the list steps to the
 * nearest listed one on that side.
 * @param {number} minutes
 * @param {number} dir -1 or 1
 */
export function stepAutoOff(minutes, dir) {
  const next = dir > 0 ? AUTO_OFF.find((m) => m > minutes) : AUTO_OFF.findLast((m) => m < minutes);
  return next ?? minutes;
}

/** The hidden games, by name. @param {State} state */
const hiddenGames = (state) => state.all.filter((g) => g.hidden).sort((a, b) => a.name.localeCompare(b.name));

/**
 * The sections the first level lists: the Headset one only once its receiver is plugged in, Hidden games only while
 * a game is hidden.
 * @param {State} state
 */
export const visibleSections = (state) =>
  SECTIONS.filter((x) => x.key !== 'headset' || state.accessories?.headset.receiver)
    .filter((x) => x.key !== 'hidden' || state.all.some((g) => g.hidden));

/**
 * One line per section on the first level: what is going on there, and a tone.
 * @param {string} key
 * @param {State} state
 * @returns {[string, string?]}
 */
export function sectionSummary(key, state) {
  const { sound, accessories: acc } = state;
  if (key === 'sound') {
    const out = sound?.outputs.find((d) => d.default);
    if (!out) return ['…'];
    return [`${out.name} · ${sound.muted ? 'muted' : `${sound.volume ?? '?'}%`}`];
  }
  if (key === 'headset') {
    // Listed only while the receiver is plugged in (visibleSections).
    const h = acc.headset;
    if (h.on === null) return ['…'];
    if (!h.on) return ['Off'];
    const low = h.battery != null && h.battery <= 15 && h.charge === 'battery';
    return [`On · ${batteryText(h.battery, h.charge)}`, low ? 'warn' : 'good'];
  }
  if (key === 'controllers') {
    const pads = acc?.controllers ?? [];
    if (!pads.length) return ['None connected'];
    const short = (/** @type {PadBattery | null} */ b) =>
      b?.percent != null ? `${b.percent}%` : b?.level ? LEVEL[b.level].toLowerCase() : '?';
    const levels = pads.map((c) => short(c.battery)).join(', ');
    return [`${pads.length} connected · ${levels}`];
  }
  if (key === 'popups') {
    const quiet = { on: 'Quiet', off: 'Pop-ups on', partly: 'Partly quiet' }[state.quiet?.state] ?? '…';
    const stats = state.overlays.nvidia_stats;
    return [stats === null ? quiet : `Stats ${stats ? 'on' : 'off'} · ${quiet.toLowerCase()}`];
  }
  if (key === 'stores') {
    const installed = storeApps(state);
    if (!installed.length) return ['No store apps'];
    const out = installed.filter((s) => s.account === 'signed-out');
    if (out.length) return [`${out.map((s) => s.name).join(', ')}: sign in`, 'warn'];
    // GOG Galaxy reports no account, so it counts neither for nor against "All signed in".
    const known = installed.filter((s) => s.account !== 'unknown');
    if (known.length && known.every((s) => s.account === 'signed-in')) return ['All signed in', 'good'];
    return [`${installed.length} installed`];
  }
  if (key === 'hidden') {
    const n = hiddenGames(state).length;
    return [n === 1 ? '1 game' : `${n} games`];
  }
  if (key === 'power') return ['Sleep, restart, shut down'];
  if (key === 'screensaver') {
    const minutes = state.prefs?.screensaver_minutes ?? SAVER_DEFAULT.minutes;
    const style = state.prefs?.screensaver_style ?? SAVER_DEFAULT.style;
    return [minutes ? `After ${minutes} min · ${SAVER_STYLE_NAME[style]}` : 'Off'];
  }
  if (key === 'add') return ['A program or an exe on this PC'];
  return state.setup?.needed ? ['Setup needed', 'warn'] : [state.display ?? ''];
}

/**
 * Rows of a section.
 * @param {string} key
 * @param {State} state
 * @returns {Row[]}
 */
export function sectionRows(key, state) {
  /** @type {Row[]} */
  const rows = [];
  const { sound, accessories: acc, prefs } = state;
  if (key === 'sound') {
    if (!sound) return [{ label: 'Sound devices', value: 'Not available' }];
    rows.push({ heading: 'Output' });
    for (const d of sound.outputs) rows.push({ kind: 'device', id: d.id, label: d.name, value: d.default ? 'In use' : '', tone: 'good' });
    rows.push({ kind: 'volume', adjust: true, label: 'Volume', value: sound.muted ? 'Muted' : `${sound.volume ?? '?'}%` });
    rows.push({ kind: 'mute', label: 'Mute', value: onOff(sound.muted) });
    rows.push({ heading: 'Microphone' });
    for (const d of sound.inputs) rows.push({ kind: 'device', id: d.id, label: d.name, value: d.default ? 'In use' : '', tone: 'good' });
    rows.push({ kind: 'micmute', label: 'Mute microphone', value: onOff(sound.mic_muted) });
    rows.push({ heading: 'Automatic' });
    rows.push({ kind: 'follows', label: 'Sound follows the headset and controller headphones', value: onOff(prefs?.sound_follows) });
  } else if (key === 'headset') {
    const h = acc?.headset;
    rows.push({ heading: 'Logitech PRO X 2 LIGHTSPEED' });
    // The section stays open when the receiver is pulled out while it shows.
    if (!h?.receiver) rows.push({ label: 'Receiver', value: 'Not plugged in', tone: 'warn' });
    else if (!h.on) rows.push({ label: 'Headset', value: h.on === false ? 'Off' : 'Checking…' });
    else {
      rows.push({ label: 'Headset', value: 'On', tone: 'good' });
      rows.push({ label: 'Battery', value: batteryText(h.battery, h.charge) });
      if (h.sidetone != null) rows.push({ kind: 'sidetone', adjust: true, label: 'Sidetone (your own voice)', value: `${h.sidetone}%` });
      if (h.auto_off != null) rows.push({ kind: 'autooff', adjust: true, label: 'Turns off when unused after', value: h.auto_off ? `${h.auto_off} min` : 'Never' });
    }
  } else if (key === 'controllers') {
    const pads = acc?.controllers ?? [];
    // The touchpad is a DualSense's; the switch stays while no controller is connected, to change it beforehand.
    if (!pads.length || pads.some((c) => c.kind === 'dualsense')) {
      rows.push({ kind: 'touchmouse', label: 'Touchpad as mouse (not over games)', value: onOff(prefs?.touchpad_mouse) });
    }
    if (!pads.length) rows.push({ label: 'No controller connected', value: '' });
    pads.forEach((c, i) => {
      rows.push({ heading: `Controller ${i + 1} · ${c.name} · ${CONNECTION[c.connection]}` });
      rows.push({ label: 'Battery', value: padBatteryText(c.battery) });
      if (c.kind !== 'dualsense') return;
      const bluetooth = c.connection === 'bluetooth';
      const jack = c.headphones;
      const where = !jack ? 'Not plugged in' : bluetooth ? 'Plugged in · sound needs the USB cable' : 'Plugged in';
      rows.push({ label: 'Headphones', value: where, tone: jack && bluetooth ? 'warn' : '' });
      if (bluetooth) rows.push({ kind: 'padoff', id: c.id, label: 'Turn off', value: '' });
    });
  } else if (key === 'popups') {
    const { nvidia_overlay: installed, nvidia_stats: on } = state.overlays;
    const label = 'Performance stats (NVIDIA)';
    // An unknown state can still be switched: the overlay logs the switch, and Lamplit knows the state from then on.
    const value = on === null ? 'Unknown' : onOff(on);
    rows.push(installed ? { kind: 'stats', label, value, tone: on ? 'good' : '' } : { label, value: 'Not available' });
    rows.push({
      kind: 'quiet',
      label: 'Quiet mode (no pop-ups, no Game Bar recording)',
      value: { on: 'On', off: 'Off', partly: 'Partly on' }[state.quiet?.state] ?? '…',
      tone: state.quiet?.state === 'on' ? 'good' : state.quiet?.state === 'partly' ? 'warn' : '',
    });
    rows.push({ kind: 'dock', label: 'Dock over games (hold PS, or View and Menu)', value: onOff(prefs?.dock) });
  } else if (key === 'stores') {
    for (const s of storeApps(state)) {
      const [text, tone] = ACCOUNT[s.account] ?? [s.running ? 'Running' : 'Not running', ''];
      rows.push({ kind: 'store', store: s.store, label: s.name, value: text, tone });
    }
    if (!rows.length) rows.push({ label: 'No store apps found', value: '' });
    if (state.stores.get('steam')?.installed) {
      rows.push({ heading: "Steam's DevTools port" });
      rows.push({ kind: 'steamport', label: 'Open it (PS button guard, Steam pop-ups in quiet mode)', value: onOff(prefs?.steam_devtools) });
      rows.push({ label: 'While it is open, any program on this PC can control Steam', value: '' });
    }
  } else if (key === 'screensaver') {
    rows.push({ kind: 'saverafter', adjust: true, label: 'Starts after', value: saverAfter(prefs?.screensaver_minutes ?? SAVER_DEFAULT.minutes) });
    rows.push({ kind: 'saverstyle', adjust: true, label: 'Scenes', value: SAVER_STYLE_NAME[prefs?.screensaver_style ?? SAVER_DEFAULT.style] });
    rows.push({ kind: 'savernow', label: 'Show it now', value: '' });
    rows.push({ label: 'Starts while Lamplit is in front and no game runs. Any button ends it.', value: '' });
  } else if (key === 'system') {
    if (state.setup?.needed) rows.push({ kind: 'setup', label: 'First-time setup (asks Windows once)', value: 'Needed', tone: 'warn' });
    rows.push({ kind: 'onlineart', label: "Find art online (sends game names to Steam's store)", value: onOff(prefs?.online_art) });
    rows.push({ label: 'Display', value: state.display ?? 'Unknown' });
  } else if (key === 'hidden') {
    for (const g of hiddenGames(state)) rows.push({ kind: 'unhide', id: g.id, store: g.store, label: g.name, value: 'Show' });
    // The section stays open when its last game is shown again.
    if (!rows.length) rows.push({ label: 'No hidden games', value: '' });
  } else if (key === 'power') {
    const running = state.all.find((g) => g.id === state.running);
    for (const p of POWER) {
      // ✕ once asks, ✕ again does it.
      const asked = state.settings.confirm === p.id;
      rows.push({ kind: 'power', id: p.id, label: p.label, value: asked ? 'Press again to confirm' : '', tone: asked ? 'warn' : '' });
      if (asked && p.closesGame && running) rows.push({ label: `${running.name} is running and will close`, value: '' });
    }
  }
  return rows;
}

/** What a focusable row is about, unchanged when the rows around it change. @param {Row} row */
export const rowKey = (row) => `${row.kind}:${row.id ?? row.store ?? row.key ?? ''}`;

/**
 * Where the row with `focus` is now, else the first row that can take focus; -1 when none can.
 * @param {Row[]} rows
 * @param {string | null} focus
 */
export function focusIndex(rows, focus) {
  const at = rows.findIndex((r) => r.kind && rowKey(r) === focus);
  return at >= 0 ? at : rows.findIndex((r) => r.kind);
}
