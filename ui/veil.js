// @ts-check
// The game menu's veil (lift.js): the home screen behind the lifted card, blurred and dimmed, drawn once as the menu
// opens. A backdrop-filter blurred the whole 4K screen again on every frame anything moved under or over it, the hero's
// drift among them; drawn once at an eighth of the screen and scaled up, as the dock draws its backdrop
// (dock/main.js paintBackdrop), it costs nothing while the menu is open, and opaque, it spares the compositor drawing
// the hero, the shade and the row under it. It shows what was behind the menu as it opened, and holds still.

import { els } from './state.js';

/** The copy's size against the screen's: blurred this much, an eighth loses nothing the eye could see. */
const SCALE = 1 / 8;
/** The veil's blur, in vh, and what dims it, as its backdrop-filter had them. */
const BLUR_VH = 2.6;
const DIM = 'rgb(6 5 12 / .5)';
/** The blur and colours of a hero drawn from a cover (style.css .hero.blurred). */
const HERO_BLUR_VH = 4;

/** Paints asked for: one asked before another, whose images came later, draws nothing. */
let paints = 0;

/** @type {Map<string, Promise<HTMLImageElement | null>>} images, each loaded and decoded once */
const images = new Map();
/** @param {string} url */
function load(url) {
  let image = images.get(url);
  if (!image) {
    const img = new Image();
    // The asset protocol sends the CORS header (library.js sampleAccent): drawn so, the canvas can be read back.
    img.crossOrigin = 'anonymous';
    img.src = url;
    image = img.decode().then(() => img, () => null);
    images.set(url, image);
  }
  return image;
}

/** @param {Element} el */
const urlOf = (el) => getComputedStyle(el).backgroundImage.match(/url\("(.+?)"\)/)?.[1] ?? null;

/**
 * Where an image `w` by `h` lands in `box` at `background-size: cover`, its position `x` and `y` from 0 to 1.
 * @param {DOMRect} box @param {number} w @param {number} h @param {number} x @param {number} y
 * @returns {[number, number, number, number]}
 */
function cover(box, w, h, x, y) {
  const s = Math.max(box.width / w, box.height / h);
  const [dw, dh] = [w * s, h * s];
  return [box.left + (box.width - dw) * x, box.top + (box.height - dh) * y, dw, dh];
}

/**
 * Draws what shows behind the menu now into `canvas`, small, blurred and dimmed, and marks it drawn, which fades it in
 * (style.css #lift .veil).
 * @param {HTMLCanvasElement} canvas
 */
export async function paintVeil(canvas) {
  const asked = ++paints;
  canvas.classList.remove('drawn');
  // Where everything is as the menu opens: the heroes with their drift and their fade, the logo, the covers in the row
  // but the one lifting.
  const heroes = [...document.querySelectorAll('.hero')].map((el) => ({
    url: urlOf(el),
    box: el.getBoundingClientRect(),
    alpha: Number(getComputedStyle(el).opacity),
    blurred: el.classList.contains('blurred'),
  }));
  const logo = els.logo.classList.contains('on') && els.logo.src ? { url: els.logo.src, box: els.logo.getBoundingClientRect() } : null;
  const covers = [...els.track.querySelectorAll('.cover:not(.focus)')]
    .map((el) => ({ el, box: el.getBoundingClientRect(), url: urlOf(el), alpha: Number(getComputedStyle(el).opacity), look: getComputedStyle(el).backgroundImage }))
    .filter((c) => c.box.right > 0 && c.box.left < innerWidth && c.alpha > 0);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const [vw, vh] = [innerWidth, innerHeight];
  const loaded = new Map(
    await Promise.all(
      [...heroes.map((h) => h.url), logo?.url, ...covers.map((c) => c.url)]
        .filter((url) => !!url)
        .map(async (url) => /** @type {[string, HTMLImageElement | null]} */ ([/** @type {string} */ (url), await load(/** @type {string} */ (url))]))
    )
  );
  if (asked !== paints) return;

  // The scene, with a margin all round, so the blur takes its edges from what lies past them rather than darkening.
  const blur = (BLUR_VH * vh) / 100 * SCALE;
  const margin = Math.ceil(blur * 3);
  const [w, h] = [Math.round(vw * SCALE), Math.round(vh * SCALE)];
  const scene = document.createElement('canvas');
  scene.width = w + 2 * margin;
  scene.height = h + 2 * margin;
  const ctx = /** @type {CanvasRenderingContext2D} */ (scene.getContext('2d'));
  ctx.setTransform(SCALE, 0, 0, SCALE, margin, margin);
  const edge = margin / SCALE;
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
  ctx.fillRect(-edge, -edge, vw + 2 * edge, vh + 2 * edge);
  for (const hero of heroes) {
    const img = hero.url && loaded.get(hero.url);
    if (!img || hero.alpha <= 0) continue;
    ctx.globalAlpha = hero.alpha;
    ctx.filter = hero.blurred ? `blur(${((HERO_BLUR_VH * vh) / 100) * SCALE}px) saturate(1.3) brightness(.8)` : 'none';
    ctx.drawImage(img, ...cover(hero.box, img.naturalWidth, img.naturalHeight, 0.5, 0.3));
  }
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  shade(ctx, vw, vh, edge, accent);
  const logoImg = logo && loaded.get(logo.url);
  if (logo && logoImg) {
    // object-fit: contain, against its left and bottom edges.
    const s = Math.min(logo.box.width / logoImg.naturalWidth, logo.box.height / logoImg.naturalHeight);
    const [dw, dh] = [logoImg.naturalWidth * s, logoImg.naturalHeight * s];
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
    if (img) ctx.drawImage(img, ...cover(c.box, img.naturalWidth, img.naturalHeight, 0.5, 0.5));
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
