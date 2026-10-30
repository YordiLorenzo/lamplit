// @ts-check
// The game menu's veil (lift.js): the home screen behind the lifted card, blurred and dimmed, drawn once as the menu
// opens. A backdrop-filter blurred the whole 4K screen again on every frame anything moved under or over it, the hero's
// drift among them; drawn once at an eighth of the screen and scaled up, as the dock draws its backdrop
// (dock/main.js paintBackdrop), it costs nothing while the menu is open, and opaque, it spares the compositor drawing
// the hero, the shade and the row under it. It shows what was behind the menu as it opened, and holds still.
//
// Once the menu has come to rest, the stage under the veil, the hero and its shade, is held still and swapped for a
// copy of itself in one opaque layer (index.html #stageCopy, #stage[data-stage]). Closing, the veil then fades out
// over that one layer rather than over the hero, the shade blended on it and the page's background under both: at
// 4K, from the GPU's idle clocks, those took the close's frames well past 8.3 ms. The live stage comes back as the
// card lands.

import { els } from './state.js';

/** The copy's size against the screen's: blurred this much, an eighth loses nothing the eye could see. */
const SCALE = 1 / 8;
/** The veil's blur, in vh, and what dims it, as its backdrop-filter had them. */
const BLUR_VH = 2.6;
const DIM = 'rgb(6 5 12 / .5)';
/** The blur and colours of a hero drawn from a cover (style.css .hero.blurred). */
const HERO_BLUR_VH = 4;
/** When the stage is copied: once the card, the menu and the sheen across the card have come to rest. */
const STAGE_AFTER_MS = 1500;

/** Paints asked for: one asked before another, whose images came later, draws nothing. */
let paints = 0;

/**
 * The images of the last paint and the last stage copy, each decoded once off the page's thread, at the size it is
 * drawn at: a 4K hero drawn full size into the small veil took the menu's first frame past 20 ms. Each paint lets go
 * of those the screen no longer shows, so a launcher left running for weeks doesn't keep the art of every game whose
 * menu was ever opened.
 * @type {Map<string, Promise<ImageBitmap | null>>}
 */
const bitmaps = new Map();

/**
 * The image at `url`, `width` wide (0: its own size), decoded and scaled off the page's thread.
 * @param {string} url @param {number} width
 */
function bitmap(url, width) {
  const key = `${width} ${url}`;
  let image = bitmaps.get(key);
  if (!image) {
    // The asset protocol sends the CORS header (library.js sampleAccent), so the canvas can be read back.
    image = fetch(url)
      .then((r) => r.blob())
      .then((blob) => createImageBitmap(blob, width ? { resizeWidth: width, resizeQuality: 'medium' } : {}))
      .catch(() => null);
    bitmaps.set(key, image);
  }
  return image;
}

/** Lets go of the images not in `keep`. @param {Set<string>} keep */
function forget(keep) {
  for (const [key, image] of bitmaps) {
    if (keep.has(key)) continue;
    bitmaps.delete(key);
    image.then((b) => b?.close());
  }
}

/** Resolves once the frame being made now has gone out: what comes after doesn't add to its work. */
const afterFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r)));

/** @param {Element} el */
const urlOf = (el) => getComputedStyle(el).backgroundImage.match(/url\("(.+?)"\)/)?.[1] ?? null;

/**
 * Where an image `w` by `h` lands in `box` at `background-size: cover`, its position `x` and `y` from 0 to 1.
 * @param {{ left: number, top: number, width: number, height: number }} box @param {number} w @param {number} h @param {number} x @param {number} y
 * @returns {[number, number, number, number]}
 */
function cover(box, w, h, x, y) {
  const s = Math.max(box.width / w, box.height / h);
  const [dw, dh] = [w * s, h * s];
  return [box.left + (box.width - dw) * x, box.top + (box.height - dh) * y, dw, dh];
}

/**
 * `box` on screen, in a canvas's pixels: scaled by `k` and moved by `d`.
 * @param {DOMRect} box @param {number} k @param {number} d
 */
const scaled = (box, k, d) => ({ left: box.left * k + d, top: box.top * k + d, width: box.width * k, height: box.height * k });

/** The heroes as they show now: their art, their place with the drift, their fade. */
const heroesNow = () =>
  [...document.querySelectorAll('.hero')].map((el) => ({
    url: urlOf(el),
    box: el.getBoundingClientRect(),
    alpha: Number(getComputedStyle(el).opacity),
    blurred: el.classList.contains('blurred'),
  }));

/**
 * Draws the heroes into `ctx`, in its pixels, `k` of a CSS pixel each and moved by `d`; the drawing's transform is
 * left alone, so a blur is in the canvas's own pixels.
 * @param {CanvasRenderingContext2D} ctx @param {ReturnType<typeof heroesNow>} heroes
 * @param {Map<string, ImageBitmap | null>} loaded @param {number} k @param {number} d @param {number} vh
 */
