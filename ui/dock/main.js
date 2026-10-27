// @ts-check
// The in-game dock's page (dock.html). Rust shows its window over the running game and says when the dock opens,
// folds away or has news (src-tauri/src/dock/); this page draws the island, takes the controller's presses while the
// dock is in front, and calls the commands its tiles stand for.

import * as api from '../api.js';
import { buttonFace } from '../logic.js';
import { sfx } from '../sounds.js';
import { chips, counts, hints, outputIcon, spring, tiles, volumeText } from './logic.js';

/** @typedef {import('./logic.js').TileKey} TileKey */
/** @typedef {import('../api.js').Action} Action */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const els = {
  island: $('island'),
  news: $('news'),
  newsIcon: $('newsIcon'),
  newsText: $('newsText'),
  dock: $('dock'),
  game: $('game'),
  chips: $('chips'),
  clock: $('clock'),
  volume: $('volume'),
  volumeIcon: $('volumeIcon'),
  volumeFill: $('volumeFill'),
  volumeText: $('volumeText'),
  tiles: $('tiles'),
  outputs: $('outputs'),
  outputList: $('outputList'),
  message: $('message'),
  hint: $('hint'),
};

/** How long news stays before it folds; Rust hides the window a little later (dock/mod.rs NEWS_FOR). */
const NEWS_HOLD_MS = 2600;
/** How long a message under the tiles stays. */
const MESSAGE_MS = 6000;
/**
 * How often the open dock reads the game again: Close game becomes Force close once the game stops responding, or
 * still runs 10 s after it was asked to close (dock/game.rs).
 */
const GAME_EVERY_MS = 2000;

const state = {
  /** @type {'gone' | 'news' | 'open'} */
  mode: 'gone',
  /** @type {'tiles' | 'volume' | 'outputs'} where the focus is */
  row: 'tiles',
  /** @type {TileKey} the focused tile, also while the focus is on another row */
  tile: 'resume',
  /** the focused output while choosing one */
  output: 0,
  /** @type {import('./logic.js').DockData} what the dock knows; kept between openings, so it opens with the last */
  data: {
    game: null,
    sound: null,
    accessories: null,
    quiet: null,
    overlays: { nvidia_overlay: false, nvidia_stats: null },
    confirm: false,
  },
  /** @type {import('../api.js').PadKind} */
  padKind: 'dualsense',
  seen: { lastPad: -Infinity, lastKey: { action: '', at: 0 } },
};

// ---------- the island ----------

/** The window covers part of the screen: --u is a hundredth of the screen's height, as vh is on the home screen. */
function measure() {
  document.documentElement.style.setProperty('--u', `${screen.height / 100}px`);
}

/** The island takes the size of the face it shows, or folds into the pill. @param {'gone' | 'news' | 'open'} mode */
function shape(mode) {
  state.mode = mode;
  els.island.dataset.mode = mode;
  const face = mode === 'open' ? els.dock : mode === 'news' ? els.news : null;
  els.island.style.width = face ? `${face.offsetWidth}px` : '';
  els.island.style.height = face ? `${face.offsetHeight}px` : '';
}

let newsTimer = 0;
let gameTimer = 0;

function open() {
  clearTimeout(newsTimer);
  measure();
  state.row = 'tiles';
  state.tile = 'resume';
  state.data.confirm = false;
  say('');
  render();
  shape('open');
  sfx.open();
  refresh();
  clearInterval(gameTimer);
  gameTimer = setInterval(rereadGame, GAME_EVERY_MS);
}

function fold() {
  clearTimeout(newsTimer);
  clearInterval(gameTimer);
  if (state.mode !== 'gone') shape('gone');
}

/** @param {Extract<import('../api.js').DockShow, { mode: 'status' }>} news */
function showNews(news) {
  if (state.mode === 'open') return;
  els.newsIcon.setAttribute('href', `#i-${news.icon}`);
  els.newsText.textContent = news.text;
  els.news.classList.toggle('warn', news.warn);
  measure();
  shape('news');
  clearTimeout(newsTimer);
  newsTimer = setTimeout(() => shape('gone'), NEWS_HOLD_MS);
}

/** @param {import('../api.js').DockShow} show */
function onDock(show) {
  if (show.mode === 'open') open();
  else if (show.mode === 'closed') fold();
  else showNews(show);
}

