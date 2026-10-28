// @ts-check
// The home screen: the cover row, the hero art, logo and details of the focused game, and its menu, which lifts its
// cover (lift.js).

import { assetUrl, dockCloseGame, dockState, libraryRemoveGame, librarySetFavourite, librarySetHidden } from './api.js';
import { showHints, toast } from './hints.js';
import { hold, holdRing, letGo } from './hold.js';
import { backToGame } from './launch.js';
import { face, lift, lower, settle, showSheet } from './lift.js';
import { accentOf, detailChoices, folderParts, lightOf, metaParts, narrowed, playTimeText, playedText, rowOf, storeWarning, words } from './logic.js';
import { reduced } from './morph.js';
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
 * The accent colour of the image at `url`, and how bright it is. It is read as a file and decoded straight to 64x36
 * off the main thread: drawing the 4K hero itself, or an ImageBitmap of the loaded image, decodes it on the main
 * thread, most of a frame or more. The asset protocol sends the CORS header, so the canvas can be read back.
 * @param {string} url
 */
async function sampleAccent(url) {
  const file = await (await fetch(url)).blob();
  const small = await createImageBitmap(file, { resizeWidth: 64, resizeHeight: 36, resizeQuality: 'medium' });
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 36;
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  ctx.drawImage(small, 0, 0);
  small.close();
  const { data } = ctx.getImageData(0, 0, 64, 36);
  return { rgb: accentOf(data), light: lightOf(data) };
}

/**
 * The focused game's colour, and its art's brightness for the plates over it (plate.css); without art, the screen
 * behind them is dark.
 * @param {{ rgb: number[], light: number } | undefined} look
 */
