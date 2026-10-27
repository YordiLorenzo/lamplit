// @ts-check
// The screensaver in a normal browser, without Lamplit: every scene, coloured from the covers in the README's
// screenshot of the home screen (docs/images/home.jpg), from Lamplit's own colours and from a grey palette, or from
// an image dropped on the page. Gallery shows those covers, and Drift the hero art behind two of the README's
// screenshots. Serve the repository's folder (python3 -m http.server 8123) and open /ui/screensaver/preview.html.
// The address can pick what shows: ?scene=dunes&look=2&at=40&hud=0 (at: seconds into the scene), and cap=0 draws as
// fast as the GPU can, so the frame rate in the corner says what a scene costs.

import { LAMPLIT, medianCut, paletteOf, scenePalette } from './palette.js';
import { Saver, pixelsOf } from './saver.js';
import { SCENES } from './scenes.js';

/** @typedef {import('./saver.js').Look} Look */

/** The covers along the row in home.jpg, left to right (tests/screenshots.mjs made it, with this order). */
const COVERS = ['Cyberpunk 2077', 'Titanfall 2', 'Red Dead Redemption 2', 'EA SPORTS FC 26', 'Far Cry 6', 'Cities: Skylines II', 'skate.'];

/**
 * Where cover `k` sits in home.jpg at 1920 × 1080, from the stylesheet: covers 30vh tall and 2:3, 2vh apart, 5vw from
 * the left, 12vh from the bottom, and the first one focused, 1.14 times as large.
 * @param {number} k @returns {[number, number, number, number]}
 */
function coverBox(k) {
  const [h, w, gap, left, bottom] = [324, 216, 21.6, 96, 950.4];
  if (k === 0) return [left, bottom - h * 1.14, w * 1.14, h * 1.14];
  return [left + w * 0.14 + k * (w + gap), bottom - h, w, h];
}

/** @param {string} src */
async function image(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/** Part of an image, cut out at its own resolution. @param {number[]} box  x, y, width, height @param {HTMLImageElement} img */
function cut(box, img) {
  const [x, y, w, h] = box;
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(w), height: Math.round(h) });
  /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}

/**
 * One look per cover in the screenshot, with the cover itself for Gallery, and for the first two games the hero art
 * behind the home screen and the starting screen (the right part, clear of the text and the clock) for Drift. None when the
 * screenshots can't be loaded.
 * @returns {Promise<Look[]>}
 */
async function coverLooks() {
  try {
    const [home, launch] = await Promise.all([image('../../docs/images/home.jpg'), image('../../docs/images/launch.jpg')]);
    const scale = home.naturalWidth / 1920;
    const heroes = [home, launch].map((img) => cut([760, 95, 1160, 470].map((v) => v * scale), img));
    return COVERS.map((name, k) => {
      const [x, y, w, h] = coverBox(k).map((v) => v * scale);
      // A little in from the edges: the focus ring and the rounded corners aren't the game's colours.
      const crop = [x + w * 0.04, y + h * 0.03, w * 0.92, h * 0.94];
      const inner = /** @type {[number, number, number, number]} */ ([x + w * 0.08, y + h * 0.06, w * 0.84, h * 0.88]);
      return { name, palette: scenePalette(medianCut(pixelsOf(home, 24, 36, inner), 8)), cover: cut(crop, home), hero: heroes[k] ?? null };
    });
  } catch {
    return [];
  }
}

const hud = /** @type {HTMLElement} */ (document.getElementById('hud'));
const now = /** @type {HTMLElement} */ (document.getElementById('now'));
const params = new URLSearchParams(location.search);

document.getElementById('served')?.remove();
const saver = new Saver(/** @type {HTMLElement} */ (document.getElementById('saver')));
/** @type {Look[]} */
const looks = [
  ...(await coverLooks()),
  { name: 'Lamplit', palette: LAMPLIT },
  // A game whose art is grey all over, the hardest palette to make something of.
  { name: 'Grey', palette: paletteOf([[118, 118, 120], [160, 158, 154], [70, 71, 74], [205, 205, 200]]) },
];
let look = Math.min(looks.length - 1, Number(params.get('look') ?? 0));
let scene = Math.max(0, SCENES.findIndex((s) => s.id === params.get('scene')));
saver.setLooks(looks.slice(look).concat(looks.slice(0, look)));
saver.start(SCENES[scene]);
saver.cut(SCENES[scene], looks[look]);
const at = Number(params.get('at') ?? 0);
if (at > 0) saver.clock = at;
hud.hidden = params.get('hud') === '0';
if (params.get('cap') === '0') saver.frameMs = 0;
// For scripts that drive the preview, such as the screenshots in a pull request.
Object.assign(window, { preview: { saver, looks } });

/** Shows the scene and look picked by the keys. */
function show() {
  saver.cut(SCENES[scene], looks[look]);
}

const SPEEDS = [1, 4, 16];
/** How the next scene comes in (renderer.js WAYS), in the order T steps through them; the last lets the show pick. */
const WAYS = ['crossfade', 'through the darks', 'through flowing noise', 'pushing in', 'any way'];
let way = WAYS.length - 1;

window.addEventListener('keydown', (e) => {
  const n = Number(e.key);
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    scene = (scene + (e.key === 'ArrowRight' ? 1 : SCENES.length - 1)) % SCENES.length;
    show();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    look = (look + (e.key === 'ArrowDown' ? 1 : looks.length - 1)) % looks.length;
    show();
  } else if (n >= 1 && n <= SCENES.length) {
    scene = n - 1;
    show();
  } else if (e.key === 'b') {
    scene = (scene + 1) % SCENES.length;
    saver.skip(SCENES[scene]);
  } else if (e.key === 't') {
    way = (way + 1) % WAYS.length;
    saver.wayHeld = way < WAYS.length - 1 ? way : null;
  } else if (e.key === ' ') {
    saver.paused = !saver.paused;
  } else if (e.key === 's') {
    saver.speed = SPEEDS[(SPEEDS.indexOf(saver.speed) + 1) % SPEEDS.length];
  } else if (e.key === 'f') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  } else if (e.key === 'h') {
    hud.hidden = !hud.hidden;
  } else return;
  e.preventDefault();
});

// An image dropped on the page becomes one more look, shown at once.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (!file?.type.startsWith('image/')) return;
  const bitmap = await createImageBitmap(file);
  const palette = scenePalette(medianCut(pixelsOf(bitmap, 48, 27), 8));
  looks.push({ name: file.name.replace(/\.[^.]+$/, ''), palette, cover: bitmap, hero: bitmap });
  look = looks.length - 1;
  saver.setLooks(looks.slice(look).concat(looks.slice(0, look)));
  show();
});

setInterval(() => {
  const i = saver.info();
  // A blend picks up the scene it hands over to, so the keys go on from there.
  scene = Math.max(0, SCENES.findIndex((s) => s.name === i.scene));
  const speed = saver.speed > 1 ? ` · ${saver.speed}× speed` : '';
  const paused = saver.paused ? ' · paused' : '';
  const gl = i.mode === 'webgl' ? `${i.size} (${Math.round((i.scale ?? 0) * 100)}%)` : 'CSS gradient, no WebGL2';
  now.textContent = `${scene + 1}. ${i.scene} (${i.kind.toUpperCase()}) · ${i.look} · ${i.fps} fps · ${gl} · next comes in ${WAYS[way]}${speed}${paused}`;
}, 250);
