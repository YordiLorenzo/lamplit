// @ts-check
// The home screen: the cover row, and the hero art, logo and details of the focused game.

import { assetUrl, librarySetFavourite, librarySetHidden } from './api.js';
import { showHints, toast } from './hints.js';
import { byPlayed, detailChoices, playTimeText, playedText, readable, rowGames, storeWarning } from './logic.js';
import { sfx } from './sounds.js';
import { byId, els, focused, state, storeName, withStoreLogo } from './state.js';

/**
 * @typedef {import('./api.js').Game} Game
 * @typedef {import('./api.js').Art} Art
 * @typedef {import('./state.js').Shown} Shown
 */

/** @param {string | null} path */
const fileUrl = (path) => (path ? assetUrl(path) : null);

// ---------- accent colour from the art ----------

/**
 * The image is loaded with crossOrigin set, so a file without the CORS header fails to load instead of reaching
 * here, and the canvas can always be read back.
 * @param {HTMLImageElement} img
 */
function sampleAccent(img) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 36;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  ctx.drawImage(img, 0, 0, 64, 36);
  const d = ctx.getImageData(0, 0, 64, 36).data;
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const max = Math.max(d[i], d[i + 1], d[i + 2]);
    const min = Math.min(d[i], d[i + 1], d[i + 2]);
    const sat = max ? (max - min) / max : 0;
    const lum = max / 255;
    // Favour vivid, mid-bright pixels; dark and washed-out ones barely count.
    const wt = sat * sat * (lum > 0.2 && lum < 0.95 ? 1 : 0.15) + 0.002;
    r += d[i] * wt;
    g += d[i + 1] * wt;
    b += d[i + 2] * wt;
    w += wt;
  }
  return readable([r / w, g / w, b / w]);
}

/** @param {number[] | null | undefined} rgb */
function applyAccent(rgb) {
  document.documentElement.style.setProperty('--accent', (rgb ?? [140, 170, 255]).join(' '));
}

// ---------- hero, logo and details of the focused game ----------

let heroTimer = 0;

/** @param {Shown} g */
function setHero(g) {
  const src = g.art.hero || g.art.portrait;
  const url = fileUrl(src);
  const blurred = !g.art.hero && !!src;
  const key = `${url}|${blurred}`;
  if (key === state.heroKey) return;
  state.heroKey = key;

  const show = () => {
    if (state.heroKey !== key) return;
    const next = els.heroes[1 - state.heroLayer];
    const current = els.heroes[state.heroLayer];
    next.style.backgroundImage = url ? `url("${url}")` : 'none';
    next.classList.toggle('blurred', blurred);
    next.classList.add('on');
    current.classList.remove('on');
    state.heroLayer = 1 - state.heroLayer;
  };
  if (!url) {
    applyAccent(state.accents.get(g.id));
    show();
    return;
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    if (!state.accents.has(g.id)) state.accents.set(g.id, sampleAccent(img));
    if (focused()?.id === g.id) applyAccent(state.accents.get(g.id));
    show();
  };
  img.onerror = show;
  img.src = url;
}

/** What the logo spot shows: a logo file, or the game's name when it has none. */
let logoKey = '';

/** @param {Shown} g */
function setLogo(g) {
  const url = fileUrl(g.art.logo);
  const key = url ?? g.name;
  // showInfo also runs on store and play news; drawing the same logo again would blink it and replay its entrance.
  if (key === logoKey) return;
  logoKey = key;
  const showTitle = () => {
    if (key !== logoKey) return;
    els.logo.classList.remove('on');
    els.title.textContent = g.name;
    els.title.classList.add('on');
  };
  els.title.classList.remove('on');
  els.logo.classList.remove('on');
  if (!url) return showTitle();
  els.logo.onload = () => {
    if (key === logoKey) els.logo.classList.add('on');
  };
  els.logo.onerror = showTitle;
  els.logo.alt = g.name;
  els.logo.src = url;
}

export function showInfo() {
  const g = focused();
  if (!g) return showHints();
  setLogo(g);
  // The pill shows the store's logo and key, which the stylesheet upper-cases: STEAM, EPIC, and PC outside any store.
  els.store.replaceChildren(...withStoreLogo(g.store, g.store ?? 'pc'));
  const warning = storeWarning(g, state.stores);
  els.note.textContent = state.running === g.id ? 'Playing' : warning ?? g.note ?? '';
  els.note.classList.toggle('warn', state.running !== g.id && !!warning);
  els.played.textContent = playedText(g.last_played);
  const time = playTimeText(g.play_minutes);
  els.playtime.textContent = time && `${time} played`;
  if (state.accents.has(g.id)) applyAccent(state.accents.get(g.id));
  clearTimeout(heroTimer);
  heroTimer = setTimeout(() => setHero(g), 140);
  showHints();
}

export function openDetails() {
  const g = focused();
  els.dName.textContent = g.name;
  els.dStore.replaceChildren(...withStoreLogo(g.store, storeName(g.store) ?? 'Not from a store'));
  els.dPlayed.textContent = playedText(g.last_played).replace(/^Played /, '') || 'Not yet';
  // Lamplit counts from 0.2.0 on, so a game played before has no count of its own.
  els.dTime.textContent = playTimeText(g.play_minutes, true) || 'Not counted yet';
  els.dDir.textContent = g.dir;
  state.detailsIdx = 0;
  renderChoices();
  state.mode = 'details';
  els.details.classList.add('on');
  sfx.open();
  showHints();
}

