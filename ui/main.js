// @ts-check
// Starts the page: listens to Rust's events, then fetches what happened before the page was ready.

import * as api from './api.js';
import { setPadKind, toast } from './hints.js';
import { act } from './input.js';
import { onPlay, onStep, onSummoned } from './launch.js';
import { layout, onArt, setGames } from './library.js';
import { refreshAccessories, setSetup, setStores } from './settings.js';
import { els, state } from './state.js';

function tickClock() {
  els.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Coming forward (after a game, or summoned) is when new installs should show up.
window.addEventListener('focus', () => api.libraryRescan());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) api.libraryRescan();
});
window.addEventListener('resize', layout);

window.addEventListener('error', (e) => api.log.error(`${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => api.log.error(`unhandled: ${e.reason?.message ?? e.reason}`));

async function init() {
  tickClock();
  setInterval(tickClock, 5000);
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
    api.onSummoned(onSummoned),
    api.onLaunchStep(onStep),
    api.onStores(setStores),
    api.onAccessories(refreshAccessories),
    api.onNotice(toast),
    api.onSetup(setSetup),
  ]);
  const [list, running, stores, kind] = await Promise.all([
    api.libraryGames(),
    api.launchRunning(),
    api.storesStatus(),
    api.controllerKind(),
  ]);
  state.running = running;
  setStores(stores);
  // A "games" event that arrived while this answer was on its way is at least as new, with later art applied to it.
  if (list && !heardGames) setGames(list);
  // The controllers were read before the page listened; a "pad-kind" event since is newer than this answer.
  if (kind && !heardKind) setPadKind(kind);
  api.log.info(`ready ${Math.round(performance.now())} ms after the page started, ${list?.length ?? 'no'} games yet`);
}

init();
