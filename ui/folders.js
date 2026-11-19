// @ts-check
// A list of rows the d-pad moves through, as Add a game shows the PC's programs and folders and Change art a folder's
// pictures or videos. A row with a `kind` can take focus; a heading or a line without one can't.

import { icon } from './state.js';

/**
 * A heading, or a row: `kind` is what ✕ does there ('browse', 'program', 'drive', 'folder', 'exe', 'script',
 * 'picture', 'video'; '' for none), `path` the file or folder, `title` the name a game from it would get.
 * @typedef {{ heading?: string, kind?: string, label?: string, value?: string, path?: string, title?: string }} Row
 */

/** Icons in front of a row, by its kind. */
const ICONS = {
  browse: 'i-drive', drive: 'i-drive', folder: 'i-folder', exe: 'i-app', script: 'i-app', program: 'i-app',
  picture: 'i-photo', video: 'i-play',
};

/**
 * A folder's rows: its drives, folders and files, or one line saying `empty` when it has none.
 * @param {import('./api.js').Folder} folder @param {string} empty @returns {Row[]}
 */
export function folderRows(folder, empty) {
  const entries = folder.entries.map((e) => ({ kind: e.kind, label: e.name, path: e.path, title: e.title ?? '' }));
  return entries.length ? entries : [{ kind: '', label: empty }];
}

/**
 * Draws `rows` in `list`, with focus on the `idx`th row that can take it, kept in view.
 * @param {HTMLElement} list @param {Row[]} rows @param {number} idx
 */
export function drawRows(list, rows, idx) {
  const focusable = rows.filter((r) => r.kind);
  list.replaceChildren(
    ...rows.map((r) => {
      if (r.heading) {
        const h = document.createElement('h3');
        h.textContent = r.heading;
        return h;
      }
      const row = document.createElement('div');
      const focus = r.kind && focusable.indexOf(r) === idx;
      row.className = `row ${r.kind || 'info'}${focus ? ' focus' : ''}`;
      const label = document.createElement('span');
      label.append(...(ICONS[r.kind] ? [icon(ICONS[r.kind])] : []), r.label);
      const value = document.createElement('span');
      value.className = 'value';
      value.textContent = r.value ?? '';
      row.append(label, value);
      if (focus) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }));
      return row;
    })
  );
}

/**
 * The row a click landed on, among `rows` drawn in `list`, or null for a heading or a line that can't take focus.
 * @param {HTMLElement} list @param {Row[]} rows @param {Event} event
 */
export function clickedRow(list, rows, event) {
  const row = /** @type {Element} */ (event.target).closest('.row');
  if (!row) return null;
  const target = rows.filter((r) => r.heading === undefined)[[...list.querySelectorAll('.row')].indexOf(row)];
  return target?.kind ? target : null;
}
