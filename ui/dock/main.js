// @ts-check
// The in-game dock's page (dock.html). Rust shows its window over the running game and says when the dock opens, folds
// away or has news (src-tauri/src/dock/); this page draws the island, takes the controller's presses while the dock
// is open, and calls the commands its tiles stand for.

import * as api from '../api.js';
import { accentOf, buttonFace, counts, nothingSeen } from '../logic.js';
import { sfx } from '../sounds.js';
import { HOLD_MS, chips, hints, outputIcon, sessionText, spring, tiles, volumeText } from './logic.js';

/** @typedef {import('./logic.js').TileKey} TileKey */
/** @typedef {import('../api.js').Action | import('../api.js').DockRelease} Step */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const els = {
  island: $('island'),
  backdrop: /** @type {HTMLCanvasElement} */ ($('backdrop')),
  news: $('news'),
  newsIcon: $('newsIcon'),
  newsText: $('newsText'),
  dock: $('dock'),
  cover: /** @type {HTMLImageElement} */ ($('cover')),
  game: $('game'),
  session: $('session'),
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
  ring: $('ring'),
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
/** Lamplit's lamp amber, the island's colour for a game without art. */
const LAMP = [252, 165, 69];

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
  },
  /** @type {import('../api.js').PadKind} */
  padKind: 'dualsense',
  seen: nothingSeen(),
  /** The art the island shows now: its game and files. */
  artFor: '',
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
  cancelHold();
  say('');
  // The ring appears on Resume rather than springing there from where it was last time.
  els.ring.classList.add('instant');
  els.ring.classList.remove('on');
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
  cancelHold();
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

// ---------- the game's art ----------

/**
 * The game's art in the island: its cover beside its name, and its background behind everything, blurred into its
 * colours, which also tint the island.
 * @param {import('../api.js').DockGame | null} game
 */
function showArt(game) {
  const key = game ? `${game.id}|${game.art.portrait}|${game.art.hero}` : '';
  if (key === state.artFor) return;
  state.artFor = key;
  const cover = game?.art.portrait;
  els.cover.hidden = !cover;
  if (cover) els.cover.src = api.assetUrl(cover);
  const wide = game?.art.hero ?? cover;
  if (!wide) return paintBackdrop(null);
  const img = new Image();
  // Read back for its colour, which needs the CORS header Tauri's asset protocol sends.
  img.crossOrigin = 'anonymous';
  img.onload = () => state.artFor === key && paintBackdrop(img);
  img.onerror = () => state.artFor === key && paintBackdrop(null);
  img.src = api.assetUrl(wide);
}

/**
 * Draws the art small and blurred into the backdrop, which the page scales up to the island: a blur that costs nothing
 * while the island springs open, where a CSS blur would be worked out again on every frame.
 * @param {HTMLImageElement | null} img
 */
function paintBackdrop(img) {
  const canvas = els.backdrop;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  els.island.classList.toggle('art', !!img);
  if (!img) return tint(LAMP);
  // A little larger than the canvas, so the blur doesn't darken its edges.
  const scale = Math.max(canvas.width / img.width, canvas.height / img.height) * 1.15;
  const [w, h] = [img.width * scale, img.height * scale];
  ctx.filter = 'blur(5px)';
  ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  ctx.filter = 'none';
  // The art's colour, as the home screen picks a game's accent.
  tint(accentOf(ctx.getImageData(0, 0, canvas.width, canvas.height).data));
}

/** @param {number[]} rgb */
function tint(rgb) {
  document.documentElement.style.setProperty('--game', rgb.map(Math.round).join(' '));
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

/** The ring that fills around Close game's icon while Cross is held. */
function holdRing() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('hold');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('aria-hidden', 'true');
  for (const cls of ['track', 'fill']) {
    const c = document.createElementNS(ns, 'circle');
    c.classList.add(cls);
    for (const [k, v] of [['cx', '20'], ['cy', '20'], ['r', '18'], ['pathLength', '100']]) c.setAttribute(k, v);
    svg.append(c);
  }
  return svg;
}

/** The drawn PlayStation symbols and d-pad arrows; Xbox letters stay text. @type {Record<string, string>} */
const SHAPES = { '✕': 'btn-cross', '○': 'btn-circle', '↔': 'btn-adjust', '↑': 'btn-up', '↓': 'btn-down' };

