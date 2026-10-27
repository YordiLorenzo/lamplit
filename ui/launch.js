// @ts-check
// Starting a game: the starting screen with the launch checks, and what the page does when a game runs, closes or
// fails to start.

import * as api from './api.js';
import { closeAdd } from './add.js';
import { closeFind } from './find.js';
import { showHints, toast } from './hints.js';
import { closeDetails, focusGame, paintCover, render, showRow } from './library.js';
import { buttonFace } from './logic.js';
import { sfx } from './sounds.js';
import { byId, els, focused, state, storeName, withStoreLogo } from './state.js';

/**
 * @param {import('./state.js').Shown} g @param {string} sub
 * @param {import('./state.js').StoreKey | null} [store]  the store app `sub` names, whose logo goes in front of it
 */
function showStarting(g, sub, store = null) {
  if (state.launching !== g.id) state.steps = [];
  state.mode = 'starting';
  state.launching = g.id;
  renderSteps();
  document.body.classList.add('launching');
  els.overlayTitle.textContent = `Starting ${g.name}…`;
  els.overlaySub.replaceChildren(...withStoreLogo(store, sub));
  els.overlay.classList.add('on');
  showHints();
}

export async function play() {
  const g = focused();
  if (state.running === g.id) return backToGame();
  sfx.launch();
  // A game starts through the first store app it needs, if any.
  const via = storeName(g.requires[0]);
  showStarting(g, via ? `Through ${via}` : '', via ? g.requires[0] : null);
  try {
    await api.launchStart(g.id);
  } catch (e) {
    endLaunch();
    toast(e.message);
  }
}

function renderSteps() {
  const icon = { busy: '', ok: '✓', warn: '!', block: '→', error: '✕' };
  els.steps.textContent = '';
  for (const s of state.steps) {
    const li = document.createElement('li');
    li.className = s.state;
    const i = document.createElement('span');
    i.className = 'icon';
    i.textContent = icon[s.state] ?? '';
    const t = document.createElement('span');
    t.textContent = s.label;
    li.append(i, ...withStoreLogo(s.store, t));
    els.steps.append(li);
  }
}

/** @param {import('./api.js').LaunchStep} step */
export function onStep(step) {
  if (step.id !== state.launching) return;
  const i = state.steps.findIndex((s) => s.key === step.key);
  if (i >= 0) state.steps[i] = step;
  else state.steps.push(step);
  renderSteps();
  showHints();
}

function endLaunch() {
  if (state.mode === 'starting') state.mode = 'browse';
  state.launching = null;
  state.steps = [];
  document.body.classList.remove('launching');
  els.overlay.classList.remove('on');
  showHints();
}

/** How long the screen fades to black before Rust gives the game's window the screen (watch.rs FADE). */
const FADE_MS = 300;
/** By then Lamplit is behind the game's window, and the curtain lifts unseen. */
const LIFT_AFTER_MS = 1500;
let curtainTimer = 0;

/**
 * The game's window is up and gets the screen: the starting screen fades to black, so nothing shows between it and
 * the game, and the home screen is ready behind the curtain for when the game closes.
 */
function handOver() {
  document.body.classList.add('curtain');
  clearTimeout(curtainTimer);
  curtainTimer = setTimeout(() => {
    endLaunch();
    curtainTimer = setTimeout(() => document.body.classList.remove('curtain'), LIFT_AFTER_MS - FADE_MS);
  }, FADE_MS);
}

export function cancelLaunch() {
  api.launchCancel();
  sfx.back();
  endLaunch();
}

export function backToGame() {
  sfx.open();
  api.launchResume();
}

/** A game's news takes the screen: the game menu, Find and Add a game close first. */
function leavePanels() {
  if (state.mode === 'details') closeDetails();
  if (state.mode === 'find') closeFind();
  if (state.mode === 'add') closeAdd();
}

/** @param {import('./api.js').Play} play */
export function onPlay(play) {
  const { id } = play;
  const g = byId(id);
  // Another game's news must not close the overlay of the one being started now.
  const mine = state.launching === null || state.launching === id;
  if (play.state === 'running') {
    state.running = id;
    // Only now: a launch the player cancels, or that a store check stops, isn't a play.
    if (g) g.last_played = Math.floor(Date.now() / 1000);
    if (mine && state.mode === 'starting' && state.launching === id) handOver();
    else if (mine) endLaunch();
  } else if (play.state === 'starting') {
    // Rust stops counting the game as running, also while the page starts another one.
    if (state.running === id) state.running = null;
    if (g && mine) {
      // It closed right after starting: a launcher handing over, or a crash. Wait for it in view.
      leavePanels();
      focusGame(id);
      showStarting(g, `Waiting for the game to come back. ${buttonFace(state.padKind, 'back')[1]} stops waiting.`);
    }
  } else if (play.state === 'ended') {
    if (state.running === id) state.running = null;
    if (mine) {
      endLaunch();
      // Focus moves to the game that ended; open details would still name the game focused before.
      leavePanels();
      // Its last-played time changed, so the row is ordered again.
      showRow(id);
      focusGame(id);
    }
  } else if (play.state === 'failed' && mine) {
    endLaunch();
    toast(play.message);
  }
  state.all.forEach(paintCover);
  render();
}

/** A controller brought Lamplit forward while `runningId` runs. @param {string | null} runningId */
export function onSummoned(runningId) {
  state.running = runningId;
  leavePanels();
  if (runningId) focusGame(runningId);
  state.all.forEach(paintCover);
  render();
}