function drawHeroes(ctx, heroes, loaded, k, d, vh) {
  for (const hero of heroes) {
    const img = hero.url && loaded.get(hero.url);
    if (!img || hero.alpha <= 0) continue;
    ctx.globalAlpha = hero.alpha;
    ctx.filter = hero.blurred ? `blur(${((HERO_BLUR_VH * vh) / 100) * k}px) saturate(1.3) brightness(.8)` : 'none';
    ctx.drawImage(img, ...cover(scaled(hero.box, k, d), img.width, img.height, 0.5, 0.3));
  }
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
}

/**
 * Draws what shows behind the menu now into `canvas`, small, blurred and dimmed, and marks it drawn, which fades it in
 * (style.css #lift .veil). Where everything is comes from the press; the drawing waits until the press's frame has gone
 * out, so the lift's first frame has only its own work.
 * @param {HTMLCanvasElement} canvas
 */
export async function paintVeil(canvas) {
  const asked = ++paints;
  canvas.classList.remove('drawn');
  // Where everything is as the menu opens: the heroes with their drift and their fade, the logo, the covers in the row
  // but the one lifting.
  const heroes = heroesNow();
  const logo = els.logo.classList.contains('on') && els.logo.src ? { url: els.logo.src, box: els.logo.getBoundingClientRect() } : null;
  const covers = [...els.track.querySelectorAll('.cover:not(.focus)')]
    .map((el) => ({ el, box: el.getBoundingClientRect(), url: urlOf(el), alpha: Number(getComputedStyle(el).opacity), look: getComputedStyle(el).backgroundImage }))
    .filter((c) => c.box.right > 0 && c.box.left < innerWidth && c.alpha > 0);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const [vw, vh] = [innerWidth, innerHeight];
  // Each image at about twice the size it is drawn at here, in steps, so the next open finds it again: a hero by the
  // screen's width, which its box passes by at most a quarter as it drifts.
  /** @param {number} width */
  const size = (width) => Math.ceil((width * SCALE * 2) / 32) * 32;
  /** @type {[string, number][]} */
  const wanted = [];
  for (const { url } of heroes) if (url) wanted.push([url, size(vw * 1.25)]);
  for (const { url, box } of [...(logo ? [logo] : []), ...covers]) if (url) wanted.push([url, size(box.width)]);
  forget(new Set(wanted.map(([url, width]) => `${width} ${url}`)));
  const loaded = new Map(await Promise.all(wanted.map(async ([url, width]) => /** @type {[string, ImageBitmap | null]} */ ([url, await bitmap(url, width)]))));
  await afterFrame();
  if (asked !== paints) return;

  // The scene, with a margin all round, so the blur takes its edges from what lies past them rather than darkening.
  const blur = (BLUR_VH * vh) / 100 * SCALE;
  const margin = Math.ceil(blur * 3);
  const [w, h] = [Math.round(vw * SCALE), Math.round(vh * SCALE)];
  const scene = document.createElement('canvas');
  scene.width = w + 2 * margin;
  scene.height = h + 2 * margin;
  const ctx = /** @type {CanvasRenderingContext2D} */ (scene.getContext('2d'));
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
  ctx.fillRect(0, 0, scene.width, scene.height);
  drawHeroes(ctx, heroes, loaded, SCALE, margin, vh);
  ctx.setTransform(SCALE, 0, 0, SCALE, margin, margin);
  const edge = margin / SCALE;
  shade(ctx, vw, vh, edge, accent);
  const logoImg = logo && loaded.get(logo.url);
  if (logo && logoImg) {
    // object-fit: contain, against its left and bottom edges.
    const s = Math.min(logo.box.width / logoImg.width, logo.box.height / logoImg.height);
    const [dw, dh] = [logoImg.width * s, logoImg.height * s];
    ctx.drawImage(logoImg, logo.box.left, logo.box.bottom - dh, dw, dh);
  }
  const round = (1.3 * vh) / 100;
  for (const c of covers) {
    ctx.save();
    ctx.globalAlpha = c.alpha;
    ctx.beginPath();
    ctx.roundRect(c.box.left, c.box.top, c.box.width, c.box.height, round);
    ctx.clip();
    const img = c.url && loaded.get(c.url);
    if (img) ctx.drawImage(img, ...cover(c.box, img.width, img.height, 0.5, 0.5));
    else {
      // A cover without art: its two colours, from its top left to its bottom right.
      const [from = '#1c1a26', to = from] = c.look.match(/rgba?\([^)]*\)/g) ?? [];
      const fill = ctx.createLinearGradient(c.box.left, c.box.top, c.box.right, c.box.bottom);
      fill.addColorStop(0, from);
      fill.addColorStop(1, to);
      ctx.fillStyle = fill;
      ctx.fillRect(c.box.left, c.box.top, c.box.width, c.box.height);
    }
    ctx.restore();
  }

  // Blurred and coloured as the backdrop-filter did, then dimmed.
  canvas.width = w;
  canvas.height = h;
  const out = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  out.filter = `blur(${blur}px) saturate(1.3) brightness(.82)`;
  out.drawImage(scene, -margin, -margin);
  out.filter = 'none';
  out.fillStyle = DIM;
  out.fillRect(0, 0, w, h);
  canvas.classList.add('drawn');
  clearTimeout(stageTimer);
  stageTimer = setTimeout(() => holdStage(asked), STAGE_AFTER_MS);
}

