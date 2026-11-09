// @ts-check
// The report is a face of Settings' plate. Saving sends the same text the player read, not a fresh snapshot.

import * as api from './api.js';
import { showHints, toast } from './hints.js';
import { turnPlate } from './settings.js';
import { sfx } from './sounds.js';
import { els, state } from './state.js';

/** @type {() => void} */
let backTo;

/** @param {() => void} back */
export async function openReport(back) {
  backTo = back;
  const from = els.settings.getBoundingClientRect();
  state.mode = 'report';
  state.report = { text: '', loading: true, saving: false };
  const report = state.report;
  els.report.classList.add('on');
  els.reportText.textContent = 'Preparing the report…';
  els.reportText.scrollTop = 0;
  els.reportSave.disabled = true;
  els.reportSave.textContent = 'Save';
  sfx.open();
  showHints();
  turnPlate('settings-to-report', from, 'tap');
  try {
    const text = await api.reportPreview();
    // Back, then opening again, can leave the old request in flight.
    if (state.mode !== 'report' || state.report !== report) return;
    report.text = text;
    els.reportText.textContent = text;
    els.reportSave.disabled = false;
  } catch (e) {
    if (state.mode !== 'report' || state.report !== report) return;
    els.reportText.textContent = `Couldn't prepare the report. ${e.message}`;
  } finally {
    report.loading = false;
    if (state.mode === 'report' && state.report === report) showHints();
  }
}

function back() {
  els.report.classList.remove('on');
  backTo();
}

/** A game's news takes the screen, so the report and the plate close with it. */
export function closeReport() {
  state.mode = 'browse';
  els.report.classList.remove('on');
  els.settings.classList.remove('on');
  showHints();
}

async function save() {
  const report = state.report;
  if (report.loading || report.saving || !report.text) return;
  report.saving = true;
  els.reportSave.disabled = true;
  els.reportSave.textContent = 'Saving…';
  showHints();
  try {
    const name = await api.reportSave(report.text);
    if (state.mode === 'report' && state.report === report) back();
    toast(`${name} is in Downloads.`);
  } catch (e) {
    toast(e.message, { warn: true });
  } finally {
    report.saving = false;
    if (state.mode === 'report' && state.report === report) {
      els.reportSave.disabled = false;
      els.reportSave.textContent = 'Save';
      showHints();
    }
  }
}

/** @param {import('./api.js').Action} action */
export function actReport(action) {
  if (action === 'back') back();
  else if (action === 'ok') save();
  else if (action === 'up' || action === 'down' || action === 'l1' || action === 'r1') {
    const amount = els.reportText.clientHeight * (action === 'l1' || action === 'r1' ? 0.8 : 0.15);
    els.reportText.scrollTop += (action === 'up' || action === 'l1' ? -1 : 1) * amount;
  }
}

els.reportSave.addEventListener('click', () => state.mode === 'report' && save());
els.reportBack.addEventListener('click', () => state.mode === 'report' && back());
