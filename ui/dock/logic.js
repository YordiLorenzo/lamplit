// @ts-check
// What the dock shows, worked out from plain data: its tiles, the volume, the batteries in its top line, the button
// hints, and the spring it opens with. Nothing here touches the DOM or Tauri, so tests/dock-logic.test.mjs runs it in
// Node.

/**
 * @typedef {import('../api.js').Sound} Sound
 * @typedef {import('../api.js').Accessories} Accessories
 * @typedef {import('../api.js').Quiet} Quiet
 * @typedef {import('../api.js').Overlays} Overlays
 * @typedef {import('../api.js').DockGame} DockGame
 * @typedef {import('../logic.js').HintButton} HintButton
 */

/**
 * What the dock knows. Each part is null until Rust has answered.
 * @typedef {object} DockData
 * @property {DockGame | null} game
 * @property {Sound | null} sound
 * @property {Accessories | null} accessories
 * @property {Quiet | null} quiet
 * @property {Overlays} overlays
 * @property {boolean} confirm  Close game was pressed once, and asks for a second press
 */

/** @typedef {'resume' | 'output' | 'quiet' | 'stats' | 'home' | 'close'} TileKey */

/**
 * One tile in the dock's row.
 * @typedef {object} Tile
 * @property {TileKey} key
 * @property {string} icon  a symbol in dock.html, without its "i-"
 * @property {string} label
 * @property {string} value  a line under the label: a state, a device, or what the next press does
 * @property {'' | 'good' | 'warn'} tone
 */

/** The icon of a sound output, by its kind. @param {import('../api.js').Device['kind'] | undefined} kind */
export const outputIcon = (kind) => ({ tv: 'tv', headset: 'headset', controller: 'controller' })[kind] ?? 'speaker';
/** A battery at this percent or below, running on its battery, is low (dock/news.rs warns at the same level). */
const LOW = 15;

/** @param {DockData} d @returns {Tile[]} */
export function tiles(d) {
  const out = d.sound?.outputs.find((o) => o.default);
  const quiet = d.quiet?.state;
  const stats = d.overlays.nvidia_stats;
  /** @type {Tile[]} */
  const row = [
    { key: 'resume', icon: 'resume', label: 'Resume', value: '', tone: '' },
    { key: 'output', icon: outputIcon(out?.kind), label: 'Output', value: out?.name ?? '…', tone: '' },
    {
      key: 'quiet',
      icon: 'quiet',
      label: 'Quiet mode',
      value: { on: 'On', off: 'Off', partly: 'Partly on' }[quiet] ?? '…',
      tone: quiet === 'on' ? 'good' : quiet === 'partly' ? 'warn' : '',
    },
  ];
  // An unknown state can still be switched: NVIDIA's overlay logs the switch.
  if (d.overlays.nvidia_overlay) {
    row.push({ key: 'stats', icon: 'stats', label: 'Stats', value: stats === null ? 'Unknown' : stats ? 'On' : 'Off', tone: stats ? 'good' : '' });
  }
  row.push({ key: 'home', icon: 'home', label: 'Home', value: '', tone: '' });
  if (d.game) {
    const g = d.game;
    const value = d.confirm ? 'Press again' : !g.responding ? 'Not responding' : '';
    row.push({ key: 'close', icon: 'close', label: g.force_close ? 'Force close' : 'Close game', value, tone: value ? 'warn' : '' });
  }
  return row;
}

/** The volume row's level: the percent, or Muted. @param {Sound | null} sound */
export function volumeText(sound) {
  if (sound?.volume == null) return '…';
  return sound.muted ? 'Muted' : `${sound.volume}%`;
}

/**
 * The batteries in the dock's top line: each controller that reports one, then the headset while it is on.
 * @param {Accessories | null} acc
 * @returns {{ icon: string, text: string, tone: '' | 'warn' }[]}
 */