/** @param {import('./logic.js').DockButton} button @returns {[string, string]} */
const face = (button) =>
  button === 'up' ? ['options', '↑'] : button === 'down' ? ['options', '↓'] : buttonFace(state.padKind, button);

function renderHints() {
  els.hint.innerHTML = hints(state.row, state.tile, state.data)
    .map(([button, label]) => {
      const [cls, glyph] = face(button);
      const drawn = SHAPES[glyph] ? `<svg aria-hidden="true"><use href="#${SHAPES[glyph]}"/></svg><i>${glyph}</i>` : glyph;
      return `<span><b class="${cls}">${drawn}</b>${label}</span>`;
    })
    .join('');
}

/** The time, and how long the game has been played, which move on while the dock is open. */
function tick() {
  els.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const game = state.data.game;
  els.session.textContent = sessionText(game, Date.now() / 1000);
  els.session.classList.toggle('warn', !!game && !game.responding);
}

/** The tile with `key`, if the row has it. @param {TileKey} key */
const tileEl = (key) => /** @type {HTMLElement | null} */ (els.tiles.querySelector(`[data-key="${key}"]`));

function render() {
  const d = state.data;
  els.game.textContent = d.game?.name ?? '';
  showArt(d.game);
  tick();
  els.chips.replaceChildren(
    ...chips(d.accessories).map((c) => {
      const chip = span(`chip ${c.tone}`, '');
      const battery = span('battery', '');
      battery.style.setProperty('--level', String(c.level / 100));
      chip.append(icon(`i-${c.icon}`), battery, c.text);
      return chip;
    })
  );

  const muted = !!d.sound?.muted;
  els.volumeIcon.setAttribute('href', muted ? '#i-muted' : '#i-volume');
  els.volumeFill.style.width = `${muted ? 0 : (d.sound?.volume ?? 0)}%`;
  els.volumeText.textContent = volumeText(d.sound);
  els.volume.classList.toggle('muted', muted);
  els.volume.classList.toggle('focus', state.row === 'volume');

  const row = tiles(d);
  // The focused tile may have gone (the game closed): back to Resume.
  if (!row.some((t) => t.key === state.tile)) state.tile = 'resume';
  // Tiles are kept by key, and stay in the page while the row is the same: taking one out would cut short its
  // transitions, such as a hold's ring filling up.
  const kept = new Map([...els.tiles.children].map((el) => [/** @type {HTMLElement} */ (el).dataset.key, el]));
  const wanted = row.map((t, i) => {
    let el = /** @type {HTMLElement | undefined} */ (kept.get(t.key));
    if (!el) {
      el = document.createElement('div');
      el.dataset.key = t.key;
      const glyph = span('glyph', '');
      if (t.key === 'close') glyph.append(holdRing());
      glyph.append(icon(''));
      el.append(glyph, span('label', ''));
    }
    el.classList.add('tile', 'slot');
    el.classList.toggle('primary', t.key === 'resume');
    el.classList.toggle('on', t.on);
    el.classList.toggle('warn', t.tone === 'warn');
    el.classList.toggle('focus', state.row === 'tiles' && state.tile === t.key);
    el.classList.toggle('holding', t.key === 'close' && holding !== 0);
    el.style.setProperty('--i', String(i + 1));
    /** @type {SVGUseElement} */ (el.querySelector('.icon use')).setAttribute('href', `#i-${t.icon}`);
    /** @type {HTMLElement} */ (el.querySelector('.label')).textContent = t.label;
    return el;
  });
  if (wanted.some((el, i) => els.tiles.children[i] !== el) || els.tiles.children.length !== wanted.length) {
    els.tiles.replaceChildren(...wanted);
  }
  els.hint.style.setProperty('--i', String(row.length + 1));

  const choosing = state.row === 'outputs';
  els.outputs.hidden = !choosing;
  els.tiles.classList.toggle('away', choosing);
  if (choosing) {
    els.outputList.replaceChildren(
      ...(d.sound?.outputs ?? []).map((o, i) => {
        const el = document.createElement('div');
        el.className = 'output slot' + (i === state.output ? ' focus' : '');
        if (i === state.output) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
        el.append(icon(`i-${outputIcon(o.kind)}`), span('', o.name), span('value', o.default ? 'In use' : ''));
        return el;
      })
    );
  }
  renderHints();
  if (state.mode === 'open') shape('open');
  placeRing();
}