let stageTimer = 0;
/** Stage copies asked for: a release, or a newer copy, drops one still being made. */
let stages = 0;

/**
 * Under the veil, once the menu has come to rest: the hero's drift holds, and the hero and its shade are drawn as they
 * show into one opaque copy at the screen's full resolution, which takes their place (style.css body.staged). Asked
 * for by paint `asked`, and dropped when the menu closed, opened again, or the stage was released meanwhile.
 * @param {number} asked
 */
async function holdStage(asked) {
  const mine = ++stages;
  const open = () => mine === stages && asked === paints && els.lift.classList.contains('on');
  if (!open()) return;
  els.stage.dataset.stage = 'held';
  const heroes = heroesNow();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const [vw, vh, k] = [innerWidth, innerHeight, devicePixelRatio];
  const urls = /** @type {string[]} */ (heroes.map((h) => h.url).filter((url) => !!url));
  const loaded = new Map(await Promise.all(urls.map(async (url) => /** @type {[string, ImageBitmap | null]} */ ([url, await bitmap(url, 0)]))));
  if (!open()) {
    // Not released yet (the menu closed, or a new paint came): the drift goes on.
    if (mine === stages) releaseStage();
    return;
  }
  const copy = els.stageCopy;
  copy.width = Math.round(vw * k);
  copy.height = Math.round(vh * k);
  const ctx = /** @type {CanvasRenderingContext2D} */ (copy.getContext('2d', { alpha: false }));
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
  ctx.fillRect(0, 0, copy.width, copy.height);
  drawHeroes(ctx, heroes, loaded, k, 0, vh);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  shade(ctx, vw, vh, 0, accent);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Shown in the next frame with the live stage hidden, both at once.
  requestAnimationFrame(() => {
    if (open()) els.stage.dataset.stage = 'staged';
  });
}

/** The live stage again, the drift going on from where it held, as the card lands (lift.js land). */
export function releaseStage() {
  stages++;
  clearTimeout(stageTimer);
  delete els.stage.dataset.stage;
  els.stageCopy.width = els.stageCopy.height = 0;
  // The heroes at their full size, decoded for the copy, go with it.
  forget(new Set([...bitmaps.keys()].filter((key) => !key.startsWith('0 '))));
}

// A copy made for another size of screen would show wrong as the menu closes.
addEventListener('resize', () => els.stage.dataset.stage && releaseStage());

/**
 * The hero or its colour changed under the open menu (Change art): the copy, which shows the old ones, goes, and a
 * new one is made once the change has played (a hero fades in over 700 ms).
 */
export function stageChanged() {
  if (!els.lift.classList.contains('on')) return;
  releaseStage();
  const asked = paints;
  stageTimer = setTimeout(() => holdStage(asked), STAGE_AFTER_MS);
}

/**
 * The shade over the hero (style.css .shade): dark from the left and from the bottom, and the game's colour low on
 * the right, drawn past the screen's edges by `edge`.
 * @param {CanvasRenderingContext2D} ctx @param {number} vw @param {number} vh @param {number} edge @param {string} accent
 */
function shade(ctx, vw, vh, edge, accent) {
  const area = /** @type {const} */ ([-edge, -edge, vw + 2 * edge, vh + 2 * edge]);
  // radial-gradient(ellipse 70% 50% at 70% 100%, accent / .16, transparent 70%): an ellipse is a circle scaled.
  const [rx, ry] = [vw * 0.7, vh * 0.5];
  ctx.save();
  ctx.translate(vw * 0.7, vh);
  ctx.scale(1, ry / rx);
  const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  glow.addColorStop(0, `rgb(${accent} / .16)`);
  glow.addColorStop(0.7, `rgb(${accent} / 0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(-rx * 2, -rx * 2, rx * 4, rx * 4);
  ctx.restore();
  // linear-gradient(0deg, ...): from the bottom up.
  const up = ctx.createLinearGradient(0, vh, 0, 0);
  up.addColorStop(0, 'rgb(5 5 10 / .96)');
  up.addColorStop(0.32, 'rgb(5 5 10 / .62)');
  up.addColorStop(0.62, 'rgb(5 5 10 / 0)');
  ctx.fillStyle = up;
  ctx.fillRect(...area);
  // linear-gradient(90deg, ...): from the left.
  const right = ctx.createLinearGradient(0, 0, vw, 0);
  right.addColorStop(0, 'rgb(5 5 10 / .80)');
  right.addColorStop(0.42, 'rgb(5 5 10 / .38)');
  right.addColorStop(0.68, 'rgb(5 5 10 / 0)');
  ctx.fillStyle = right;
  ctx.fillRect(...area);
}
