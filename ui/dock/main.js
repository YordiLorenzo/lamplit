// @ts-check
// The in-game dock's page (dock.html). Rust shows its window over the running game and says when the dock opens, folds
// away or has news (src-tauri/src/dock/); this page draws the island, takes the controller's presses while the dock
// is open, and calls the commands its tiles stand for.

import * as api from '../api.js';
import { accentOf, buttonFace, counts, nothingSeen, quietMode } from '../logic.js';
import { meter } from '../frames.js';
import { steady } from '../steady.js';
import { sfx } from '../sounds.js';
import { HOLD_MS, chips, hints, outputIcon, sessionText, spring, tiles, volumeText } from './logic.js';

/** @typedef {import('./logic.js').TileKey} TileKey */
/** @typedef {import('../api.js').Action | import('../api.js').DockRelease} Step */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const els = {
  island: $('island'),
  shade: $('shade'),
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
/** How long the output just chosen shows in use before the list closes. */
const PICKED_MS = 650;
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
  /** @type {string | null} the output just chosen, shown in use for a moment before the list closes */
  picked: null,
  /** Going home: the veil is coming, and only Circle (back to the game) still counts. */
  leaving: false,
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

/**
 * The island takes the size of the face it shows. Folding, it keeps its size and only fades and shrinks a little,
 * which the compositor does alone (on the glass under it too, dock/mod.rs fold); once out of sight it is the pill
 * again (rest).
 * @param {'gone' | 'news' | 'open'} mode
 */
function shape(mode) {
  if (mode === 'gone') return squeeze();
  const face = mode === 'open' ? els.dock : els.news;
  const [width, height] = [`${face.offsetWidth}px`, `${face.offsetHeight}px`];
  // What the island shows now: a dock that has just opened is still the pill until its frames come on time (open).
  const from = els.island.dataset.mode;
  const moves = mode !== from || width !== els.island.style.width || height !== els.island.style.height;
  if (moves) dropGlass();
  if (from === 'gone') unfold(face);
  state.mode = mode;
  for (const el of [els.island, els.shade]) {
    el.dataset.mode = mode;
    el.classList.remove('rested');
    el.style.width = width;
    el.style.height = height;
  }
  els.island.style.setProperty('--fold-x', '0px');
  els.island.style.setProperty('--fold-y', '0px');
  if (moves && mode === 'open') glassTimer = setTimeout(takeGlass, springMs + SETTLE_MS);
}

/**
 * Opening, or showing news, from the pill: the island takes the size of `face` at once, still clipped to the pill at
 * its bottom centre, and the clip springs open (dock.css), as folding squeezes it, so nothing is laid out per frame.
 * @param {HTMLElement} face
 */
function unfold(face) {
  const u = screen.height / 100;
  const [width, height] = [face.offsetWidth, face.offsetHeight];
  for (const el of [els.island, els.shade]) {
    el.style.transition = 'none';
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
  }
  els.island.style.setProperty('--fold-x', `${Math.max(0, (width - PILL.width * u) / 2)}px`);
  els.island.style.setProperty('--fold-y', `${Math.max(0, height - PILL.height * u)}px`);
  void els.island.offsetWidth;
  els.island.style.transition = '';
  els.shade.style.transition = '';
}

/** The pill the island folds into, as dock.css draws it: its width, height and corners, in hundredths of the screen. */
const PILL = { width: 18, height: 5.2, round: 2.6 };

/**
 * Folding: the island keeps its size, and a clip squeezes it into the pill at its bottom centre on the opening's
 * spring (dock.css), which then drops onto the edge and goes. Rust squeezes the real glass under it the same way. With
 * reduced motion the island fades where it is, and so does the glass.
 */
function squeeze() {
  clearTimeout(glassTimer);
  const u = screen.height / 100;
  const [x, y] = [Math.max(0, (els.island.offsetWidth - PILL.width * u) / 2), Math.max(0, els.island.offsetHeight - PILL.height * u)];
  els.island.style.setProperty('--fold-x', `${x}px`);
  els.island.style.setProperty('--fold-y', `${y}px`);
  if (els.island.classList.contains('glass')) {
    const box = els.island.getBoundingClientRect();
    const k = devicePixelRatio;
    const to = { x: (box.x + x) * k, y: (box.y + y) * k, width: PILL.width * u * k, height: PILL.height * u * k, radius: PILL.round * u * k };
    const fold = reduced()
      ? { to: glassShape(), ms: 1, curve: [0, 1], after: 0, fade: FADE_MS, drop: 0 }
      : { to, ms: springMs, curve: springCurve, after: springMs * 0.5, fade: 200, drop: 2.4 * u * k };
    api.dockGlassFold(fold).catch(() => {});
  }
  state.mode = 'gone';
  els.island.dataset.mode = 'gone';
  els.shade.dataset.mode = 'gone';
}

/** How long folding takes: the squeeze, then the drop (dock.css). Rust hides the window then (dock/mod.rs FOLD). */
const FOLD_MS = 520;
/** Windows' animation effects are off: the island fades in place in FADE_MS rather than springing (dock.css). */
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const FADE_MS = 150;
let restTimer = 0;

/**
 * Folded out of sight: the island is the pill again, on the art's glass, for the next time it springs open. Without
 * its transitions: nothing shows.
 */
function rest() {
  if (state.mode !== 'gone') return;
  ++glassAsks;
  els.island.classList.remove('glass');
  for (const el of [els.island, els.shade]) {
    el.style.transition = 'none';
    el.classList.add('rested');
    el.style.width = '';
    el.style.height = '';
  }
  els.island.style.setProperty('--fold-x', '0px');
  els.island.style.setProperty('--fold-y', '0px');
  void els.island.offsetWidth;
  els.island.style.transition = '';
  els.shade.style.transition = '';
}

// ---------- real glass ----------

/** After the island's spring (its delay and a frame or two): it rests, and real glass can go under it. */
const SETTLE_MS = 140;
let springMs = 520;
/** The spring's way from 0 to 1, for Rust to squeeze the glass on (logic.js spring). @type {number[]} */
let springCurve = [0, 1];
let glassTimer = 0;
/** Counts the asks for glass, so an answer to an earlier one is let go. */
let glassAsks = 0;

/**
 * Real glass under the island once it rests open: Windows' blur of the game, live, cut to the island's shape
 * (src-tauri win/glass.rs). Where Windows can't, the island keeps its glass made of the game's art.
 */
async function takeGlass() {
  if (state.mode !== 'open') return;
  const asked = ++glassAsks;
  const on = await api.dockGlass(glassShape()).catch(() => false);
  if (on && asked === glassAsks && state.mode === 'open') els.island.classList.add('glass');
}

/** Where the island is, and its corners, in the window's pixels, for the real glass. */
function glassShape() {
  const box = els.island.getBoundingClientRect();
  const k = devicePixelRatio;
  const radius = parseFloat(getComputedStyle(els.island).borderTopLeftRadius) * k;
  return { x: box.x * k, y: box.y * k, width: box.width * k, height: box.height * k, radius };
}

/** Before the island moves: its own glass is back at once, and the real glass goes once that has been drawn. */
function dropGlass() {
  clearTimeout(glassTimer);
  if (!els.island.classList.contains('glass')) return;
  const asked = ++glassAsks;
  els.island.classList.remove('glass');
  requestAnimationFrame(() => requestAnimationFrame(() => asked === glassAsks && api.dockGlass(null)));
}

let newsTimer = 0;
let gameTimer = 0;
/** Counts the openings, so one that a fold came before doesn't open. */
let openings = 0;
/** The dock is open and shows so: not in its first frames, while it waits to spring open (open). */
const shown = () => state.mode === 'open' && els.island.dataset.mode === 'open';
/** The longest the spring waits for the frames to come on time after the window shows (steady). */
const STEADY_MS = 100;

function open() {
  state.leaving = false;
  document.body.classList.remove('home', 'lift');
  clearTimeout(newsTimer);
  measure();
  state.row = 'tiles';
  state.tile = 'resume';
  cancelHold();
  say('');
  // The ring comes on Resume with Resume itself, rather than springing there from where it was last time (dock.css).
  els.ring.classList.add('instant');
  els.ring.classList.remove('on');
  // Open at once for the controller, the keyboard and the answers drawn meanwhile.
  state.mode = 'open';
  render();
  // The island takes its size while it shows nothing yet, so the spring has only its clip to move.
  if (els.island.dataset.mode === 'gone') unfold(els.dock);
  // The window has just come up over the game, and its first frames come late while Windows composes the screen anew,
  // for one frame or a few: the spring starts once they come on time.
  const mine = ++openings;
  steady(
    () => {
      if (mine !== openings) return;
      shape('open');
      meter('dock: open', springMs + 130);
      // Its fade has started with the tiles': from here on it springs from what had the focus to what has it.
      requestAnimationFrame(() => els.ring.classList.remove('instant'));
    },
    { cap: STEADY_MS }
  );
  sfx.open();
  refresh();
  clearInterval(gameTimer);
  gameTimer = setInterval(rereadGame, GAME_EVERY_MS);
}

function fold() {
  ++openings;
  clearTimeout(newsTimer);
  clearInterval(gameTimer);
  cancelHold();
  // Going home, the home screen is behind the veil now (or Circle went back to the game): the veil lifts.
  if (state.leaving) document.body.classList.add('lift');
  if (state.mode === 'gone') return;
  shape('gone');
  meter('dock: fold', FOLD_MS);
  clearTimeout(restTimer);
  restTimer = setTimeout(rest, FOLD_MS + 40);
}

/**
 * Home: a veil in the game's colours comes over the game, on the whole screen, which the open dock's window covers,
 * and the island grows into it. Rust brings the home screen forward behind the veil, then folds the dock, which lifts
 * the veil off it (dock/mod.rs home).
 */
function goHome() {
  sfx.open();
  state.leaving = true;
  document.body.classList.add('home');
  meter('dock: home', 240);
  // Rust fades the real glass with the island as it grows into the veil (dock/mod.rs home). With reduced motion the
  // island only fades, on its own glass: the real glass goes first.
  if (reduced() && els.island.classList.contains('glass')) {
    dropGlass();
    requestAnimationFrame(() => requestAnimationFrame(() => api.dockHome()));
  } else {
    api.dockHome();
  }
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
  newsTimer = setTimeout(fold, NEWS_HOLD_MS);
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
  // Only a blur of it shows: a small copy, scaled where the browser decodes it, rather than the 3840 pixel wide art
  // decoded on the page's thread.
  img.onload = () =>
    createImageBitmap(img, { resizeWidth: 256, resizeQuality: 'medium' }).then(
      (small) => state.artFor === key && paintBackdrop(small),
      () => state.artFor === key && paintBackdrop(null)
    );
  img.onerror = () => state.artFor === key && paintBackdrop(null);
  img.src = api.assetUrl(wide);
}

/**
 * Draws the art small and blurred into the backdrop, which the page scales up to the island: a blur that costs nothing
 * while the island springs open, where a CSS blur would be worked out again on every frame.
 * @param {ImageBitmap | null} img
 */
function paintBackdrop(img) {
  const canvas = els.backdrop;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  els.island.classList.toggle('art', !!img);
  if (!img) return tint(LAMP);
  // A little larger than the canvas, so the blur doesn't darken its edges.
  const scale = Math.max(canvas.width / img.width, canvas.height / img.height) * 1.4;
  const [w, h] = [img.width * scale, img.height * scale];
  ctx.filter = 'blur(12px)';
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
    if (shown()) shape('open');
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
  const html = hints(state.row, state.tile, state.data)
    .map(([button, label]) => {
      const [cls, glyph] = face(button);
      const drawn = SHAPES[glyph] ? `<svg aria-hidden="true"><use href="#${SHAPES[glyph]}"/></svg><i>${glyph}</i>` : glyph;
      return `<span><b class="${cls}">${drawn}</b>${label}</span>`;
    })
    .join('');
  if (els.hint.innerHTML !== html) els.hint.innerHTML = html;
}

/**
 * Writes `text` into `el` only when it differs: the dock is drawn again on every answer from Rust, and an unchanged
 * text written again still has the page laid out anew.
 * @param {HTMLElement} el
 * @param {string} text
 */
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** The symbol an icon shows, set only when it changes, as setText. @param {Element} use @param {string} href */
function setHref(use, href) {
  if (use.getAttribute('href') !== href) use.setAttribute('href', href);
}

/** The time, and how long the game has been played, which move on while the dock is open. */
function tick() {
  setText(els.clock, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
  const game = state.data.game;
  setText(els.session, sessionText(game, Date.now() / 1000));
  els.session.classList.toggle('warn', !!game && !game.responding);
}

/** The tile with `key`, if the row has it. @param {TileKey} key */
const tileEl = (key) => /** @type {HTMLElement | null} */ (els.tiles.querySelector(`[data-key="${key}"]`));

function render() {
  const d = state.data;
  // The list of outputs opening grows out of its tile (grow): where the tile is, before anything moves.
  const tile = state.row === 'outputs' && els.outputs.hidden ? tileEl('output')?.getBoundingClientRect() : undefined;
  setText(els.game, d.game?.name ?? '');
  showArt(d.game);
  tick();
  const batteries = chips(d.accessories);
  const drawn = JSON.stringify(batteries);
  if (els.chips.dataset.drawn !== drawn) {
    els.chips.dataset.drawn = drawn;
    els.chips.replaceChildren(
      ...batteries.map((c) => {
        const chip = span(`chip ${c.tone}`, '');
        const battery = span('battery', '');
        battery.style.setProperty('--level', String(c.level / 100));
        chip.append(icon(`i-${c.icon}`), battery, c.text);
        return chip;
      })
    );
  }

  const muted = !!d.sound?.muted;
  setHref(els.volumeIcon, muted ? '#i-muted' : '#i-volume');
  els.volumeFill.style.width = `${muted ? 0 : (d.sound?.volume ?? 0)}%`;
  setText(els.volumeText, volumeText(d.sound));
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
    setHref(/** @type {SVGUseElement} */ (el.querySelector('.icon use')), `#i-${t.icon}`);
    setText(/** @type {HTMLElement} */ (el.querySelector('.label')), t.label);
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
        // The one just chosen counts as in use while Windows switches to it.
        const current = state.picked ? o.id === state.picked : o.default;
        el.className = 'output slot' + (i === state.output ? ' focus' : '') + (current ? ' current' : '');
        el.classList.toggle('picked', o.id === state.picked);
        if (i === state.output) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
        const mark = span('value', '');
        if (current) {
          const check = span('check', '');
          check.append(icon('i-check'));
          mark.append(check, 'In use');
        }
        el.append(icon(`i-${outputIcon(o.kind)}`), span('', o.name), mark);
        return el;
      })
    );
  }
  if (tile) grow(tile);
  renderHints();
  if (shown()) shape('open');
  placeRing();
}