export function chips(acc) {
  if (!acc) return [];
  const level = { empty: 'Empty', low: 'Low', medium: 'Medium', full: 'Full' };
  const pads = acc.controllers
    .filter((c) => c.battery)
    .map((c) => {
      const b = c.battery;
      const low = b.percent != null ? b.percent <= LOW && b.charge !== 'charging' && b.charge !== 'full' : b.level === 'low' || b.level === 'empty';
      return { icon: 'controller', text: b.percent != null ? `${b.percent}%` : level[b.level], tone: low ? 'warn' : '' };
    });
  const h = acc.headset;
  if (h.on && h.battery != null) {
    pads.push({ icon: 'headset', text: `${h.battery}%`, tone: h.battery <= LOW && h.charge === 'battery' ? 'warn' : '' });
  }
  return /** @type {{ icon: string, text: string, tone: '' | 'warn' }[]} */ (pads);
}

/**
 * The hints under the dock: what the buttons do where the focus is.
 * @param {'tiles' | 'volume' | 'outputs'} row
 * @param {TileKey} tile  the focused tile
 * @param {DockData} d
 * @returns {[HintButton, string][]}
 */
export function hints(row, tile, d) {
  if (row === 'outputs') return [['ok', 'Use'], ['back', 'Back']];
  if (row === 'volume') return [['adjust', 'Volume'], ['ok', d.sound?.muted ? 'Unmute' : 'Mute'], ['back', 'Back to game']];
  const switched = (/** @type {boolean | null | undefined} */ on) => (on ? 'Turn off' : 'Turn on');
  const force = d.game?.force_close;
  const ok = {
    resume: 'Resume',
    output: 'Choose',
    quiet: switched(d.quiet?.active),
    stats: switched(d.overlays.nvidia_stats),
    home: 'Home screen',
    close: (force ? 'Force close' : 'Close game') + (d.confirm ? ' now' : ''),
  }[tile];
  // On Resume, ○ would say the same as ✕.
  return tile === 'resume' ? [['ok', ok]] : [['ok', ok], ['back', 'Back to game']];
}

/**
 * A damped spring's way from 0 to 1, as a CSS linear() easing, and how long it takes to come to rest. `response` is
 * the undamped spring's period in seconds, `damping` its damping ratio: below 1 it overshoots a little and settles.
 * @param {number} response
 * @param {number} damping
 */
export function spring(response, damping) {
  const omega = (2 * Math.PI) / response;
  const decay = damping * omega;
  const ringing = omega * Math.sqrt(1 - damping * damping);
  /** @param {number} t */
  const at = (t) => 1 - Math.exp(-decay * t) * (Math.cos(ringing * t) + (decay / ringing) * Math.sin(ringing * t));
  // At rest once the swing left is under half a percent of the way.
  const seconds = Math.log(200 / Math.sqrt(1 - damping * damping)) / decay;
  const steps = 40;
  const points = Array.from({ length: steps + 1 }, (_, i) => (i === steps ? 1 : Number(at((seconds * i) / steps).toFixed(4))));
  return { easing: `linear(${points.join(', ')})`, ms: Math.round(seconds * 1000) };
}

/** How long a mirrored key and the pad's own press can be apart and still be one press (input.js has the same). */
export const MIRROR_MS = 300;
/** After a pad press, keys are Steam mirroring the pad, and are ignored this long. */
export const PAD_KEEPS_MS = 2000;

/**
 * Whether an input counts. Steam mirrors the controller as keys while a window other than a game is in front, which
 * the dock is: the same press comes once from Rust and once as a key, in either order.
 * @param {{ lastPad: number, lastKey: { action: string, at: number } }} seen  updated in place
 * @param {string} action
 * @param {'pad' | 'key' | 'mouse'} source
 * @param {number} now  milliseconds
 */
export function counts(seen, action, source, now) {
  if (source === 'pad') {
    seen.lastPad = now;
    if (action === seen.lastKey.action && now - seen.lastKey.at < MIRROR_MS) {
      seen.lastKey = { action: '', at: 0 };
      return false;
    }
  } else if (source === 'key') {
    if (now - seen.lastPad < PAD_KEEPS_MS) return false;
    seen.lastKey = { action, at: now };
  }
  return true;
}
