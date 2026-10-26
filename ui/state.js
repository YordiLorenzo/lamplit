// @ts-check
// The page's one state object, the elements it draws into, and the questions every part asks of the state.

/**
 * @typedef {import('./api.js').Game} Game
 * @typedef {import('./api.js').StoreKey} StoreKey
 * @typedef {import('./api.js').LaunchStep} LaunchStep
 */

/** @typedef {Game & { el: HTMLElement }} Shown  a game in the cover row, with its cover */

/**
 * One line of the Settings screen: a heading, or a label with a value. Rows with a kind can be focused (✕ acts on
 * them); `adjust` rows change with ← and →.
 * @typedef {object} Row
 * @property {string} [heading]
 * @property {string} [kind]
 * @property {string} [key]  the section a section row opens
 * @property {string} [id]  the device or controller the row is about
 * @property {StoreKey} [store]
 * @property {string} [label]
 * @property {string} [value]
 * @property {string} [tone]  good or warn
 * @property {boolean} [adjust]
 */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

export const els = {
  heroes: [$('heroA'), $('heroB')],
  logo: /** @type {HTMLImageElement} */ ($('logo')),
  title: $('title'),
  store: $('store'),
  note: $('note'),
  played: $('played'),
  clock: $('clock'),
  empty: $('empty'),
  track: $('track'),
  overlay: $('overlay'),
  overlayTitle: $('overlayTitle'),
  overlaySub: $('overlaySub'),
  details: $('details'),
  dName: $('dName'),
  dStore: $('dStore'),
  dPlayed: $('dPlayed'),
  dDir: $('dDir'),
  settings: $('settings'),
  settingsTitle: $('settingsTitle'),
  settingsList: $('settingsList'),
  steps: $('steps'),
  toast: $('toast'),
  hint: $('hint'),
};

export const state = {
  /** @type {Shown[]} */
  games: [],
  idx: 0,
  /** @type {'browse' | 'starting' | 'details' | 'settings'} */
  mode: 'browse',
  /** @type {string | null} the game being started */
  launching: null,
  /** @type {string | null} the game Lamplit is waiting on to close */
  running: null,
  lastPad: -Infinity,
  heroLayer: 0,
  /** @type {string | null} */
  heroKey: null,
  /** @type {Map<string, number[]>} accent colour per game, sampled from its art */
  accents: new Map(),
  /** @type {LaunchStep[]} checks of the launch in progress */
  steps: [],
  /** @type {Map<StoreKey, import('./api.js').StoreStatus>} */
  stores: new Map(),
  /** @type {import('./api.js').Overlays} */
  overlays: { nvidia_overlay: false, nvidia_stats: null },
  /** @type {import('./api.js').Quiet | null} */
  quiet: null,
  /** @type {import('./api.js').Setup | null} */
  setup: null,
  /** @type {import('./api.js').Sound | null} */
  sound: null,
  /** @type {import('./api.js').Accessories | null} */
  accessories: null,
  /** @type {import('./api.js').Prefs | null} */
  prefs: null,
  /** @type {string | null} e.g. "3840 × 2160 at 120 Hz" */
  display: null,
  /**
   * Section null is the list of sections. `focus` names the focused row (logic.js rowKey); `idx` is where that row is
   * in `rows`, worked out again on every render.
   */
  settings: { section: /** @type {string | null} */ (null), focus: /** @type {string | null} */ (null), idx: 0, rows: /** @type {Row[]} */ ([]) },
};

export const focused = () => state.games[state.idx];

/** @param {string} id */
export const byId = (id) => state.games.find((g) => g.id === id);

/** A store app's name, from the list Rust sends. @param {StoreKey | null} key */
export const storeName = (key) => state.stores.get(key)?.name;

/**
 * The store's logo (a symbol in index.html) and then `text`, for replaceChildren or append; only the text when there
 * is no store.
 * @param {StoreKey | null | undefined} key @param {string | Node} text @returns {(string | Node)[]}
 */
export function withStoreLogo(key, text) {
  if (!key) return [text];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('store-logo');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#store-${key}`);
  svg.append(use);
  return [svg, text];
}

/** The step the player can act on: a sign-in to do, or a store app that may be waiting for them. */
export const actionableStep = () =>
  [...state.steps].reverse().find((s) => s.store && (s.state === 'block' || s.state === 'warn'));
