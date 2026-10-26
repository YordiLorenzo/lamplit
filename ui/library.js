// @ts-check
// The home screen: the cover row, and the hero art, logo and details of the focused game.

import { assetUrl, librarySetFavourite, librarySetHidden } from './api.js';
import { showHints, toast } from './hints.js';
import { detailChoices, narrowed, playTimeText, playedText, readable, rowOf, storeWarning, words } from './logic.js';
import { sfx } from './sounds.js';
import { byId, els, focused, icon, state, storeName, withStoreLogo } from './state.js';

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
  // A search that matches nothing, or a library of hidden games, leaves no game to show.
  els.info.classList.toggle('off', !g);
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
    } else {
      const at = state.idx;
      closeDetails();
      const list = await librarySetHidden(g.id, true);
      // The row stays live while Rust saves: a player who moved on keeps the game they moved to (setGames).
      const stayed = focused()?.id === g.id;
      setGames(list);
      if (stayed) {
        // Focus goes to the game that took its place.
        state.idx = Math.max(0, Math.min(at, state.games.length - 1));
        render();
      }
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
  state.all = list.map((g) => ({ ...g, el: newCover(g.name) }));
  state.all.forEach(paintCover);
  showRow(keep);
}

/** The games the row can show at all: every game that isn't hidden. */
const shownCount = () => state.all.filter((g) => !g.hidden).length;

/**
 * Fills the cover row (logic.js rowOf: favourites first, hidden games left out, and what the search, the store filter
 * and the sort let through), with focus on game `keep` when it is among them, else on the first.
 * @param {string | null} [keep]
 */
export function showRow(keep = null) {
  state.games = rowOf(state.all, state.find);
  const k = state.games.findIndex((g) => g.id === keep);
  state.idx = Math.max(0, k);
  // Details still names the game that is gone, and ✕ there would start whatever is focused now. They close before the
  // row is drawn, which would show their hints for a game that isn't there.
  if (k < 0 && state.mode === 'details') closeDetails();
  const shown = shownCount();
  els.empty.hidden = shown > 0;
  els.empty.textContent = state.all.length ? 'Every game is hidden. Settings > Hidden games shows them again.' : 'No games found';
  els.track.replaceChildren(...state.games.map((g) => g.el));
  els.noMatch.hidden = state.games.length > 0 || !shown;
  showFilters();
  render();
}

/**
 * Focuses game `id`. When the search or the store filter keeps it out of the row, every game comes back first, so
 * the game Lamplit points the player to is in sight. A hidden game stays out of the row even then.
 * @param {string} id
 */
export function focusGame(id) {
  const k = state.games.findIndex((g) => g.id === id);
  if (k >= 0) state.idx = k;
  else if (byId(id)) {
    state.find = { ...state.find, query: '', store: null };
    showRow(id);
  }
}

/** ○ on a narrowed row: every game again, still on the focused one. */
export function showAllGames() {
  state.find = { ...state.find, query: '', store: null };
  sfx.back();
  showRow(focused()?.id);
}

/**
 * Above the row, while it isn't every game by last played: the search, the store and the sort that shape it, and how
 * many games it holds.
 */
function showFilters() {
  const { query, store, sort } = state.find;
  /** @param {string} cls @param {(string | Node)[]} content */
  const pill = (cls, ...content) => {
    const el = document.createElement('span');
    el.className = `pill ${cls}`;
    el.append(...content);
    return el;
  };
  /** @type {Node[]} */
  const parts = [];
  if (words(query).length) parts.push(pill('query', icon('icon-search'), query.trim()));
  if (store) parts.push(pill('', ...withStoreLogo(store === 'pc' ? null : store, store)));
  if (sort === 'name') parts.push(pill('quiet', 'A to Z'));
  if (narrowed(state.find)) parts.push(document.createTextNode(`${state.games.length} of ${shownCount()} games`));
  els.filters.replaceChildren(...parts);
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
