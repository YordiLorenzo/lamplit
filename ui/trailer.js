// @ts-check
// An idle cover can show its trailer. Input cancels both playback and any details still on their way.

import * as api from './api.js';
import { playDash } from './dash.js';
import { trailerAllowed } from './logic.js';
import { reduced } from './morph.js';
import { screensaverShowing } from './screensaver/index.js';
import { els, focused, state } from './state.js';

const IDLE_MS = 2500;
const FADE_OUT_MS = 200;
const STALL_MS = 4000;
let dock = false;
let idleAt = performance.now();
let key = '';
let attempted = false;
let generation = 0;
let stalledTimer = 0;
/** @type {HTMLVideoElement | null} */
let video = null;
/** Stops the current trailer's fetches. */
let fetches = new AbortController();
/** The current trailer's MediaSource URL, revoked once its video is gone. */
let objectUrl = '';

function target() {
  const allowed = trailerAllowed(state, {
    front: !document.hidden && document.hasFocus(), reduced: reduced(), saver: screensaverShowing(), dock,
  });
  const id = focused()?.id;
  return allowed && id ? `${id}|${state.prefs.trailers}` : '';
}

function stop() {
  clearTimeout(stalledTimer);
  stalledTimer = 0;
  const old = video;
  const url = objectUrl;
  video = null;
  objectUrl = '';
  fetches.abort();
  if (!old) return;
  old.onplaying = old.onerror = old.onwaiting = old.onstalled = null;
  old.muted = true;
  old.pause();
  old.classList.remove('on');
  // Keep the paused frame for the fade, then release the MediaSource and the decoder.
  setTimeout(() => {
    old.removeAttribute('src');
    old.removeAttribute('poster');
    old.load();
    old.remove();
    if (url) URL.revokeObjectURL(url);
  }, FADE_OUT_MS);
}

function input() {
  generation++;
  idleAt = performance.now();
  attempted = false;
  stop();
}

/** @param {string} id @param {string} expected */
async function play(id, expected) {
  const mine = generation;
  const details = await api.libraryDetails(id).catch(() => null);
  // A cover can lose focus and regain it while Steam answers. Only the same uninterrupted rest counts.
  if (mine !== generation || target() !== expected || !details?.trailer) return;
  const next = document.createElement('video');
  next.id = 'trailer';
  next.setAttribute('aria-hidden', 'true');
  next.loop = true;
  next.playsInline = true;
  next.muted = state.prefs.trailers !== 'with_sound';
  next.volume = 0.4;
  next.poster = details.trailer.poster;
  video = next;
  fetches = new AbortController();
  const drop = () => { if (video === next) stop(); };
  // A report then says why a game's trailer didn't play. Stopping on input aborts the downloads, which isn't a failure.
  const failed = (/** @type {any} */ e) => {
    if (e?.name !== 'AbortError') api.log.warn(`trailer: ${details.appid} ${e?.message ?? e}`);
    drop();
  };
  let logged = false;
  const stalled = () => {
    if (stalledTimer) return;
    stalledTimer = setTimeout(() => failed(new Error(`stalled for ${STALL_MS / 1000} s`)), STALL_MS);
  };
  next.onplaying = () => {
    if (mine !== generation || target() !== expected) return drop();
    clearTimeout(stalledTimer);
    stalledTimer = 0;
    if (!logged) api.log.info(`trailer: playing ${details.appid}`);
    logged = true;
    // A cached video can play before its first paint. Commit its hidden style so it still fades in.
    getComputedStyle(next).opacity;
    next.classList.add('on');
  };
  next.onerror = () => failed(new Error(`media error ${next.error?.code ?? 'unknown'}`));
  next.onwaiting = stalled;
  next.onstalled = stalled;
  els.stage.querySelector('.shade').before(next);
  stalled();
  playDash(next, details.trailer.url, !next.muted, fetches.signal).then((url) => {
    if (video !== next) return URL.revokeObjectURL(url);
    objectUrl = url;
    return next.play();
  }).catch(failed);
}

function check() {
  const next = target();
  if (next !== key) {
    input();
    key = next;
  }
  if (!next || attempted || performance.now() - idleAt < IDLE_MS) return;
  attempted = true;
  play(focused().id, next);
}

/** The same input that wakes the screensaver cancels a trailer, including keys with no home-screen action. */
export async function startTrailers() {
  for (const event of ['keydown', 'keyup', 'pointermove', 'pointerdown', 'pointerup', 'wheel']) {
    window.addEventListener(event, input, { capture: true, passive: true });
  }
  window.addEventListener('blur', input);
  window.addEventListener('focus', input);
  document.addEventListener('visibilitychange', input);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', input);
  // Modes, library focus and the screensaver can change without input, including while details are loading.
  setInterval(check, 100);
  await Promise.all([
    api.onPad(input),
    api.onSummoned(input),
    api.onDock((show) => {
      if (show.mode === 'status') return;
      dock = show.mode === 'open';
      input();
    }),
  ]);
}
