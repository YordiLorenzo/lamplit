// @ts-check
// About is a face of the game's plate. Screenshots use local asset URLs; opening one leaves the plate in place.

import { libraryDetails } from './api.js';
import { showHints } from './hints.js';
import { backToMenu } from './library.js';
import { showSheet } from './lift.js';
import { sfx } from './sounds.js';
import { els, state } from './state.js';
import { showPicture } from './viewer.js';

let requests = 0;

export async function openAbout() {
  const asked = ++requests;
  const id = /** @type {string} */ (state.lifted);
  Object.assign(state.about, { open: true, data: null, idx: 0, fullscreen: false });
  els.aboutDescription.textContent = '';
  els.aboutText.scrollTop = 0;
  els.aboutMeta.textContent = '';
  els.aboutGenres.replaceChildren();
  els.aboutScreens.replaceChildren();
  // Prefs can still be on their way just after start; Rust answers null itself while Find art online is off.
  const online = state.prefs?.online_art !== false;
  els.aboutStatus.textContent = online ? 'Looking up this game…' : 'Turn on Find art online in Settings to see details.';
  showSheet('about');
  sfx.open();
  showHints();
  if (!online) return;
  try {
    const data = await libraryDetails(id);
    if (asked !== requests || !state.about.open) return;
    state.about.data = data;
    els.aboutStatus.textContent = data ? '' : 'Lamplit has no details for this game.';
    if (data) {
      els.aboutDescription.textContent = data.description;
      els.aboutMeta.textContent = [data.developers.join(', '), data.publishers.join(', '), data.released].filter(Boolean).join(' · ');
      els.aboutGenres.replaceChildren(...data.genres.map((genre) => Object.assign(document.createElement('span'), { textContent: genre })));
      els.aboutScreens.replaceChildren(...data.screenshots.map((shot, idx) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.idx = String(idx);
        button.setAttribute('aria-label', `Screenshot ${idx + 1} of ${data.screenshots.length}`);
        button.append(Object.assign(document.createElement('img'), { src: shot.thumb, alt: '' }));
        return button;
      }));
    }
    focusScreenshot();
  } catch (error) {
    if (asked !== requests || !state.about.open) return;
    els.aboutStatus.textContent = error.kind === 'player' ? error.message : 'Details could not be loaded. Try again in a moment.';
  }
}

function focusScreenshot() {
  const { about } = state;
  for (const [idx, button] of [...els.aboutScreens.children].entries()) {
    button.classList.toggle('focus', idx === about.idx);
    button.setAttribute('aria-current', String(idx === about.idx));
    if (idx === about.idx) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const shot = about.data?.screenshots[about.idx];
  const label = `Screenshot ${about.idx + 1} of ${about.data?.screenshots.length}`;
  showPicture(about.fullscreen && shot ? { src: shot.full, alt: label, caption: label } : null);
  showHints();
}

/** @param {import('./api.js').Action} action */
export function actAbout(action) {
  const { about } = state;
  if (action === 'back') {
    sfx.back();
    if (about.fullscreen) {
      about.fullscreen = false;
      focusScreenshot();
    } else backToMenu();
    return;
  }
  const count = about.data?.screenshots.length ?? 0;
  if (!about.fullscreen && (action === 'up' || action === 'down')) {
    els.aboutText.scrollBy({ top: (action === 'up' ? -1 : 1) * els.aboutText.clientHeight / 2 });
    return;
  }
  if (!count) return;
  if (action === 'left' || action === 'right') {
    const next = Math.max(0, Math.min(count - 1, about.idx + (action === 'left' ? -1 : 1)));
    if (next === about.idx) return sfx.edge();
    about.idx = next;
    sfx.move();
  } else if (action === 'ok' && !about.fullscreen) {
    about.fullscreen = true;
    sfx.open();
  }
  focusScreenshot();
}

els.aboutScreens.addEventListener('click', (event) => {
  const button = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('[data-idx]'));
  if (!button || !state.about.open) return;
  state.about.idx = Number(button.dataset.idx);
  actAbout('ok');
});
els.viewer.addEventListener('click', () => {
  if (state.about.fullscreen) actAbout('back');
});