// ---------- drawing ----------

let messageTimer = 0;

/** A line under the tiles: what went wrong, or what had to wait. @param {string} text */
function say(text) {
  els.message.textContent = text;
  clearTimeout(messageTimer);
  if (!text) return;
  messageTimer = setTimeout(() => {
    els.message.textContent = '';
    if (state.mode === 'open') shape('open');
  }, MESSAGE_MS);
}

/** A symbol from dock.html. @param {string} id */
function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

/** @param {string} cls @param {string} text */
function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

/** The drawn PlayStation symbols, as in hints.js; Xbox letters stay text. @type {Record<string, string>} */
const SHAPES = { '✕': 'btn-cross', '○': 'btn-circle', '↔': 'btn-adjust' };

function renderHints() {
  els.hint.innerHTML = hints(state.row, state.tile, state.data)
    .map(([button, label]) => {
      const [cls, glyph] = buttonFace(state.padKind, button);
      const face = SHAPES[glyph] ? `<svg aria-hidden="true"><use href="#${SHAPES[glyph]}"/></svg><i>${glyph}</i>` : glyph;
      return `<span><b class="${cls}">${face}</b>${label}</span>`;
    })
    .join('');
}

function tickClock() {
  els.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function render() {
  const d = state.data;
  els.game.textContent = d.game?.name ?? '';
  els.chips.replaceChildren(
    ...chips(d.accessories).map((c) => {
      const chip = span(`chip ${c.tone}`, '');
      chip.append(icon(`i-${c.icon}`), c.text);
      return chip;
    })
  );
  tickClock();

  const muted = !!d.sound?.muted;
  els.volumeIcon.setAttribute('href', muted ? '#i-muted' : '#i-volume');
  els.volumeFill.style.width = `${muted ? 0 : (d.sound?.volume ?? 0)}%`;
  els.volumeText.textContent = volumeText(d.sound);
  els.volume.classList.toggle('muted', muted);
  els.volume.classList.toggle('focus', state.row === 'volume');

  const row = tiles(d);
  // The focused tile may have gone (the game closed): back to Resume.
  if (!row.some((t) => t.key === state.tile)) state.tile = 'resume';
  // Tiles are kept by key, so the focus ring moves between them rather than being drawn anew.
  const kept = new Map([...els.tiles.children].map((el) => [/** @type {HTMLElement} */ (el).dataset.key, el]));
  els.tiles.replaceChildren(
    ...row.map((t) => {
      const el = /** @type {HTMLElement} */ (kept.get(t.key) ?? Object.assign(document.createElement('div'), { className: 'tile slot' }));
      el.dataset.key = t.key;
      el.replaceChildren(icon(`i-${t.icon}`), span('label', t.label), span(`value ${t.tone}`, t.value));
      el.classList.toggle('focus', state.row === 'tiles' && state.tile === t.key);
      return el;
    })
  );

  const choosing = state.row === 'outputs';
  els.outputs.hidden = !choosing;
  els.volume.hidden = choosing;
  els.tiles.hidden = choosing;
  if (choosing) {
    els.outputList.replaceChildren(
      ...(d.sound?.outputs ?? []).map((o, i) => {
        const el = document.createElement('div');
        el.className = 'output slot' + (i === state.output ? ' focus' : '');
        if (i === state.output) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
        el.append(icon(`i-${outputIcon(o.kind)}`), span('', o.name), span('value good', o.default ? 'In use' : ''));
        return el;
      })
    );
  }
  renderHints();
  if (state.mode === 'open') shape('open');
}

// ---------- what the dock knows ----------

/** @template T @param {Promise<T>} call @returns {Promise<T | undefined>} */
const orKeep = (call) => call.catch(() => undefined);

/** Asked so far; only the newest answers are shown, since two refreshes can answer in either order. */
let refreshes = 0;

/** Everything the dock shows, read again each time it opens. */
async function refresh() {
  const asked = ++refreshes;
  const [game, sound, accessories, quiet, overlays] = await Promise.all([
    orKeep(api.dockState()),
    orKeep(api.soundState()),
    orKeep(api.accessoriesState()),
    orKeep(api.quietState()),
    orKeep(api.overlayState()),
  ]);
  if (asked !== refreshes) return;
  const d = state.data;
  if (game !== undefined) d.game = game;
  d.sound = sound ?? d.sound;
  d.accessories = accessories ?? d.accessories;
  d.quiet = quiet ?? d.quiet;
  d.overlays = overlays ?? d.overlays;
  render();
}

/** A reading of the game still on its way: a hung game takes Rust a second per window to tell. */
let readingGame = false;

/** The game again, while the dock is open. */
async function rereadGame() {
  if (readingGame || state.mode !== 'open') return;
  readingGame = true;
  try {
    const game = await orKeep(api.dockState());
    if (game === undefined || state.mode !== 'open') return;
    // Close game turned into Force close: a press already asked for was for the other one.
    if (game?.force_close !== state.data.game?.force_close) state.data.confirm = false;
    state.data.game = game;
    render();
  } finally {
    readingGame = false;
  }
}

/** The headset, a controller or the sound device changed. */
async function refreshAccessories() {
  if (state.mode !== 'open') return;
  const asked = ++refreshes;
  const [accessories, sound] = await Promise.all([orKeep(api.accessoriesState()), orKeep(api.soundState())]);
  if (asked !== refreshes) return;
  state.data.accessories = accessories ?? state.data.accessories;
  state.data.sound = sound ?? state.data.sound;
  render();
}

// ---------- acting ----------

/** NVIDIA's switch toggles and takes up to 2 s to answer; a second press meanwhile would switch the stats back. */
let statsBusy = false;
let quietBusy = false;

/**
 * A command whose failure shows under the tiles; what it changed is drawn after.
 * @param {() => Promise<unknown>} work
 */
async function run(work) {
  try {
    await work();
  } catch (e) {
    say(e.message);
  }
  render();
}

function resume() {
  sfx.back();
  api.dockResume();
}

/** @param {number} delta */
function nudgeVolume(delta) {
  sfx.move();
  run(async () => {
    const volume = await api.soundChangeVolume(delta);
    // Into the sound shown now: a refresh may have replaced it while Windows answered.
    if (state.data.sound) state.data.sound.volume = volume;
  });
}

function toggleMute() {
  sfx.open();
  run(async () => {
    await api.soundSetMute(false, !state.data.sound?.muted);
    state.data.sound = await api.soundState();
  });
}

/** @param {number} dir */
function moveTile(dir) {
  const row = tiles(state.data);
  const at = row.findIndex((t) => t.key === state.tile);
  const next = row[at + dir];
  if (!next) return sfx.edge();
  state.tile = next.key;
  // Close game asks again once the focus has left it.
  state.data.confirm = false;
  sfx.move();
  render();
}

/** @param {'tiles' | 'volume'} row */
function focusRow(row) {
  state.row = row;
  state.data.confirm = false;
  sfx.move();
  render();
}

function select() {
  const d = state.data;
  switch (state.tile) {
    case 'resume':
      return resume();
    case 'output':
      state.row = 'outputs';
      state.output = Math.max(0, d.sound?.outputs.findIndex((o) => o.default) ?? 0);
      sfx.open();
      return render();
    case 'quiet':
      if (quietBusy) return;
      quietBusy = true;
      sfx.open();
      return run(async () => {
        try {
          // Off when the player has it on (that restores what was there, also when only partly applied), else on.
          d.quiet = await api.quietSet(!d.quiet?.active);
          if (d.quiet.notes.length) say(d.quiet.notes.join(' '));
        } finally {
          quietBusy = false;
        }
      });
    case 'stats':
      if (statsBusy) return;
      statsBusy = true;
      sfx.open();
      return run(async () => {
        try {
          d.overlays.nvidia_stats = await api.overlayToggleStats();
        } finally {
          statsBusy = false;
        }
      });
    case 'home':
      sfx.open();
      return api.dockHome();
    case 'close':
      if (!d.game) return;
      sfx.open();
      if (!d.confirm) {
        d.confirm = true;
        return render();
      }
      d.confirm = false;
      return run(async () => {
        await api.dockCloseGame(d.game.force_close);
        d.game = await api.dockState();
      });
  }
}

/** @param {Action} action */
function actOnOutputs(action) {
  const outputs = state.data.sound?.outputs ?? [];
  if (action === 'back') {
    state.row = 'tiles';
    sfx.back();
    return render();
  }
  if (action === 'up' || action === 'down') {
    const next = state.output + (action === 'up' ? -1 : 1);
    if (next < 0 || next >= outputs.length) return sfx.edge();
    state.output = next;
    sfx.move();
    return render();
  }
  const chosen = outputs[state.output];
  if (action !== 'ok' || !chosen) return;
  sfx.open();
  state.row = 'tiles';
  run(async () => {
    state.data.sound = await api.soundSetDefault(chosen.id);
  });
}

/** @param {Action} action @param {'pad' | 'key' | 'mouse'} source */
function act(action, source) {
  if (!counts(state.seen, action, source, performance.now()) || state.mode !== 'open') return;
  if (state.row === 'outputs') return actOnOutputs(action);
  if (action === 'back') return resume();
  if (state.row === 'volume') {
    if (action === 'left' || action === 'right') nudgeVolume(action === 'left' ? -5 : 5);
    else if (action === 'ok') toggleMute();
    else if (action === 'down') focusRow('tiles');
    else if (action === 'up') sfx.edge();
    return;
  }
  if (action === 'left' || action === 'right') moveTile(action === 'left' ? -1 : 1);
  else if (action === 'up') focusRow('volume');
  else if (action === 'ok') select();
  else if (action === 'down') sfx.edge();
}

// ---------- keyboard and mouse ----------

/** @type {Record<string, Action>} */
const KEYS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'ok', Escape: 'back', Backspace: 'back' };

