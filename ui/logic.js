// @ts-check
// What the page shows, worked out from plain data. Nothing here touches the DOM or Tauri, so tests/logic.test.mjs
// runs it in Node.

/**
 * @typedef {import('./api.js').Game} Game
 * @typedef {import('./api.js').StoreKey} StoreKey
 * @typedef {import('./api.js').StoreStatus} StoreStatus
 * @typedef {import('./api.js').Charge} Charge
 * @typedef {import('./state.js').Row} Row
 * @typedef {typeof import('./state.js').state} State
 */

// ---------- the focused game ----------

/** Keeps the hue, lifts saturation and lightness so the colour reads on a dark screen. @param {number[]} rgb */
export function readable([r, g, b]) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  if (s < 0.12) return [200, 206, 222];
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  s = Math.min(0.85, Math.max(0.45, s));
  const c = (1 - Math.abs(2 * 0.62 - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 0.62 - c / 2;
  const [R, G, B] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [R, G, B].map((v) => Math.round((v + m) * 255));
}

/** @param {number} ts Unix seconds, 0 for never @param {number} [now] Unix seconds */
export function playedText(ts, now = Date.now() / 1000) {
  if (!ts) return '';
  const days = Math.floor((now - ts) / 86400);
  if (days <= 0) return 'Played today';
  if (days === 1) return 'Played yesterday';
  if (days < 14) return `Played ${days} days ago`;
  if (days < 60) return `Played ${Math.round(days / 7)} weeks ago`;
  return `Played ${Math.round(days / 30)} months ago`;
}

/**
 * The cover row's order, the one Rust sends (library/mod.rs): last played first, then by name in lower case, compared
 * character by character rather than by the language's rules, which Rust doesn't know.
 * @param {Game} a
 * @param {Game} b
 */
export function byPlayed(a, b) {
  if (a.last_played !== b.last_played) return b.last_played - a.last_played;
  const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Lamplit knows up front when a store app the game needs isn't signed in or isn't installed.
 * @param {Game} g
 * @param {Map<StoreKey, StoreStatus>} stores
 */
export function storeWarning(g, stores) {
  for (const key of g.requires) {
    const s = stores.get(key);
    if (!s) continue;
    if (!s.installed) return `${s.name} isn't installed`;
    if (s.account === 'signed-out') return `${s.name}: sign in needed`;
  }
  return null;
}

// ---------- the Settings screen ----------

export const SECTIONS = [
  { key: 'sound', title: 'Sound' },
  { key: 'headset', title: 'Headset' },
  { key: 'controllers', title: 'Controllers' },
  { key: 'popups', title: 'Overlay and pop-ups' },
  { key: 'stores', title: 'Stores' },
  { key: 'system', title: 'System' },
];
/** The auto-off times the headset offers, in minutes; 0 is never. */
const AUTO_OFF = [0, 5, 10, 15, 20, 30, 60];
const CHARGE = { charging: 'charging', full: 'full', 'not-charging': 'not charging' };
const ACCOUNT = {
  'signed-in': ['Signed in', 'good'],
  remembered: ['Signs in when started', ''],
  'signed-out': ['Not signed in', 'warn'],
};
/** @param {boolean | null | undefined} v */
const onOff = (v) => (v ? 'On' : 'Off');

/**
 * The store apps the Stores section lists: the installed ones. Not the Xbox app: Xbox games start without it, so Rust
 * reports the Xbox store as always there, and has nothing to say about the app itself.
 * @param {State} state
 */
const storeApps = (state) => [...state.stores.values()].filter((s) => s.installed && s.store !== 'xbox');

/** @param {number | null} level @param {Charge | null} charge */
export function batteryText(level, charge) {
  if (level == null) return 'Unknown';
  return CHARGE[charge] ? `${level}% · ${CHARGE[charge]}` : `${level}%`;
}

/**
 * The next auto-off time in the direction pressed. A time the headset reports that isn't in the list steps to the
 * nearest listed one on that side.
 * @param {number} minutes
 * @param {number} dir -1 or 1
 */
export function stepAutoOff(minutes, dir) {
  const next = dir > 0 ? AUTO_OFF.find((m) => m > minutes) : AUTO_OFF.findLast((m) => m < minutes);
  return next ?? minutes;
}

/** The sections the first level lists: the Headset one only once its receiver is plugged in. @param {State} state */
export const visibleSections = (state) =>
  SECTIONS.filter((x) => x.key !== 'headset' || state.accessories?.headset.receiver);

/**
 * One line per section on the first level: what is going on there, and a tone.
 * @param {string} key
 * @param {State} state
 * @returns {[string, string?]}
 */
export function sectionSummary(key, state) {
  const { sound, accessories: acc } = state;
  if (key === 'sound') {
    const out = sound?.outputs.find((d) => d.default);
    if (!out) return ['…'];
    return [`${out.name} · ${sound.muted ? 'muted' : `${sound.volume ?? '?'}%`}`];
  }
  if (key === 'headset') {
    // Listed only while the receiver is plugged in (visibleSections).
    const h = acc.headset;
    if (h.on === null) return ['…'];
    if (!h.on) return ['Off'];
    const low = h.battery != null && h.battery <= 15 && h.charge === 'battery';
    return [`On · ${batteryText(h.battery, h.charge)}`, low ? 'warn' : 'good'];
  }
  if (key === 'controllers') {
    const pads = acc?.controllers ?? [];
    if (!pads.length) return ['None connected'];
    const levels = pads.map((c) => (c.status ? `${c.status.battery}%` : '?')).join(', ');
    return [`${pads.length} connected · ${levels}`];
  }
  if (key === 'popups') {
    const quiet = { on: 'Quiet', off: 'Pop-ups on', partly: 'Partly quiet' }[state.quiet?.state] ?? '…';
    const stats = state.overlays.nvidia_stats;
    return [stats === null ? quiet : `Stats ${stats ? 'on' : 'off'} · ${quiet.toLowerCase()}`];
  }
  if (key === 'stores') {
    const installed = storeApps(state);
    if (!installed.length) return ['No store apps'];
    const out = installed.filter((s) => s.account === 'signed-out');
    if (out.length) return [`${out.map((s) => s.name).join(', ')}: sign in`, 'warn'];
    // GOG Galaxy reports no account, so it counts neither for nor against "All signed in".
    const known = installed.filter((s) => s.account !== 'unknown');
    if (known.length && known.every((s) => s.account === 'signed-in')) return ['All signed in', 'good'];
    return [`${installed.length} installed`];
  }
  return state.setup?.needed ? ['Setup needed', 'warn'] : [state.display ?? ''];
}

/**
 * Rows of a section.
 * @param {string} key
 * @param {State} state
 * @returns {Row[]}
 */
export function sectionRows(key, state) {
  /** @type {Row[]} */
  const rows = [];
  const { sound, accessories: acc, prefs } = state;
  if (key === 'sound') {
    if (!sound) return [{ label: 'Sound devices', value: 'Not available' }];
    rows.push({ heading: 'Output' });
    for (const d of sound.outputs) rows.push({ kind: 'device', id: d.id, label: d.name, value: d.default ? 'In use' : '', tone: 'good' });
    rows.push({ kind: 'volume', adjust: true, label: 'Volume', value: sound.muted ? 'Muted' : `${sound.volume ?? '?'}%` });
    rows.push({ kind: 'mute', label: 'Mute', value: onOff(sound.muted) });
    rows.push({ heading: 'Microphone' });
    for (const d of sound.inputs) rows.push({ kind: 'device', id: d.id, label: d.name, value: d.default ? 'In use' : '', tone: 'good' });
    rows.push({ kind: 'micmute', label: 'Mute microphone', value: onOff(sound.mic_muted) });
    rows.push({ heading: 'Automatic' });
    rows.push({ kind: 'follows', label: 'Sound follows the headset and controller headphones', value: onOff(prefs?.sound_follows) });
  } else if (key === 'headset') {
    const h = acc?.headset;
    rows.push({ heading: 'Logitech PRO X 2 LIGHTSPEED' });
    // The section stays open when the receiver is pulled out while it shows.
    if (!h?.receiver) rows.push({ label: 'Receiver', value: 'Not plugged in', tone: 'warn' });
    else if (!h.on) rows.push({ label: 'Headset', value: h.on === false ? 'Off' : 'Checking…' });
    else {
      rows.push({ label: 'Headset', value: 'On', tone: 'good' });
      rows.push({ label: 'Battery', value: batteryText(h.battery, h.charge) });
      if (h.sidetone != null) rows.push({ kind: 'sidetone', adjust: true, label: 'Sidetone (your own voice)', value: `${h.sidetone}%` });
      if (h.auto_off != null) rows.push({ kind: 'autooff', adjust: true, label: 'Turns off when unused after', value: h.auto_off ? `${h.auto_off} min` : 'Never' });
    }
  } else if (key === 'controllers') {
    const pads = acc?.controllers ?? [];
    rows.push({ kind: 'touchmouse', label: 'Touchpad as mouse (not over games)', value: onOff(prefs?.touchpad_mouse) });
    if (!pads.length) rows.push({ label: 'No controller connected', value: '' });
    pads.forEach((c, i) => {
      rows.push({ heading: `Controller ${i + 1} · ${c.bluetooth ? 'Bluetooth' : 'USB cable'}` });
      rows.push({ label: 'Battery', value: c.status ? batteryText(c.status.battery, c.status.charge) : 'Not reported over this link' });
      const jack = c.status?.headphones;
      const where = !jack ? 'Not plugged in' : c.bluetooth ? 'Plugged in · sound needs the USB cable' : 'Plugged in';
      rows.push({ label: 'Headphones', value: where, tone: jack && c.bluetooth ? 'warn' : '' });
      if (c.bluetooth) rows.push({ kind: 'padoff', id: c.id, label: 'Turn off', value: '' });
    });
  } else if (key === 'popups') {
    const { nvidia_overlay: installed, nvidia_stats: on } = state.overlays;
    const label = 'Performance stats (NVIDIA)';
    // An unknown state can still be switched: the overlay logs the switch, and Lamplit knows the state from then on.
    const value = on === null ? 'Unknown' : onOff(on);
    rows.push(installed ? { kind: 'stats', label, value, tone: on ? 'good' : '' } : { label, value: 'Not available' });
    rows.push({
      kind: 'quiet',
      label: 'Quiet mode (no pop-ups, no Game Bar recording)',
      value: { on: 'On', off: 'Off', partly: 'Partly on' }[state.quiet?.state] ?? '…',
      tone: state.quiet?.state === 'on' ? 'good' : state.quiet?.state === 'partly' ? 'warn' : '',
    });
  } else if (key === 'stores') {
    for (const s of storeApps(state)) {
      const [text, tone] = ACCOUNT[s.account] ?? [s.running ? 'Running' : 'Not running', ''];
      rows.push({ kind: 'store', store: s.store, label: s.name, value: text, tone });
    }
    if (!rows.length) rows.push({ label: 'No store apps found', value: '' });
    if (state.stores.get('steam')?.installed) {
      rows.push({ heading: "Steam's DevTools port" });
      rows.push({ kind: 'steamport', label: 'Open it (PS button guard, Steam pop-ups in quiet mode)', value: onOff(prefs?.steam_devtools) });
      rows.push({ label: 'While it is open, any program on this PC can control Steam', value: '' });
    }
  } else if (key === 'system') {
    if (state.setup?.needed) rows.push({ kind: 'setup', label: 'First-time setup (asks Windows once)', value: 'Needed', tone: 'warn' });
    rows.push({ kind: 'onlineart', label: "Find art online (sends game names to Steam's store)", value: onOff(prefs?.online_art) });
    rows.push({ label: 'Display', value: state.display ?? 'Unknown' });
  }
  return rows;
}

/** What a focusable row is about, unchanged when the rows around it change. @param {Row} row */
export const rowKey = (row) => `${row.kind}:${row.id ?? row.store ?? row.key ?? ''}`;

/**
 * Where the row with `focus` is now, else the first row that can take focus; -1 when none can.
 * @param {Row[]} rows
 * @param {string | null} focus
 */
export function focusIndex(rows, focus) {
  const at = rows.findIndex((r) => r.kind && rowKey(r) === focus);
  return at >= 0 ? at : rows.findIndex((r) => r.kind);
}