/** What has the focus now: the volume, a tile, or an output. */
function focused() {
  if (state.row === 'volume') return els.volume;
  if (state.row === 'outputs') return /** @type {HTMLElement | null} */ (els.outputList.querySelector('.output.focus'));
  return tileEl(state.tile);
}

/**
 * Moves the focus ring onto what has the focus, from where it was: it springs there. Laid out from the dock's own
 * boxes, so a tile still coming in, or the island still opening, doesn't throw it off. The volume draws its own
 * ring, since it changes size as it opens.
 */
function placeRing() {
  const el = focused();
  els.ring.classList.toggle('on', !!el && state.row !== 'volume');
  if (!el || state.mode !== 'open' || state.row === 'volume') return;
  // After this frame's layout: a list of outputs that just opened has no boxes yet.
  requestAnimationFrame(() => {
    let [x, y, n] = [0, 0, /** @type {HTMLElement | null} */ (el)];
    while (n && n !== els.dock) {
      x += n.offsetLeft;
      y += n.offsetTop;
      n = /** @type {HTMLElement | null} */ (n.offsetParent);
    }
    if (els.outputList.contains(el)) y -= els.outputList.scrollTop;
    const r = els.ring.style;
    r.setProperty('--x', `${x}px`);
    r.setProperty('--y', `${y}px`);
    r.setProperty('--w', `${el.offsetWidth}px`);
    r.setProperty('--h', `${el.offsetHeight}px`);
    r.setProperty('--r', getComputedStyle(el).borderRadius);
    els.ring.classList.add('on');
    requestAnimationFrame(() => els.ring.classList.remove('instant'));
  });
}

// ---------- what the dock knows ----------

/** @template T @param {Promise<T>} call @returns {Promise<T | undefined>} */
const orKeep = (call) => call.catch(() => undefined);

/**
 * Readings asked so far, by the part of what the dock knows that they read. Readings of one part can answer in either
 * order, so only the newest one asked is kept; the parts are read on their own (the game every 2 s, the sound and the
 * accessories when they change), and one part's newer reading mustn't throw away another's answer.
 */
const asked = { game: 0, sound: 0, accessories: 0, quiet: 0, overlays: 0 };

/**
 * Reads the parts named in `reads` together, keeps each answer that is still the newest asked for its part, and
 * draws the dock. A part whose reading failed stays as it was.
 * @param {{ [P in keyof typeof asked]?: () => Promise<any> }} reads
 */
async function read(reads) {
  const parts = /** @type {(keyof typeof asked)[]} */ (Object.keys(reads));
  const asks = parts.map((part) => ++asked[part]);
  const answers = await Promise.all(parts.map((part) => orKeep(reads[part]())));
  parts.forEach((part, i) => {
    const answer = answers[i];
    if (asks[i] !== asked[part] || answer === undefined) return;
    if (part === 'game') setGame(answer);
    else state.data[part] = answer ?? state.data[part];
  });
  render();
}

/**
 * The game as Rust reads it now. Cross held on Close game was for the game and the offer the player saw: when the
 * offer turned into Force close, or another game runs now, the hold is let go and has to start again.
 * @param {import('../api.js').DockGame | null} game
 */
function setGame(game) {
  const was = state.data.game;
  const changed = game?.id !== was?.id || game?.session !== was?.session || game?.force_close !== was?.force_close;
  if (changed) cancelHold();
  state.data.game = game;
}

/** Everything the dock shows, read again each time it opens. */
function refresh() {
  return read({
    game: api.dockState,
    sound: api.soundState,
    accessories: api.accessoriesState,
    quiet: api.quietState,
    overlays: api.overlayState,
  });
}

/** A reading of the game still on its way: a hung game takes Rust a second per window to tell. */
let readingGame = false;

/** The game again, while the dock is open. */
async function rereadGame() {
  if (readingGame || state.mode !== 'open') return;
  readingGame = true;
  try {
    await read({ game: api.dockState });
  } finally {
    readingGame = false;
  }
}