window.addEventListener('keydown', (e) => {
  const action = KEYS[e.key];
  if (!action) return;
  e.preventDefault();
  // Only the arrows repeat, as on the controller: a held Enter mustn't also answer "Press again".
  if (e.repeat && (action === 'ok' || action === 'back')) return;
  act(action, 'key');
});

els.tiles.addEventListener('click', (e) => {
  const tile = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('.tile'));
  if (!tile || state.mode !== 'open') return;
  if (state.row !== 'tiles' || state.tile !== tile.dataset.key) state.data.confirm = false;
  state.row = 'tiles';
  state.tile = /** @type {TileKey} */ (tile.dataset.key);
  act('ok', 'mouse');
});

// A click on the bar sets the volume there.
els.volume.addEventListener('click', (e) => {
  if (state.mode !== 'open') return;
  state.row = 'volume';
  const bar = els.volume.querySelector('.bar').getBoundingClientRect();
  const at = Math.round(((e.clientX - bar.left) / bar.width) * 20) * 5;
  const volume = state.data.sound?.volume;
  if (at >= 0 && at <= 100 && volume != null && at !== volume) nudgeVolume(at - volume);
  else render();
});

els.outputList.addEventListener('click', (e) => {
  const k = [...els.outputList.children].indexOf(/** @type {Element} */ (e.target).closest('.output'));
  if (k < 0) return;
  state.output = k;
  act('ok', 'mouse');
});

