// @ts-check
// Starts the page: listens to Rust's events, then fetches what happened before the page was ready.

import * as api from './api.js';
import { setPadKind, toast } from './hints.js';
import { meter } from './frames.js';
import { act } from './input.js';
import { mountIcons } from './icons.js';
import { onPlay, onStep, onSummoned } from './launch.js';
import { layout, onArt, setGames } from './library.js';
import { startScreensaver, wake } from './screensaver/index.js';
import { refreshAccessories, setSetup, setStores } from './settings.js';
import { nameSprings } from './springs.js';
import { readStatus, startStatus } from './status.js';
import { els, state } from './state.js';

// The springs and the icons both pages share.
nameSprings(document.documentElement);
mountIcons(document);


/**
 * Coming forward (after a game, or summoned) is when new installs should show up. The rescan waits until the way in
 * has played, the home screen's veil and the dock folding behind it: reading the drives and the art meanwhile costs
 * them frames.
 */
const RESCAN_AFTER_MS = 900;
let rescanTimer = 0;
function rescanSoon() {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => api.libraryRescan(), RESCAN_AFTER_MS);
}
window.addEventListener('focus', rescanSoon);
// Back from a game, the volume or the batteries may have changed.
window.addEventListener('focus', readStatus);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) rescanSoon();
});
window.addEventListener('resize', layout);

let arrivedTimer = 0;
let arrivals = 0;
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** The hero on screen decoded, or 300 ms on, whichever comes first. */
function heroDecoded() {
  const url = els.heroes[state.heroLayer]?.style.backgroundImage.match(/url\("(.*)"\)/)?.[1];
  if (!url) return Promise.resolve();
  const img = new Image();
  img.src = url;
  return Promise.race([img.decode().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 300))]);
}

/**
 * Back from a game: the veil shows on the first frame Lamplit draws in front (a window behind a game draws nothing
 * until it comes forward), then lifts while the screen settles in (style.css #arrival). Behind a game the window had
 * let go of what it drew, so its first frames in front redraw the whole screen: the settling starts once the hero is
 * decoded and those frames are out, and the dock's veil over it lifts then too (dock_home_drawn).
 */
async function arrive() {
  const mine = ++arrivals;
  clearTimeout(arrivedTimer);
  document.body.classList.remove('arrived');
  document.body.classList.add('arriving');
  await heroDecoded();
  await nextFrame();
  await nextFrame();
  if (mine !== arrivals) return;
  api.dockHomeDrawn().catch(() => {});
  meter('home: arrive', 600);
  document.body.classList.replace('arriving', 'arrived');
  arrivedTimer = setTimeout(() => document.body.classList.remove('arrived'), 600);
}

window.addEventListener('error', (e) => api.log.error(`${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => api.log.error(`unhandled: ${e.reason?.message ?? e.reason}`));

async function init() {
  startStatus();
  let heardGames = false;
  let heardKind = false;
  await Promise.all([
    api.onGames((games) => {
      heardGames = true;
      setGames(games);
    }),
    api.onArt(onArt),
    api.onPad((action) => act(action, 'pad')),
    api.onPadKind((kind) => {
      heardKind = true;
      setPadKind(kind);
    }),
    api.onPlay(onPlay),
    api.onSummoned((runningId) => {
      // Holding PS comes as a summon rather than a press; over the screensaver it only ends it, as any first press
      // does. What Rust says runs still counts.
      if (wake('summon')) state.running = runningId;
      else {
        onSummoned(runningId);
        if (runningId && state.mode !== 'starting') arrive();
      }
    }),
    api.onLaunchStep(onStep),
    api.onStores(setStores),
    api.onAccessories(() => {
      refreshAccessories();
      readStatus();
    }),
    api.onNotice(toast),
    api.onSetup(setSetup),
  ]);
  const [list, running, stores, kind, prefs] = await Promise.all([
    api.libraryGames(),
    api.launchRunning(),
    api.storesStatus(),
    api.controllerKind(),
    api.prefsState(),
  ]);
  state.running = running;
  // The screensaver's delay and style; Settings may have read newer prefs meanwhile.
  state.prefs ??= prefs;
  setStores(stores);
  // A "games" event that arrived while this answer was on its way is at least as new, with later art applied to it.
  if (list && !heardGames) setGames(list);
  // The controllers were read before the page listened; a "pad-kind" event since is newer than this answer.
  if (kind && !heardKind) setPadKind(kind);
  api.log.info(`ready ${Math.round(performance.now())} ms after the page started, ${list?.length ?? 'no'} games yet`);
}

startScreensaver();
init();
// Measurement builds only (src-tauri/src/probe.rs): the frame probe.
if (/** @type {any} */ (window).__LAMPLIT_PROBE__) import('./probe.js');
