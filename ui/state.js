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
 * @property {import('./icons.js').IconId} [icon]
 * @property {string} [hold]  can't be taken back: Cross is held for it (hold.js), as this hint says
 * @property {string} [note]  what a held row does, shown before the press
 */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

export const els = {
  heroes: [$('heroA'), $('heroB')],
  info: $('info'),
  logo: /** @type {HTMLImageElement} */ ($('logo')),
  title: $('title'),
  store: $('store'),
  note: $('note'),
  played: $('played'),
  playtime: $('playtime'),
  status: $('status'),
  chips: $('chips'),
  clock: $('clock'),
  empty: $('empty'),
  noMatch: $('noMatch'),
  filters: $('filters'),
  row: $('row'),
  track: $('track'),
  overlay: $('overlay'),
  overlayTitle: $('overlayTitle'),
  overlaySub: $('overlaySub'),
  lift: $('lift'),
  veil: /** @type {HTMLCanvasElement} */ ($('veil')),
  card: $('card'),
  face: $('face'),
  sheet: $('sheet'),
  details: $('details'),
  dName: $('dName'),
  dStore: $('dStore'),
  dPlayed: $('dPlayed'),
  dTime: $('dTime'),
  dDir: $('dDir'),
  dChoices: $('dChoices'),
  artPick: $('artPick'),
  artQuery: $('artQuery'),
  artStatus: $('artStatus'),
  artTiles: $('artTiles'),
  artChoices: $('artChoices'),
  artKeys: $('artKeys'),
  add: $('add'),
  addTitle: $('addTitle'),
  addPath: $('addPath'),
  addList: $('addList'),
  addName: $('addName'),
  addKeys: $('addKeys'),
  settings: $('settings'),
  settingsFace: $('settingsFace'),
  settingsTitle: $('settingsTitle'),
  settingsList: $('settingsList'),
  find: $('find'),
  findPlate: $('findPlate'),
  findKeys: $('findKeys'),
  findLine: $('findLine'),
  findField: $('findField'),
  findQuery: $('findQuery'),
  findStore: $('findStore'),
  findSort: $('findSort'),
  findCount: $('findCount'),
  findStores: $('findStores'),
  steps: $('steps'),
  toast: $('toast'),
  gameNews: $('gameNews'),
  hint: $('hint'),
};

export const state = {
  /** @type {Shown[]} every game, hidden ones too, in the order Rust sends */
  all: [],
  /** @type {Shown[]} the cover row: favourites first, hidden games left out, and what `find` lets through (logic.js rowOf) */
  games: [],
  idx: 0,
  /** @type {import('./logic.js').Find} */
  find: { query: '', store: null, sort: 'played' },
  /** @type {string} the focused key, chip or store in Find (its data-id) */
  findFocus: 'a',
  /** Find's store list is open, grown up out of its chip */
  findList: false,
  /** @type {'browse' | 'starting' | 'details' | 'settings' | 'find' | 'add'} details: a game's menu (library.js) */
  mode: 'browse',
  /** whether the library has come in yet, so an empty row means no games found */
  loaded: false,
  /** the focused choice in a game's menu (logic.js detailChoices) */
  detailsIdx: 0,
  /** ✕ was pressed once on Remove from Lamplit */
  /** @type {import('./api.js').DockGame | null} the running game as the dock reads it, for the game menu's Close game */
  closer: null,
  /** @type {string | null} the game whose cover is lifted (lift.js); its cover in the row hides meanwhile */
  lifted: null,
  /**
   * Change art (art.js), over a game's menu. `found` is null while Steam's store is searched; `focus` is the data-id
   * of the focused cover or choice.
   */
  art: {
    open: false,
    id: '',
    query: '',
    /** @type {import('./api.js').ArtCandidate[] | null} */
    found: null,
    error: '',
    focus: 'search',
    editing: false,
    saving: false,
  },
  /**
   * Add a game (add.js): the list of programs, a folder of the PC, or naming the exe picked. `rows` are what the list
   * shows now.
   */
  add: {
    /** @type {'list' | 'browse' | 'name'} */
    view: 'list',
    /** @type {import('./api.js').Program[] | null} */
    programs: null,
    /** @type {import('./api.js').Folder | null} */
    folder: null,
    /**
     * A heading, or a row: `kind` is what ✕ does there ('browse', 'program', 'drive', 'folder', 'exe'; '' for none),
     * `path` the exe or folder, `title` the name an exe's game would get.
     * @type {{ heading?: string, kind?: string, label?: string, value?: string, path?: string, title?: string }[]}
     */
    rows: [],
    idx: 0,
    exe: '',
    /** @type {'list' | 'browse'} the view naming goes back to */
    from: 'list',
    busy: false,
  },
  /** @type {import('./keyboard.js').Field | null} the names keyboard in use, which the PC's keyboard types into */
  typing: null,
  /** @type {string | null} the game being started */
  launching: null,
  /** @type {string | null} the game Lamplit is waiting on to close */
  running: null,
  /** @type {import('./api.js').PadKind} the kind of controller used last, whose buttons the hints show */
  padKind: 'dualsense',
  heroLayer: 0,
  /** @type {string | null} */
  heroKey: null,
  /** @type {Map<string, { rgb: number[], light: number }>} accent colour and brightness per game, sampled from its art */
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
  settings: {
    section: /** @type {string | null} */ (null),
    focus: /** @type {string | null} */ (null),
    idx: 0,
    rows: /** @type {Row[]} */ ([]),
  },
};

export const focused = () => state.games[state.idx];

/** A game in the library, also when the search or the store filter keeps it out of the row. @param {string} id */
export const byId = (id) => state.all.find((g) => g.id === id);

/** A store app's name, from the list Rust sends. @param {StoreKey | null} key */
export const storeName = (key) => state.stores.get(key)?.name;

/**
 * The store's logo (a symbol in index.html) and then `text`, for replaceChildren or append; only the text when there
 * is no store, or no logo for it (the Amazon Games app: Simple Icons took Amazon's logos out, lacking permission).
 * @param {StoreKey | null | undefined} key @param {string | Node} text @returns {(string | Node)[]}
 */
export function withStoreLogo(key, text) {
  return key && document.getElementById(`store-${key}`) ? [icon(`store-${key}`), text] : [text];
}

/** A store's logo from index.html, or an icon both pages share (icons.js), sized and coloured like the text beside it. @param {string} id */
export function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('store-logo');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

/**
 * The step the player can act on: a sign-in to do, a store app that may be waiting for them, or a window that opened
 * and may need them (key "window").
 */
export const actionableStep = () =>
  [...state.steps].reverse().find((s) => (s.store || s.key === 'window') && (s.state === 'block' || s.state === 'warn'));