function applyAccent(look) {
  const root = document.documentElement.style;
  root.setProperty('--accent', (look?.rgb ?? [140, 170, 255]).join(' '));
  root.setProperty('--plate-light', String(look?.light ?? 0));
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
  const accent = state.accents.get(g.id);
  if (accent) applyAccent(accent);
  else {
    sampleAccent(url).then(
      (look) => {
        state.accents.set(g.id, look);
        if (focused()?.id === g.id) applyAccent(look);
      },
      () => {}
    );
  }
  // Shown once loaded, so the hero doesn't build up line by line.
  const img = new Image();
  img.onload = img.onerror = show;
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

/** The focused game's menu: its cover lifts, with the details and the choices beside it. */
export function openDetails() {
  const g = focused();
  els.dName.textContent = g.name;
  // Lamplit counts from 0.2.0 on, so a game played before has no time of its own, and the line leaves it out.
  const [store, played, time = ''] = metaParts(g, g.manual ? 'Added by hand' : storeName(g.store));
  els.dStore.replaceChildren(...withStoreLogo(g.store, store));
  els.dPlayed.textContent = played;
  els.dTime.textContent = time;
  els.dDir.replaceChildren(...folderParts(g.dir).map((part) => Object.assign(document.createElement('span'), { textContent: part })));
  state.detailsIdx = 0;
  renderChoices();
  readCloser(g.id);
  state.mode = 'details';
  showSheet('menu');
  lift(g.id, restingCover(), coverLook(g.name, g.art.portrait));
  layout();
  sfx.open();
  showHints();
}

/**
 * Lowers the menu's cover back into the row, or, `away`, lets it drop out of sight: its game is leaving the row.
 * Change art, over the menu, closes with it.
 * @param {boolean} [away]
 */
export function closeDetails(away = false) {
  state.mode = 'browse';
  state.art.open = false;
  state.typing = null;
  lower(away);
  sfx.back();
  showHints();
}

/** The menu again, as it was before Change art: its choices, and the cover with the game's own art. */
export function backToMenu() {
  const g = focused();
  state.art.open = false;
  state.typing = null;
  showSheet('menu');
  face(coverLook(g.name, g.art.portrait));
  renderChoices();
  showHints();
}

/** The choices of the focused game's menu. */
const choices = () => detailChoices(focused(), state.running, state.closer);

/**
 * The running game as the dock reads it: whether Lamplit knows which programs are its own, so the menu can offer
 * Close game, and whether it stopped responding. The menu shows the choice once the answer is in.
 * @param {string} id
 */
async function readCloser(id) {
  state.closer = null;
  if (state.running !== id) return;
  const read = await dockState().catch(() => null);
  if (state.mode !== 'details' || focused()?.id !== id) return;
  state.closer = read;
  renderChoices();
}

/**
 * The choices in the menu, each with its icon, the focused one marked: Play lit, Favourite's star filled when on.
 * One that can't be taken back says what it does, and has a ring that fills while Cross is held on it (hold.js); a
 * hold in progress is let go, as the rows it was on are made again.
 */
function renderChoices() {
  letGo();
  const g = focused();
  const rows = choices().map((c, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.classList.toggle('focus', i === state.detailsIdx);
    row.classList.toggle('primary', c.kind === 'play');
    if (c.kind === 'favourite') {
      row.classList.toggle('on', g.favourite);
      row.setAttribute('aria-pressed', String(g.favourite));
    }
    row.append(glyph(c.icon, !!c.hold), labelled(c.label, c.note));
    return row;
  });
  els.dChoices.replaceChildren(...rows);
}

/**
 * A row's icon, with the ring a hold fills round it.
 * @param {import('./icons.js').IconId} id @param {boolean} held
 */
export function glyph(id, held) {
  const box = document.createElement('span');
  box.className = 'glyph';
  const svg = icon(id);
  svg.setAttribute('class', 'icon');
  box.append(svg, ...(held ? [holdRing()] : []));
  return box;
}

/**
 * A row's label, and under it what it does when that can't be taken back.
 * @param {string} label @param {string} [note]
 */
export function labelled(label, note) {
  const box = document.createElement('span');
  box.className = 'label';
  box.append(label);
  if (note) box.append(Object.assign(document.createElement('span'), { className: 'note', textContent: note }));
  return box;
}

/** The choice ✕ picks in the menu. */
export const detailChoice = () => choices()[state.detailsIdx];

/** @param {number} delta */
export function moveDetails(delta) {
  const next = Math.max(0, Math.min(choices().length - 1, state.detailsIdx + delta));
  if (next === state.detailsIdx) return sfx.edge();
  state.detailsIdx = next;
  sfx.move();
  renderChoices();
  showHints();
}

/** Cross held on a choice that can't be taken back: it happens once the ring round its icon is full. */
export function holdChoice() {
  sfx.move();
  // Made again with focus on it, as a mouse may hold one that wasn't in focus.
  renderChoices();
  hold(/** @type {HTMLElement} */ (els.dChoices.children[state.detailsIdx]), markGame);
}

/**
 * The menu's choices other than Play and Change art: the focused game in or out of the favourites, hidden, closed
 * while it runs, or, for a game added by hand, removed. The last two come once Cross has been held (holdChoice).
 */
export async function markGame() {
  const g = focused();
  const { kind } = detailChoice();
  try {
    if (kind === 'close') {
      const closer = /** @type {import('./api.js').DockGame} */ (state.closer);
      sfx.launch();
      closeDetails();
      // Rust closes the game it read, in its session, and nothing else. Asked to close, the game may ask whether to
      // quit: it comes forward to ask. Ended, Lamplit stays in front.
      await dockCloseGame(closer.force_close, closer.id, closer.session);
      if (!closer.force_close) backToGame();
    } else if (kind === 'favourite') {
      sfx.open();
      // The row moves around the game, and focus stays on it.
      setGames(await librarySetFavourite(g.id, !g.favourite));
      renderChoices();
    } else {
      const at = state.idx;
      closeDetails(true);
      const list = await (kind === 'hide' ? librarySetHidden(g.id, true) : libraryRemoveGame(g.id));
      // The row stays live while Rust saves: a player who moved on keeps the game they moved to (setGames).
      const stayed = focused()?.id === g.id;
      setGames(list);
      if (stayed) {
        // Focus goes to the game that took its place.
        state.idx = Math.max(0, Math.min(at, state.games.length - 1));
        render();
      }
      toast(kind === 'hide' ? `${g.name} is hidden. Settings > Hidden games shows it again.` : `${g.name} is no longer in Lamplit.`);
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

/**
 * A cover's look: its portrait, or the game's name on colours of its own. The row and the lifted card both draw it.
 * @param {string} name @param {string | null} portrait
 * @returns {import('./lift.js').Look}
 */
export function coverLook(name, portrait) {
  const url = fileUrl(portrait);
  return { image: url ? `url("${url}")` : coverFallback(name), art: !!url, name };
}

/** @param {Shown} g */
export function paintCover(g) {
  const look = coverLook(g.name, g.art.portrait);
  g.el.style.backgroundImage = look.image;
  g.el.classList.toggle('has-art', look.art);
  g.el.classList.toggle('playing', state.running === g.id);
}

/** A cover's size in px, measured from the stylesheet (--cover-h) again whenever the window's height changes. */
let cover = { forHeight: 0, width: 0, height: 0 };
/** How much the focused cover grows. */
const GROW = 1.14;

/**
 * Covers sit side by side; the focused one grows and the row slides so it stays in the first slot. A lifted cover
 * hides in the row while its card stands in for it (lift.js).
 */
export function layout() {
  if (cover.forHeight !== innerHeight && state.games.length) {
    const look = getComputedStyle(state.games[0].el);
    cover = { forHeight: innerHeight, width: parseFloat(look.width), height: parseFloat(look.height) };
  }
  const w = cover.width, gap = innerHeight * 0.02;
  const i = state.idx;
  state.games.forEach((g, k) => {
    const x = k * (w + gap) + (k > i ? w * (GROW - 1) : 0);
    g.el.style.transform = `translate3d(${x}px, 0, 0) scale(${k === i ? GROW : 1})`;
    g.el.classList.toggle('focus', k === i);
    g.el.classList.toggle('lifted', g.id === state.lifted);
  });
  els.track.style.transform = `translate3d(${-i * (w + gap)}px, 0, 0)`;
  if (state.lifted && state.lifted !== focused()?.id) settle();
}

/** Where the focused cover rests once the row has slid: the first slot, grown, on the row's bottom edge. */
function restingCover() {
  const width = cover.width * GROW, height = cover.height * GROW;
  return { x: parseFloat(getComputedStyle(els.track).left), y: els.row.getBoundingClientRect().bottom - height, width, height };
}

export function render() {
  layout();
  showInfo();
}

/** @param {Game[]} list */
export function setGames(list) {
  const keep = focused()?.id;
  state.loaded = true;
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
  // The menu still names the game that is gone, and ✕ there would start whatever is focused now. It closes before the
  // row is drawn, which would show its hints for a game that isn't there.
  if (k < 0 && state.mode === 'details') closeDetails(true);
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
  if (words(query).length) parts.push(pill('query', icon('i-search'), query.trim()));
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
    // The end of the row: the cover bumps against it, and with Reduce Motion only the sound says so.
    if (!reduced()) {
      focused().el.animate([{ translate: '0 0' }, { translate: `${Math.sign(delta) * 1.2}vh 0` }, { translate: '0 0' }], {
        duration: 200,
        easing: 'ease-out',
      });
    }
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
  if (focused() !== g) return;
  showInfo();
  // Change art previews on the card what it would show, and puts the game's own art back when it closes.
  if (state.lifted === id && !state.art.open) face(coverLook(g.name, art.portrait));
}