// A click beside the dock goes back to the game.
document.addEventListener('click', (e) => {
  if (state.mode === 'open' && !els.island.contains(/** @type {Node} */ (e.target))) resume();
});

window.addEventListener('contextmenu', (e) => e.preventDefault());

let pointerTimer = 0;
window.addEventListener('mousemove', () => {
  document.body.classList.add('pointer');
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => document.body.classList.remove('pointer'), 2000);
});

// ---------- start ----------

window.addEventListener('error', (e) => api.log.error(`dock: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => api.log.error(`dock: unhandled: ${e.reason?.message ?? e.reason}`));

async function init() {
  measure();
  // A spring that overshoots a little and settles: the island's way of opening.
  const { easing, ms } = spring(0.46, 0.7);
  document.documentElement.style.setProperty('--spring', easing);
  document.documentElement.style.setProperty('--spring-ms', `${ms}ms`);
  setInterval(() => state.mode === 'open' && tickClock(), 10_000);
  let heardKind = false;
  await Promise.all([
    api.onDock(onDock),
    api.onDockPad((action) => act(action, 'pad')),
    api.onPadKind((kind) => {
      heardKind = true;
      state.padKind = kind;
      renderHints();
    }),
    api.onAccessories(refreshAccessories),
  ]);
  const kind = await orKeep(api.controllerKind());
  // A "pad-kind" event since is newer than this answer.
  if (kind && !heardKind) state.padKind = kind;
  render();
  api.log.info(`ready: the dock, ${Math.round(performance.now())} ms after its page started`);
}

init();