/**
 * The list of outputs grows out of its tile: clipped to the tile and on the tile's fill at first, it springs open with
 * the island as its rows fade in (dock.css #outputs).
 * @param {DOMRect} tile
 */
function grow(tile) {
  const list = els.outputs.getBoundingClientRect();
  const from = { top: tile.top - list.top, right: list.right - tile.right, bottom: list.bottom - tile.bottom, left: tile.left - list.left };
  for (const [side, px] of Object.entries(from)) els.outputs.style.setProperty(`--from-${side}`, `${px}px`);
  els.outputs.classList.add('from-tile');
  void els.outputs.offsetWidth;
  els.outputs.classList.remove('from-tile');
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
    // From the dock's bottom (dock.css #ring).
    r.setProperty('--y', `${y + el.offsetHeight - els.dock.offsetHeight}px`);
    r.setProperty('--w', `${el.offsetWidth}px`);
    r.setProperty('--h', `${el.offsetHeight}px`);
    r.setProperty('--r', getComputedStyle(el).borderRadius);
    els.ring.classList.add('on');
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

/**
 * A game started: everything the dock shows is read and drawn now, while its window is hidden, with the art decoded
 * and blurred, so the first opening has nothing to do but open.
 */
async function prepare() {
  if (state.mode !== 'gone') return;
  await refresh();
  await els.cover.decode().catch(() => {});
  if (state.mode !== 'gone') return;
  // A rehearsal: the open dock's styles and layout worked out once, without its transitions, and put back.
  document.body.classList.add('rehearsing');
  for (const el of [els.island, els.shade]) el.dataset.mode = 'open';
  void els.dock.offsetWidth;
  for (const el of [els.island, els.shade]) el.dataset.mode = 'gone';
  void els.dock.offsetWidth;
  document.body.classList.remove('rehearsing');
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
          say(d.quiet.notes.length ? d.quiet.notes.join(' ') : quietMode(d.quiet).note);
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
      return goHome();
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
  if (action !== 'ok' || !chosen || state.picked) return;
  // The check moves to the one chosen at once; the list closes once Windows has switched, and the player has seen it.
  state.picked = chosen.id;
  sfx.open();
  render();
  const seen = new Promise((resolve) => setTimeout(resolve, PICKED_MS));
  run(async () => {
    state.data.sound = await api.soundSetDefault(chosen.id);
  }).then(async () => {
    await seen;
    state.picked = null;
    if (state.row === 'outputs') state.row = 'tiles';
    render();
  });
}

/** @param {Step} action @param {'pad' | 'key' | 'mouse'} source */
function act(action, source) {
  if (!counts(state.seen, action, source, performance.now()) || state.mode !== 'open') return;
  if (state.leaving) return action === 'back' ? resume() : undefined;
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
  // The island opens on a spring that overshoots a little and settles. The focus ring, the volume and a focused tile
  // move on a quicker one that doesn't: a press, with nothing thrown.
  for (const [name, { easing, ms, points }] of Object.entries({ spring: spring(0.46, 0.7), snap: spring(0.28, 0.9) })) {
    document.documentElement.style.setProperty(`--${name}`, easing);
    document.documentElement.style.setProperty(`--${name}-ms`, `${ms}ms`);
    if (name === 'spring') [springMs, springCurve] = [ms, points];
  }
  setInterval(() => state.mode === 'open' && tick(), 10_000);
  let heardKind = false;
  await Promise.all([
    api.onDock(onDock),
    api.onPlay((play) => play.state === 'running' && prepare()),
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
// Measurement builds only (src-tauri/src/probe.rs): the frame probe.
if (/** @type {any} */ (window).__LAMPLIT_PROBE__) import('../probe.js');
