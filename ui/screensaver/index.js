// @ts-check
// Lamplit's screensaver: after a few minutes without input from a controller, the keyboard or the mouse, while Lamplit
// is in front and no game runs, generative art coloured from the player's own games covers the screen, so a still home
// screen can't mark an OLED TV. The first press only wakes it: it never also acts on what is underneath.

import * as api from '../api.js';
import { SAVER_DEFAULT, rowOf } from '../logic.js';
import { state } from '../state.js';
import { medianCut, scenePalette } from './palette.js';
import { Saver, artOf, pixelsOf, scaledArt } from './saver.js';

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
/**
 * After Show it now, the hand settles on the mouse: for this long after the click the pointer may move freely, and
 * where it comes to rest is where a move is measured from. Over Moonlight's absolute mouse the pointer never quite
 * keeps still.
 */
const SETTLE_MS = 1000;
/** The games whose art colours the show: favourites first, then the most recently played. */
const GAMES = 8;
/** After this long without input the next show is made ready (warmScreensaver). */
const WARM_MS = 2000;

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
/** When the player asked for the show that is on its way or showing (Show it now); -Infinity when it started itself. */
let askedAt = -Infinity;
/** The quiet spell and the library the show was last made ready for. */
let warmed = { input: NaN, games: /** @type {unknown} */ (null) };

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

/**
 * Settings > Screensaver > Show it now. The press that asked for it, and a key Steam mirrors from it, don't end it, and
 * neither does the pointer that clicked it moving a little (onPointerMove).
 */
export function showScreensaver() {
  const now = performance.now();
  swallow = { action: 'ok', until: now + GRACE_MS };
  askedAt = now;
  anchor = pointer;
  show(now);
}

/**
 * Makes the next show's renderer, colours and art in idle time, and has the renderer draw its first frame unseen
 * (Saver.prime), so the show starts without that work: after WARM_MS without input, and when Settings > Screensaver
 * opens, a row away from Show it now. Nothing while a game runs. Whichever comes first, this or a show, makes the
 * renderer, and only once (Saver.gl).
 */
export function warmScreensaver() {
  requestIdleCallback(async () => {
    if (!allowed()) return;
    // The renderer builds a noise volume and starts compiling its passes as it is made.
    const s = (saver ??= makeSaver());
    s.gl();
    const looks = await gameLooks();
    artOf(looks);
    if (showing || preparing || !allowed()) return;
    // The hidden frame takes the first game's colours, as the show will.
    s.setLooks(looks);
    s.prime();
  });
}

/** @param {number} [asked]  when the show was asked for; input after that calls it off */
async function show(asked = performance.now()) {
  if (showing || preparing) return;
  preparing = true;
  const looks = await gameLooks();
  preparing = false;
  if (lastInput > asked || !allowed()) {
    askedAt = -Infinity;
    return;
  }
  showing = true;
  if (askedAt === -Infinity) anchor = pointer;
  saver ??= makeSaver();
  saver.setLooks(looks);
  const ahead = saver.primed && saver.opening;
  saver.start();
  const why = saver.reason ? ` (${saver.reason})` : '';
  const first = ahead ? `, opening on ${ahead.name}, drawn ahead` : '';
  api.log.info(`screensaver on: ${saver.root.dataset.mode}${why}${first}, colours from ${looks.length} game${looks.length === 1 ? '' : 's'}`);
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
  askedAt = -Infinity;
  saver?.stop();
}

// ---------- colours from the games ----------

/** @type {Map<string, Promise<Palette | null>>} per art file */
const palettes = new Map();

/** The art's colours, worked out once per file, from the image scaled down off the main thread. @param {string} path */
function paletteOf(path) {
  let palette = palettes.get(path);
  if (!palette) {
    palette = scaledArt(api.assetUrl(path), { resizeWidth: 48, resizeHeight: 27 }).then(
      (img) => img && scenePalette(medianCut(pixelsOf(/** @type {CanvasImageSource} */ (img), 48, 27), 8))
    );
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
      const url = (/** @type {string | null} */ path) => (path ? api.assetUrl(path) : null);
      return palette && { palette, name: g.name, logo: url(g.art.logo), cover: url(g.art.portrait), hero: url(g.art.hero) };
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

/**
 * The pointer wakes the screensaver once it has moved POINTER_PX from where it was. While one is on its way, any move
 * calls it off, except for a show the player asked for: that one lets the hand settle first (SETTLE_MS), and is
 * called off only by a move as far as would wake it.
 * @param {PointerEvent} e
 */
function onPointerMove(e) {
  const now = performance.now();
  const moved = e.screenX !== pointer.x || e.screenY !== pointer.y;
  pointer = { x: e.screenX, y: e.screenY };
  const asked = askedAt > -Infinity;
  if (asked && now - askedAt < SETTLE_MS) {
    anchor = pointer;
    return;
  }
  if (showing || (asked && preparing)) {
    if (Number.isNaN(anchor.x)) anchor = pointer;
    else if (Math.hypot(pointer.x - anchor.x, pointer.y - anchor.y) > POINTER_PX) {
      if (showing) woke('', now);
      else lastInput = now;
    }
  } else if (moved) lastInput = now;
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
    if (showing || m <= 0 || !allowed()) return;
    const quiet = performance.now() - lastInput;
    if (quiet >= m * 60_000) show();
    else if (quiet >= WARM_MS && (warmed.input !== lastInput || warmed.games !== state.all)) {
      warmed = { input: lastInput, games: state.all };
      warmScreensaver();
    }
  }, 1000);
}
