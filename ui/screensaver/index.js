// @ts-check
// Lamplit's screensaver: after a few minutes without input from a controller, the keyboard or the mouse, while Lamplit
// is in front and no game runs, generative art coloured from the player's own games covers the screen, so a still home
// screen can't mark an OLED TV. The first press only wakes it: it never also acts on what is underneath.

import * as api from '../api.js';
import { SAVER_DEFAULT, rowOf } from '../logic.js';
import { state } from '../state.js';
import { medianCut, scenePalette } from './palette.js';
import { Saver, pixelsOf } from './saver.js';

/**
 * @typedef {import('./saver.js').Look} Look
 * @typedef {import('./palette.js').Palette} Palette
 */

/**
 * After a wake, more of the same is swallowed until it pauses this long: a held direction, which Rust repeats every
 * 70 to 380 ms, and a key Steam mirrors from the controller, which comes within a few ms of the press.
 */
const GRACE_MS = 450;
/**
 * The pointer has to move this far from where it was to wake the screensaver. Chromium also sends a mousemove when the
 * page under a still pointer changes, and a touchpad used as a mouse twitches.
 */
const POINTER_PX = 8;
/** The games whose art colours the show: favourites first, then the most recently played. */
const GAMES = 8;

/** @type {Saver | null} made on the first show */
let saver = null;
let showing = false;
/** Palettes are on their way; the show starts once they are in, unless someone pressed something meanwhile. */
let preparing = false;
let lastInput = performance.now();
/** What a wake swallows for a moment: more of the same press, and anything else that soon. */
let swallow = { action: '', until: 0 };
/** The key that woke it, whose repeats are swallowed until it is let go. */
let heldKey = '';
/** Where the pointer was last seen, and where it was when the screensaver showed. */
let pointer = { x: NaN, y: NaN };
let anchor = { x: NaN, y: NaN };

/** Lamplit is in front and no game runs. */
const allowed = () => !state.running && !document.hidden && document.hasFocus();
const minutes = () => state.prefs?.screensaver_minutes ?? SAVER_DEFAULT.minutes;

/**
 * @param {string} action
 * @param {number} now
 */
function woke(action, now) {
  hide();
  swallow = { action, until: now + GRACE_MS };
  lastInput = now;
}

/**
 * A press from the controller (input.js act): true when it only wakes the screensaver, or is more of the press that
 * did, and does nothing else.
 * @param {string} action
 */
export function wake(action) {
  const now = performance.now();
  if (now < swallow.until) {
    // A key or a click woke it: the first controller press in the grace is that same press (Steam mirrors the
    // controller as keys, and the key can come first), so a held direction's repeats go on extending the grace.
    if (!swallow.action) swallow.action = action;
    if (action === swallow.action) swallow.until = now + GRACE_MS;
    return true;
  }
  if (showing) {
    woke(action, now);
    return true;
  }
  lastInput = now;
  return false;
}

/** Settings > Screensaver > Show it now. The press that asked for it, and a key Steam mirrors from it, don't end it. */
export function showScreensaver() {
  const now = performance.now();
  swallow = { action: 'ok', until: now + GRACE_MS };
  show(now);
}

/** @param {number} [asked]  when the show was asked for; input after that calls it off */
async function show(asked = performance.now()) {
  if (showing || preparing) return;
  preparing = true;
  const looks = await gameLooks();
  preparing = false;
  if (lastInput > asked || !allowed()) return;
  showing = true;
  anchor = pointer;
  saver ??= makeSaver();
  saver.setStyle(state.prefs?.screensaver_style ?? SAVER_DEFAULT.style);
  saver.setLooks(looks);
  saver.start();
  const why = saver.reason ? ` (${saver.reason})` : '';
  api.log.info(`screensaver on: ${saver.root.dataset.mode}${why}, colours from ${looks.length} game${looks.length === 1 ? '' : 's'}`);
}

function makeSaver() {
  const root = document.createElement('div');
  root.id = 'saver';
  document.body.append(root);
  // A game that starts, or Lamplit leaving the front, ends the show on the next frame.
  return new Saver(root, { keepGoing: allowed, onEnd: hide });
}

function hide() {
  if (!showing) return;
  showing = false;
  saver?.stop();
}

// ---------- colours from the games ----------

/** @type {Map<string, Promise<Palette | null>>} per art file */
const palettes = new Map();

/** The art's colours, worked out once per file. @param {string} path */
function paletteOf(path) {
  let palette = palettes.get(path);
  if (!palette) {
    const img = new Image();
    // Tauri's asset protocol sends the CORS header, so the canvas can be read back (as for the accent in library.js).
    img.crossOrigin = 'anonymous';
    img.src = api.assetUrl(path);
    palette = img
      .decode()
      .then(() => scenePalette(medianCut(pixelsOf(img, 48, 27), 8)))
      .catch(() => null);
    palettes.set(path, palette);
  }
  return palette;
}

/** One look per game with art, in the row's order. @returns {Promise<Look[]>} */
async function gameLooks() {
  const games = rowOf(state.all, { query: '', store: null, sort: 'played' })
    .filter((g) => g.art.hero || g.art.portrait)
    .slice(0, GAMES);
  const looks = await Promise.all(
    games.map(async (g) => {
      const palette = await paletteOf(/** @type {string} */ (g.art.hero || g.art.portrait));
      return palette && { palette, name: g.name, logo: g.art.logo ? api.assetUrl(g.art.logo) : null };
    })
  );
  return /** @type {Look[]} */ (looks.filter(Boolean));
}

// ---------- input ----------

/**
 * Keys reach this before input.js: any key wakes the screensaver, the arrows and Enter as much as the letters Find
 * would type, and none of them goes on to act.
 * @param {KeyboardEvent} e
 */
function onKey(e) {
  const now = performance.now();
  const more = now < swallow.until || (e.repeat && e.key === heldKey);
  if (!more && !showing) {
    lastInput = now;
    return;
  }
  // A key held down since before the screensaver showed only repeats; it takes a fresh press to wake it.
  if (!more && !e.repeat) {
    woke('', now);
    heldKey = e.key;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
}

/** @param {PointerEvent} e */
function onPointerMove(e) {
  const moved = e.screenX !== pointer.x || e.screenY !== pointer.y;
  pointer = { x: e.screenX, y: e.screenY };
  if (showing) {
    if (Number.isNaN(anchor.x)) anchor = pointer;
    else if (Math.hypot(pointer.x - anchor.x, pointer.y - anchor.y) > POINTER_PX) woke('', performance.now());
  } else if (moved) lastInput = performance.now();
}

/** A click or the wheel. The screensaver covers the page, so a click that wakes it lands on nothing. @param {Event} e */
function onPress(e) {
  const now = performance.now();
  const more = now < swallow.until;
  if (!more && !showing) {
    lastInput = now;
    return;
  }
  if (!more) woke('', now);
  e.stopPropagation();
}

/** Listens for input, and checks once a second whether the screensaver is due. */
export function startScreensaver() {
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', (e) => {
    if (e.key === heldKey) heldKey = '';
  });
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerdown', onPress, true);
  window.addEventListener('wheel', onPress, { capture: true, passive: true });
  // Another window in front, or Lamplit minimised for a game: the show ends. Coming back counts as input.
  window.addEventListener('blur', hide);
  window.addEventListener('focus', () => (lastInput = performance.now()));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hide();
    else lastInput = performance.now();
  });
  setInterval(() => {
    const m = minutes();
    if (!showing && m > 0 && allowed() && performance.now() - lastInput >= m * 60_000) show();
  }, 1000);
}