export function closeDetails() {
  state.mode = 'browse';
  els.details.classList.remove('on');
  sfx.back();
  showHints();
}

/** The choices under the details, the focused one marked. */
function renderChoices() {
  const rows = detailChoices(focused(), state.running).map((c, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (i === state.detailsIdx ? ' focus' : '');
    row.textContent = c.label;
    return row;
  });
  els.dChoices.replaceChildren(...rows);
}

/** The choice ✕ picks in Details. */
export const detailChoice = () => detailChoices(focused(), state.running)[state.detailsIdx];

/** @param {number} delta */
export function moveDetails(delta) {
  const next = Math.max(0, Math.min(detailChoices(focused(), state.running).length - 1, state.detailsIdx + delta));
  if (next === state.detailsIdx) return sfx.edge();
  state.detailsIdx = next;
  sfx.move();
  renderChoices();
  showHints();
}

/** Details' choices other than Play: the focused game in or out of the favourites, or hidden. */
export async function markGame() {
  const g = focused();
  const { kind } = detailChoice();
  try {
    if (kind === 'favourite') {
      sfx.open();
      // The row moves around the game, and focus stays on it.
      setGames(await librarySetFavourite(g.id, !g.favourite));
      renderChoices();
      showHints();
    } else {
      const at = state.idx;
      closeDetails();
      setGames(await librarySetHidden(g.id, true));
      // Focus goes to the game that took its place.
      state.idx = Math.max(0, Math.min(at, state.games.length - 1));
      render();
      toast(`${g.name} is hidden. Settings > Hidden games shows it again.`);
    }
  } catch (e) {
    toast(e.message);
  }
}

// ---------- the cover row ----------

/** @param {string} name */
function coverFallback(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `linear-gradient(160deg, hsl(${h} 45% 34%), hsl(${(h + 40) % 360} 50% 13%))`;
}

/** A cover with the game's name, which shows while it has no art, and a Playing badge. @param {string} name */
function newCover(name) {
  const el = document.createElement('div');
  el.className = 'cover';
  const label = document.createElement('div');
  label.className = 'name';
  label.textContent = name;
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = 'Playing';
  el.append(label, badge);
  return el;
}

/** @param {Shown} g */
export function paintCover(g) {
  const url = fileUrl(g.art.portrait);
  g.el.style.backgroundImage = url ? `url("${url}")` : coverFallback(g.name);
  g.el.classList.toggle('has-art', !!url);
  g.el.classList.toggle('playing', state.running === g.id);
}

/** A cover's width in px, measured from the stylesheet (--cover-h) again whenever the window's height changes. */
let cover = { forHeight: 0, width: 0 };

/** Covers sit side by side; the focused one grows and the row slides so it stays in the first slot. */
export function layout() {
  if (cover.forHeight !== innerHeight && state.games.length) {
    cover = { forHeight: innerHeight, width: parseFloat(getComputedStyle(state.games[0].el).width) };
  }
  const w = cover.width, gap = innerHeight * 0.02, grow = 1.14;
  const i = state.idx;
  state.games.forEach((g, k) => {
    const x = k * (w + gap) + (k > i ? w * (grow - 1) : 0);
    g.el.style.transform = `translate3d(${x}px, 0, 0) scale(${k === i ? grow : 1})`;
    g.el.classList.toggle('focus', k === i);
  });
  els.track.style.transform = `translate3d(${-i * (w + gap)}px, 0, 0)`;
}

export function render() {
  layout();
  showInfo();
}

/** @param {Game[]} list */
export function setGames(list) {
  const keep = focused()?.id;
  state.library = list;
  state.games = rowGames(list).map((g) => ({ ...g, el: newCover(g.name) }));
  const k = state.games.findIndex((g) => g.id === keep);
  state.idx = Math.max(0, k);
  // Details still names the game that is gone, and ✕ there would start whatever is focused now.
  if (k < 0 && state.mode === 'details') closeDetails();
  els.empty.hidden = state.games.length > 0;
  els.empty.textContent = list.length ? 'Every game is hidden. Settings > Hidden games shows them again.' : 'No games found';
  state.games.forEach(paintCover);
  els.track.replaceChildren(...state.games.map((g) => g.el));
  render();
}

export function sortByPlayed() {
  state.games = rowGames(state.games.sort(byPlayed));
  els.track.append(...state.games.map((g) => g.el));
}

/** @param {number} delta */
export function move(delta) {
  const next = Math.max(0, Math.min(state.games.length - 1, state.idx + delta));
  if (next === state.idx) {
    sfx.edge();
    focused().el.animate([{ translate: '0 0' }, { translate: `${Math.sign(delta) * 1.2}vh 0` }, { translate: '0 0' }], {
      duration: 200,
      easing: 'ease-out',
    });
    return;
  }
  state.idx = next;
  sfx.move();
  render();
}

/** @param {{ id: string, art: Art }} update */
export function onArt({ id, art }) {
  const g = byId(id);
  if (!g) return;
  g.art = art;
  paintCover(g);
  if (focused() === g) showInfo();
}
