// @ts-check
// Short interface sounds made with Web Audio, so there are no sound files.

/** @type {AudioContext | null} */
let ctx = null;
// Starting the audio device takes the main thread for a moment (106 ms with the CPU slowed 4x): it happens while the
// page is idle after it starts, rather than inside the first press's sound.
requestIdleCallback(() => (ctx ??= new AudioContext()));

/**
 * @param {number} freq
 * @param {{ at?: number, dur?: number, vol?: number, type?: OscillatorType, to?: number | null }} [shape]
 */
function tone(freq, { at = 0, dur = 0.06, vol = 0.04, type = 'sine', to = null } = {}) {
  // Without an audio device Chromium plays into a silent sink rather than failing.
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.008);
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