/** The headset, a controller or the sound device changed. */
function refreshAccessories() {
  if (state.mode !== 'open') return;
  return read({ accessories: api.accessoriesState, sound: api.soundState });
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
  sfx.move();
  render();
}

/** @param {'tiles' | 'volume'} row */
function focusRow(row) {
  state.row = row;
  sfx.move();
  render();
}

/** Cross is held on Close game: the game closes once it has been held HOLD_MS. */
let holding = 0;

function startHold() {
  const el = tileEl('close');
  const game = state.data.game;
  if (!el || !game) return;
  el.style.setProperty('--hold-ms', `${HOLD_MS}ms`);
  el.classList.add('holding');
  sfx.move();
  // What the player holds Cross for: this game, in this session, with this offer, whatever is read meanwhile.
  const target = { force: game.force_close, id: game.id, session: game.session };
  holding = setTimeout(() => closeGame(target), HOLD_MS);
}

/** Let go before the ring was full, or the offer changed underneath: nothing closes. */
function cancelHold() {
  if (!holding) return;
  clearTimeout(holding);
  holding = 0;
  tileEl('close')?.classList.remove('holding');
}

/** @param {{ force: boolean, id: string, session: number }} target */
function closeGame(target) {
  holding = 0;
  const el = tileEl('close');
  el?.classList.remove('holding');
  el?.classList.add('closing');
  setTimeout(() => el?.classList.remove('closing'), 450);
  sfx.launch();
  // The game as the dock showed it when the hold began, which may be what it knew before Rust's answer: Rust closes
  // nothing else. What Rust answers shows first; the game is read again after.
  run(() => api.dockCloseGame(target.force, target.id, target.session)).then(rereadGame);
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
      return startHold();
  }
}

/** @param {Step} action */
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

/** @param {Step} action @param {'pad' | 'key' | 'mouse'} source */
function act(action, source) {
  if (!counts(state.seen, action, source, performance.now()) || state.mode !== 'open') return;
  // Letting go of Cross only matters to a hold; any other press ends one too.
  if (action === 'ok-up') return cancelHold();
  cancelHold();
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

/** @type {Record<string, Step>} */
const KEYS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'ok', Escape: 'back', Backspace: 'back' };

window.addEventListener('keydown', (e) => {
  const action = KEYS[e.key];
  if (!action) return;
  e.preventDefault();
  // Only the arrows repeat, as on the controller: a held Enter is one hold, not a run of presses.
  if (e.repeat && (action === 'ok' || action === 'back')) return;
  act(action, 'key');
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Enter') act('ok-up', 'key');
});

// A tile takes a click, as Cross; Close game takes the mouse button held down.
els.tiles.addEventListener('pointerdown', (e) => {
  const tile = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('.tile'));
  if (tile?.dataset.key !== 'close' || state.mode !== 'open') return;
  state.row = 'tiles';
  state.tile = 'close';
  render();
  act('ok', 'mouse');
});
els.tiles.addEventListener('click', (e) => {
  const tile = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('.tile'));
  if (!tile || state.mode !== 'open' || tile.dataset.key === 'close') return;
  state.row = 'tiles';
  state.tile = /** @type {TileKey} */ (tile.dataset.key);
  act('ok', 'mouse');
});
for (const ended of ['pointerup', 'pointercancel', 'pointerleave']) els.tiles.addEventListener(ended, () => act('ok-up', 'mouse'));

// A click on the bar sets the volume there.
els.volume.addEventListener('click', (e) => {
  if (state.mode !== 'open') return;
  state.row = 'volume';
  const bar = /** @type {HTMLElement} */ (els.volume.querySelector('.bar')).getBoundingClientRect();
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
  // The island opens on a spring that overshoots a little and settles; the focus ring moves on a quicker one.
  for (const [name, { easing, ms }] of Object.entries({ spring: spring(0.46, 0.7), snap: spring(0.3, 0.78) })) {
    document.documentElement.style.setProperty(`--${name}`, easing);
    document.documentElement.style.setProperty(`--${name}-ms`, `${ms}ms`);
  }
  setInterval(() => state.mode === 'open' && tick(), 10_000);
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
