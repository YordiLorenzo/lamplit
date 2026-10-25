// @ts-check
// The Settings screen: a list of sections with a one-line summary each, and the rows of the open section. What the
// rows say comes from logic.js; this file draws them and acts on them.

import * as api from './api.js';
import { showHints, toast } from './hints.js';
import { showInfo } from './library.js';
import { SECTIONS, focusIndex, rowKey, sectionRows, sectionSummary, stepAutoOff, visibleSections } from './logic.js';
import { sfx } from './sounds.js';
import { els, state } from './state.js';

function renderSettings() {
  const s = state.settings;
  const section = SECTIONS.find((x) => x.key === s.section);
  els.settingsTitle.textContent = section?.title ?? 'Settings';
  s.rows = section
    ? sectionRows(section.key, state)
    : visibleSections(state).map((x) => {
        const [value, tone] = sectionSummary(x.key, state);
        return { kind: 'section', key: x.key, label: x.title, value, tone };
      });
  // Focus stays on its row when a refresh adds or removes rows above it.
  s.idx = focusIndex(s.rows, s.focus);
  s.focus = s.idx >= 0 ? rowKey(s.rows[s.idx]) : null;
  els.settingsList.textContent = '';
  s.rows.forEach((r, i) => {
    if (r.heading) {
      const h = document.createElement('h3');
      h.textContent = r.heading;
      els.settingsList.append(h);
      return;
    }
    const row = document.createElement('div');
    row.className = 'row' + (r.kind ? '' : ' info') + (i === s.idx ? ' focus' : '') + (r.adjust ? ' adjust' : '');
    const label = document.createElement('span');
    label.textContent = r.label;
    const value = document.createElement('span');
    value.className = 'value ' + (r.tone ?? '');
    value.textContent = r.value;
    row.append(label, value);
    row.addEventListener('click', () => {
      if (!r.kind) return;
      s.focus = rowKey(r);
      renderSettings();
      selectSetting();
    });
    els.settingsList.append(row);
    if (i === s.idx) {
      requestAnimationFrame(() => {
        // The heading right above the focused row stays in view with it.
        if (row.previousElementSibling?.tagName === 'H3') row.previousElementSibling.scrollIntoView({ block: 'nearest' });
        row.scrollIntoView({ block: 'nearest' });
      });
    }
  });
  showHints();
}

/**
 * A call whose failure leaves that part of the settings as it was (api.js logs the failure).
 * @template T
 * @param {Promise<T>} call
 * @returns {Promise<T | undefined>}
 */
const orKeep = (call) => call.catch(() => undefined);

/** Everything the settings show, fetched together. */
async function refreshSettings() {
  const [stores, overlays, quiet, setup, sound, accessories, prefs, display] = await Promise.all([
    orKeep(api.storesStatus()),
    orKeep(api.overlayState()),
    orKeep(api.quietState()),
    orKeep(api.setupState()),
    orKeep(api.soundState()),
    orKeep(api.accessoriesState()),
    orKeep(api.prefsState()),
    orKeep(api.displayMode()),
  ]);
  if (stores) setStores(stores);
  state.overlays = overlays ?? state.overlays;
  state.quiet = quiet ?? state.quiet;
  state.setup = setup ?? state.setup;
  state.sound = sound ?? state.sound;
  state.accessories = accessories ?? state.accessories;
  state.prefs = prefs ?? state.prefs;
  state.display = display ?? state.display;
  if (state.mode === 'settings') renderSettings();
}

/**
 * Refreshes asked for so far. Two events close together start two refreshes, whose replies can come back in either
 * order; only the newest one's replies are shown.
 */
let refreshes = 0;

/** The headset, a controller or the sound device changed: refresh them and the sound. */
export async function refreshAccessories() {
  if (state.mode !== 'settings') return;
  const asked = ++refreshes;
  const [accessories, sound] = await Promise.all([orKeep(api.accessoriesState()), orKeep(api.soundState())]);
  if (asked !== refreshes) return;
  state.accessories = accessories ?? state.accessories;
  state.sound = sound ?? state.sound;
  renderSettings();
}

/** Setup has ended: the System row shows whether it is still needed. @param {import('./api.js').Setup} setup */
export function setSetup(setup) {
  state.setup = setup;
  if (state.mode === 'settings') renderSettings();
}

/** @param {import('./api.js').StoreStatus[]} list */
export function setStores(list) {
  state.stores = new Map(list.map((s) => [s.store, s]));
  if (state.mode === 'settings') renderSettings();
  showInfo();
}

export function openSettings() {
  state.mode = 'settings';
  state.settings = { section: null, focus: null, idx: 0, rows: [] };
  els.settings.classList.add('on');
  sfx.open();
  renderSettings();
  refreshSettings();
}

export function closeSettings() {
  state.mode = 'browse';
  els.settings.classList.remove('on');
  sfx.back();
  showHints();
}

/** ○ in a section goes back to the list of sections, on the one it came from; on the list it closes. */
export function backSettings() {
  const s = state.settings;
  if (!s.section) return closeSettings();
  s.focus = rowKey({ kind: 'section', key: s.section });
  s.section = null;
  sfx.back();
  renderSettings();
}

