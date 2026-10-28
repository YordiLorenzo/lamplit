// @ts-check
// What the dock shows, worked out from plain data: its tiles, the volume, the top line (how long the game has been
// played, the batteries) and the button hints. Nothing here touches the DOM or Tauri, so tests/dock-logic.test.mjs runs
// it in Node.

import { playTimeText, quietMode } from '../logic.js';

/**
 * @typedef {import('../api.js').Sound} Sound
 * @typedef {import('../api.js').Device} Device
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
 */

/** @typedef {'resume' | 'output' | 'quiet' | 'stats' | 'home' | 'close'} TileKey */

/**
 * One tile in the dock's row: an icon that shows its state (quiet mode and the stats light up when on), and one label.
 * @typedef {object} Tile
 * @property {TileKey} key
 * @property {string} icon  one of the shared icons (ui/icons.js), without its "i-"
 * @property {string} label
 * @property {boolean} on  a switch that is on
 * @property {'' | 'warn'} tone  partly on, or a game to force closed
 */

/** A battery at this percent or below, running on its battery, is low (dock/news.rs warns at the same level). */
const LOW = 15;

/** The icon of a sound output, by its kind. @param {Device['kind'] | undefined} kind */
export const outputIcon = (kind) => ({ tv: 'tv', headset: 'headset', controller: 'controller' })[kind] ?? 'speaker';

/**
 * A sound output's name on its tile: what kind of device it is, which fits; the list of outputs has the full names.
 * @param {Device | undefined} device
 */
export const outputLabel = (device) =>
  !device ? 'Output' : ({ tv: 'TV', headset: 'Headset', controller: 'Controller' })[device.kind] ?? device.name;

/** @param {DockData} d @returns {Tile[]} */
export function tiles(d) {
  // As the player switched it: off can leave Windows quiet, when it was before.
  const quiet = quietMode(d.quiet);
  const stats = d.overlays.nvidia_stats === true;
  const out = d.sound?.outputs.find((o) => o.default);
  /** @type {Tile[]} */
  const row = [
    { key: 'resume', icon: 'play', label: 'Resume', on: false, tone: '' },
    { key: 'output', icon: outputIcon(out?.kind), label: outputLabel(out), on: false, tone: '' },
    { key: 'quiet', icon: quiet.on ? 'quiet-on' : 'quiet', label: quiet.label, on: quiet.on, tone: quiet.tone === 'warn' ? 'warn' : '' },
  ];
  // An unknown state can still be switched: NVIDIA's overlay logs the switch.
  if (d.overlays.nvidia_overlay) row.push({ key: 'stats', icon: 'stats', label: 'Stats', on: stats, tone: '' });
  row.push({ key: 'home', icon: 'home', label: 'Home', on: false, tone: '' });
  // A game whose processes Lamplit can't be sure of is left to close itself: the dock would reach another program.
  if (d.game?.closable) {
    const force = d.game.force_close;
    row.push({ key: 'close', icon: 'close-game', label: force ? 'Force close' : 'Close game', on: false, tone: force ? 'warn' : '' });
  }
  return row;
}

/** The volume's level: the percent, or Muted. @param {Sound | null} sound */
export function volumeText(sound) {
  if (sound?.volume == null) return '…';
  return sound.muted ? 'Muted' : `${sound.volume}%`;
}

/**
 * Under the game's name: how long this session has gone on, or that the game isn't responding.
 * @param {DockGame | null} game
 * @param {number} now  Unix seconds
 */
export function sessionText(game, now) {
  if (!game) return '';
  if (!game.responding) return 'Not responding';
  if (!game.started) return '';
  const minutes = Math.floor((now - game.started) / 60);
  return minutes < 1 ? 'Just started' : `Playing for ${playTimeText(minutes, true)}`;
}

/**
 * The batteries in the dock's top line: each controller that reports one, then the headset while it is on. `level`
 * fills the battery's glyph; an Xbox-style controller reports only a rough one.
 * @param {Accessories | null} acc
 * @returns {{ icon: string, text: string, level: number, tone: '' | 'warn' }[]}
 */
export function chips(acc) {
  if (!acc) return [];
  /** @type {Record<string, [string, number]>} */
  const rough = { empty: ['Empty', 5], low: ['Low', 20], medium: ['Medium', 55], full: ['Full', 100] };
  /** @type {{ icon: string, text: string, level: number, tone: '' | 'warn' }[]} */
  const out = acc.controllers
    .filter((c) => c.battery)
    .map((c) => {
      const b = c.battery;
      if (b.percent == null) {
        const [text, level] = rough[b.level];
        return { icon: 'controller', text, level, tone: b.level === 'low' || b.level === 'empty' ? 'warn' : '' };
      }
      const low = b.percent <= LOW && b.charge !== 'charging' && b.charge !== 'full';
      return { icon: 'controller', text: `${b.percent}%`, level: b.percent, tone: low ? 'warn' : '' };
    });
  const h = acc.headset;
  if (h.on && h.battery != null) {
    out.push({ icon: 'headset', text: `${h.battery}%`, level: h.battery, tone: h.battery <= LOW && h.charge === 'battery' ? 'warn' : '' });
  }
  return out;
}

/** A button the dock's hints name: the home screen's, and Up and Down on the d-pad. @typedef {HintButton | 'up' | 'down'} DockButton */

/**
 * The hints under the dock: what the buttons do where the focus is.
 * @param {'tiles' | 'volume' | 'outputs'} row
 * @param {TileKey} tile  the focused tile
 * @param {DockData} d
 * @returns {[DockButton, string][]}
 */
export function hints(row, tile, d) {
  if (row === 'outputs') return [['ok', 'Use'], ['back', 'Back']];
  if (row === 'volume') return [['adjust', 'Volume'], ['ok', d.sound?.muted ? 'Unmute' : 'Mute'], ['down', 'Back']];
  const switched = (/** @type {boolean | null | undefined} */ on) => (on ? 'Turn off' : 'Turn on');
  const ok = {
    resume: 'Resume',
    output: 'Choose',
    quiet: switched(d.quiet?.active),
    stats: switched(d.overlays.nvidia_stats),
    home: 'Home screen',
    close: d.game?.force_close ? 'Hold to force close' : 'Hold to close game',
  }[tile];
  // On Resume, ○ would say the same as ✕.
  return tile === 'resume' ? [['ok', ok], ['up', 'Volume']] : [['ok', ok], ['up', 'Volume'], ['back', 'Back to game']];
}

