// @ts-check
// The status capsule, top right of the home screen: the controllers' and the headset's batteries, the volume, quiet
// mode while it is on, and the time, as the chips of the dock's top line. Settings grows down out of it, and it is
// Settings' header while Settings is open (settings.js).

import * as api from './api.js';
import { chips, volumeText } from './dock/logic.js';
import { els, icon, state } from './state.js';

/** How often the batteries and the volume are read again while nothing says they changed. */
const READ_EVERY_MS = 60_000;

/** @param {string} cls @param {string} [text] */
function span(cls, text = '') {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

/** A shared icon (icons.js), at the chips' size. @param {string} id */
function glyph(id) {
  const svg = icon(id);
  svg.setAttribute('class', 'icon');
  return svg;
}

/** The time, every few seconds. */
function tickClock() {
  els.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Draws the chips from what the page knows, only when they changed. */
export function renderStatus() {
  const batteries = chips(state.accessories);
  const sound = state.sound;
  const drawn = JSON.stringify([batteries, sound?.volume, sound?.muted, !!state.quiet?.active]);
  if (els.chips.dataset.drawn === drawn) return;
  els.chips.dataset.drawn = drawn;
  els.chips.replaceChildren(
    ...batteries.map((c) => {
      const chip = span(`chip ${c.tone}`);
      const battery = span('battery');
      battery.style.setProperty('--level', String(c.level / 100));
      chip.append(glyph(`i-${c.icon}`), battery, span('', c.text));
      return chip;
    }),
    ...(sound?.volume == null ? [] : [Object.assign(span('chip'), { id: 'volumeChip' })]),
    ...(state.quiet?.active ? [Object.assign(span('chip'), { id: 'quietChip' })] : [])
  );
  const volume = document.getElementById('volumeChip');
  volume?.append(glyph(sound?.muted ? 'i-muted' : 'i-volume'), span('', volumeText(sound)));
  document.getElementById('quietChip')?.append(glyph('i-quiet-on'));
}

/** Asked for so far: the answers of an older read, which can come back after a newer one's, are dropped. */
let reads = 0;

/** Reads the batteries, the volume and quiet mode again, and draws them. */
export async function readStatus() {
  const asked = ++reads;
  const [accessories, sound, quiet] = await Promise.all([
    api.accessoriesState().catch(() => null),
    api.soundState().catch(() => null),
    api.quietState().catch(() => null),
  ]);
  if (asked !== reads) return;
  state.accessories = accessories ?? state.accessories;
  state.sound = sound ?? state.sound;
  state.quiet = quiet ?? state.quiet;
  renderStatus();
}

/** Starts the capsule: the time now and every 5 s, the rest now and every minute while the page shows. */
export function startStatus() {
  tickClock();
  setInterval(tickClock, 5000);
  readStatus();
  setInterval(() => {
    if (!document.hidden) readStatus();
  }, READ_EVERY_MS);
}
