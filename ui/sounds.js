// @ts-check
// Short interface sounds made with Web Audio, so there are no sound files.

import * as api from './api.js';

/** @type {AudioContext | null} */
let ctx = null;
// Silent until the saved choice is in, so an early press cannot ignore Off.
let volume = 0;

/** @param {import('./api.js').InterfaceSounds} level */
export function setSoundLevel(level) {
  volume = { off: 0, quiet: 1 / 3, normal: 1 }[level];
}

/** Each WebView reads the saved level and follows later changes, including while the dock is hidden. */
export async function startSounds() {
  let changed = false;
  await api.onInterfaceSounds((level) => {
    changed = true;
    setSoundLevel(level);
  });
  const prefs = await api.prefsState();
  if (!changed) setSoundLevel(prefs.interface_sounds);
}

/**
 * @param {number} freq
 * @param {{ at?: number, dur?: number, vol?: number, type?: OscillatorType, to?: number | null }} [shape]
 */
function tone(freq, { at = 0, dur = 0.06, vol = 0.04, type = 'sine', to = null } = {}) {
  if (!volume) return;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol * volume, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

export const sfx = {
  move: () => tone(1320, { dur: 0.05, vol: 0.025, to: 1100 }),
  edge: () => tone(170, { dur: 0.09, vol: 0.05, type: 'triangle' }),
  open: () => tone(880, { dur: 0.08, vol: 0.03, to: 1180 }),
  back: () => tone(720, { dur: 0.08, vol: 0.03, to: 480 }),
  launch: () => {
    tone(523, { dur: 0.4, vol: 0.04 });
    tone(784, { at: 0.07, dur: 0.45, vol: 0.035 });
    tone(1047, { at: 0.14, dur: 0.6, vol: 0.03 });
  },
};

// The audio device starts once the page is idle after start, not inside the first press's sound, where it takes a
// frame or more. Lamplit's WebView plays without a press first (`--autoplay-policy` in tauri.conf.json); elsewhere the
// first sound resumes it. Without an audio device Chromium plays into a silent sink rather than failing.
requestIdleCallback(() => (ctx ??= new AudioContext()));