/** @param {number} delta */
export function moveSettings(delta) {
  const s = state.settings;
  const focusable = s.rows.filter((r) => r.kind);
  const at = focusable.indexOf(s.rows[s.idx]);
  const next = focusable[Math.max(0, Math.min(focusable.length - 1, at + delta))];
  if (!next || next === s.rows[s.idx]) return sfx.edge();
  s.focus = rowKey(next);
  sfx.move();
  renderSettings();
}

/**
 * A headset change waits for the headset's answer. A held ← or → repeats meanwhile, and each repeat would send the
 * same value again, so presses are dropped until the answer is in.
 */
let headsetBusy = false;
/**
 * The stats switch presses NVIDIA's hotkey, which toggles, and waits up to 2 s for NVIDIA's answer. A second press
 * meanwhile would switch the stats back, so presses are dropped until the answer is in.
 */
let statsBusy = false;

/** ← and → on a row with a range: volume, sidetone, auto-off. @param {number} dir */
export async function adjustSetting(dir) {
  const row = state.settings.rows[state.settings.idx];
  if (row.kind !== 'volume' && headsetBusy) return;
  sfx.move();
  try {
    if (row.kind === 'volume') {
      const volume = await api.soundChangeVolume(dir * 5);
      // Into the sound shown now: a refresh may have replaced it while Windows answered.
      state.sound.volume = volume;
    } else await adjustHeadset(row.kind, dir);
  } catch (e) {
    toast(e.message);
  }
  if (state.mode === 'settings') renderSettings();
}

/** @param {string} kind sidetone or autooff @param {number} dir */
async function adjustHeadset(kind, dir) {
  headsetBusy = true;
  try {
    const h = state.accessories.headset;
    const headset =
      kind === 'sidetone'
        ? await api.headsetSet('sidetone', Math.max(0, Math.min(100, h.sidetone + dir * 10)))
        : await api.headsetSet('auto-off', stepAutoOff(h.auto_off, dir));
    // Into the accessories shown now: a refresh may have replaced them while the headset answered.
    state.accessories.headset = headset;
  } finally {
    headsetBusy = false;
  }
}

/** The rows that switch one of the player's prefs. */
const PREF_ROWS = ['follows', 'touchmouse', 'steamport', 'onlineart'];

export async function selectSetting() {
  const s = state.settings;
  const row = s.rows[s.idx];
  if (!row?.kind || row.adjust || (row.kind === 'stats' && statsBusy)) return;
  sfx.open();
  if (row.kind === 'section') {
    s.section = row.key;
    s.focus = null;
    return renderSettings();
  }
  try {
    if (row.kind === 'device') {
      state.sound = await api.soundSetDefault(row.id);
    } else if (row.kind === 'mute' || row.kind === 'micmute') {
      const mic = row.kind === 'micmute';
      await api.soundSetMute(mic, !(mic ? state.sound.mic_muted : state.sound.muted));
      state.sound = await api.soundState();
    } else if (row.kind === 'follows') {
      state.prefs = await api.prefsSetSoundFollows(!state.prefs?.sound_follows);
      state.sound = await api.soundState();
    } else if (row.kind === 'touchmouse') {
      state.prefs = await api.prefsSetTouchpadMouse(!state.prefs?.touchpad_mouse);
    } else if (row.kind === 'steamport') {
      state.prefs = await api.prefsSetSteamDevtools(!state.prefs?.steam_devtools);
      toast(state.prefs.steam_devtools ? "Steam's DevTools port opens when Steam next starts." : "Steam's DevTools port closes when Steam next starts.");
    } else if (row.kind === 'onlineart') {
      state.prefs = await api.prefsSetOnlineArt(!state.prefs?.online_art);
    } else if (row.kind === 'padoff') {
      await api.controllerTurnOff(row.id);
      toast('Controller turned off.');
    } else if (row.kind === 'stats') {
      statsBusy = true;
      try {
        const stats = await api.overlayToggleStats();
        state.overlays.nvidia_stats = stats;
      } finally {
        statsBusy = false;
      }
    } else if (row.kind === 'quiet') {
      // Off when the player has it on (that restores what was there, also when only partly applied), else on.
      const report = await api.quietSet(!state.quiet?.active);
      state.quiet = report;
      if (report.notes.length) toast(report.notes.join(' '));
    } else if (row.kind === 'setup') {
      // The command returns only once the prompt is answered, and Lamplit says how setup went when it ends.
      toast('Answer the Windows prompt with a keyboard or mouse.');
      await api.setupStart();
    } else if (row.kind === 'store') {
      await api.storesOpen(row.store);
    }
  } catch (e) {
    toast(e.message);
    // The row shows what Rust holds, also after a change that failed halfway.
    if (PREF_ROWS.includes(row.kind)) state.prefs = (await orKeep(api.prefsState())) ?? state.prefs;
  }
  if (state.mode === 'settings') renderSettings();
}
