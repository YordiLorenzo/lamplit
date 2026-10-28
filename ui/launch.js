// @ts-check
// Starting a game: the starting screen with the launch checks, and what the page does when a game runs, closes or
// fails to start.

import * as api from './api.js';
import { closeAdd } from './add.js';
import { closeFind } from './find.js';
import { meter } from './frames.js';
import { buttonBadge, showHints, stepAction, toast } from './hints.js';
import { closeDetails, focusGame, paintCover, refreshChoices, render, showRow } from './library.js';
import { buttonFace } from './logic.js';
import { sfx } from './sounds.js';
import { actionableStep, byId, els, focused, icon, state, storeName, withStoreLogo } from './state.js';

/**
 * @param {import('./state.js').Shown} g @param {string} sub
 * @param {import('./state.js').StoreKey | null} [store]  the store app `sub` names, whose logo goes in front of it
 */
function showStarting(g, sub, store = null) {
  if (state.launching !== g.id) state.steps = [];
  liftCurtain();
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
    toast(e.message, { game: g, warn: true });
  }
}

/** Each step state's icon, from the icons both pages share; a busy step spins instead. */
const STEP_ICONS = { ok: 'i-check', warn: 'i-warn', block: 'i-next', error: 'i-error' };

/**
 * The launch's steps, one line each. The step the player can act on carries its action as a chip, ✕ and what it does
 * (Show the window, Open Steam), as well as in the hints; a click on it does it too (input.js).
 */
function renderSteps() {
  const act = actionableStep();
  els.steps.textContent = '';
  for (const s of state.steps) {
    const li = document.createElement('li');
    li.className = s.state;
    const i = document.createElement('span');
    i.className = 'icon';
    if (STEP_ICONS[s.state]) i.append(icon(STEP_ICONS[s.state]));
    const t = document.createElement('span');
    t.textContent = s.label;
    li.append(i, ...withStoreLogo(s.store, t));
    if (s === act) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = buttonBadge('ok');
      chip.append(stepAction(s));
      li.append(chip);
    }
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

/**
 * How long the black waits for the game's window to get the screen: Rust's fade (watch.rs FADE) and the handover. If
 * the window went meanwhile (a game that replaces its window), the black lifts on the starting screen, which shows
 * until the next window is up.
 */
const HAND_OVER_MS = 2000;
/** Once the game's window has the screen, Lamplit is behind it, and the black lifts unseen. */
const LIFT_AFTER_MS = 1000;
let curtainTimer = 0;

/** Black over the screen, which lifts after `ms`. @param {number} ms */
function curtain(ms) {
  document.body.classList.add('curtain');
  clearTimeout(curtainTimer);
  curtainTimer = setTimeout(liftCurtain, ms);
}

function liftCurtain() {
  clearTimeout(curtainTimer);
  document.body.classList.remove('curtain');
}

export function cancelLaunch() {
  api.launchCancel();
  sfx.back();
  liftCurtain();
  endLaunch();
}

/** How long the home screen takes to go under the veil (style.css body.leaving), as the dock's Home takes to veil the
 * game (dock/mod.rs VEIL). */
const LEAVE_MS = 200;
/** A game that hasn't taken the screen by then won't: the home screen comes out from under the veil. */
const LEFT_BY_MS = 2000;
const leaving = { timer: 0, asked: false };

/**
 * Back to the running game, the reverse of the dock's Home: the home screen eases out under a veil in the game's
 * colours, then the game gets the screen. Lamplit's window, behind the game, keeps the veil until the game has the
 * foreground; a summon brings Lamplit back under the veil it lifts (main.js arrive). The page asks nothing of the
 * game, so one that has stopped responding gets the screen as soon.
 */
export function backToGame() {
  sfx.open();
  stopLeaving();
  document.body.classList.remove('arriving', 'arrived');
  document.body.classList.add('leaving');
  meter('home: leave', LEAVE_MS);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  leaving.timer = setTimeout(
    () => {
      leaving.asked = true;
      api.launchResume();
      leaving.timer = setTimeout(stopLeaving, LEFT_BY_MS);
    },
    reduced ? 0 : LEAVE_MS
  );
}

function stopLeaving() {
  clearTimeout(leaving.timer);
  leaving.asked = false;
  document.body.classList.remove('leaving');
}

// The game has the foreground, so Lamplit's window is behind it: the veil goes unseen.
const left = () => leaving.asked && stopLeaving();
window.addEventListener('blur', left);
document.addEventListener('visibilitychange', () => document.hidden && left());

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
  if (play.state === 'up') {
    // The game's window is up: the starting screen fades to black before it gets the screen, so nothing shows between
    // them. The launch goes on until the window has the screen.
    if (state.mode === 'starting' && state.launching === id) curtain(HAND_OVER_MS);
  } else if (play.state === 'running') {
    state.running = id;
    // Only now: a launch the player cancels, or that a store check stops, isn't a play.
    if (g) g.last_played = Math.floor(Date.now() / 1000);
    if (mine) {
      // Its window has the screen: the home screen gets ready under the black, for when the game closes.
      if (document.body.classList.contains('curtain')) curtain(LIFT_AFTER_MS);
      endLaunch();
    }
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
    toast(play.message, { game: byId(id), warn: true });
  }
  state.all.forEach(paintCover);
  render();
  // A game's menu still open offers what the game's state allows now: Close game only while it runs.
  refreshChoices();
}

/** A controller brought Lamplit forward while `runningId` runs. @param {string | null} runningId */
export function onSummoned(runningId) {
  stopLeaving();
  state.running = runningId;
  leavePanels();
  if (runningId) focusGame(runningId);
  state.all.forEach(paintCover);
  render();
}
