// @ts-check
// The screensaver on screen: its scenes in turn, each coloured from one game and handing over to the next, and that
// game's logo or name drifting faintly through it. Gallery and Drift show the games' covers and hero images
// themselves. Without WebGL2 it shows a CSS gradient that moves the same way. Lamplit (index.js) and the preview
// (preview.js) both drive this.

import { steady } from '../steady.js';
import { LAMPLIT } from './palette.js';
import { Renderer, WAYS } from './renderer.js';
import { nextOrder, scenesFor, showsMark } from './scenes.js';

/**
 * @typedef {import('./palette.js').Palette} Palette
 * @typedef {import('./scenes.js').Scene} Scene
 * @typedef {import('./scenes.js').Art} Art
 */

/**
 * One game's part in the show: the palette from its art, its logo (a URL) or name, and its cover and hero image (a
 * URL, or an image the preview has already cut out).
 * @typedef {object} Look
 * @property {Palette} palette
 * @property {string} [name]
 * @property {string | null} [logo]
 * @property {string | TexImageSource | null} [cover]
 * @property {string | TexImageSource | null} [hero]
 */

/** At most 30 frames a second: the scenes move slowly, and a TV at 120 Hz would otherwise draw four times as often. */
const FRAME_MS = 1000 / 30;
/**
 * Before it fades in, the screensaver draws unseen until its frames have come on time for FADE_SPAN_MS, or for
 * FADE_WAIT_MS at the latest (shown). A GPU that sat idle for a couple of seconds has dropped to its idle clocks, and
 * takes about 0.45 s of that work to come back up; until then a frame at 4K costs it up to 265 ms.
 */
const FADE_SPAN_MS = 450;
const FADE_WAIT_MS = 750;
/** A scene lasts this long, in seconds, give or take a third of SCENE_SPREAD. */
const SCENE_S = 95;
const SCENE_SPREAD = 30;
/** The blend from one scene to the next. */
const BLEND_S = 7;
/** The scenes render at this part of the canvas's size, less on a GPU that can't keep up (adapt). */
const START_SCALE = 0.6;
const MIN_SCALE = 0.34;
/** This many refreshes of the screen missed within about half a second step the scale down (adapt). */
const MISSES = 4;
/** The canvas itself stops at about 1440p: the grain is all it adds above that. */
const MAX_PIXELS = 2560 * 1440;
/** After an hour nobody is watching: the art fades to black over FADE_OUT_S and stops drawing. */
export const RUN_LIMIT_S = 3600;
const FADE_OUT_S = 30;
/** The logo or name: how long it takes to appear and to go, and how strong it gets. */
const MARK_IN_S = 10;
const MARK_PEAK = 0.4;
/** Gallery's covers, side by side in one image: up to this many, at this size each (2:3, as covers are). */
const COVERS = { most: 8, cols: 4, width: 384, height: 576 };
/** Drift's hero images: up to this many, scaled to this width (Steam's are 3840 pixels wide). */
const HEROES = { most: 4, width: 1600 };

/** @type {Worker | null} the worker that scales art (scale.js), started on the first file */
let scaler = null;
/** @type {Map<number, (bitmap: ImageBitmap | null) => void>} the files sent to it, by the number they went with */
const scaling = new Map();
let sent = 0;

/**
 * An art file (a URL from Lamplit's asset protocol, which sends the CORS header) decoded and scaled to `size` in a
 * worker, or null when it can't be: an image drawn into a canvas is decoded on the page's main thread, for 100 ms and
 * more per hero image at 4x CPU. An image the preview has cut out already is used as it is.
 * @param {string | TexImageSource | null | undefined} src
 * @param {{ resizeWidth?: number, resizeHeight?: number }} size  one side keeps the image's shape
 * @returns {Promise<TexImageSource | null>}
 */
export function scaledArt(src, size) {
  if (typeof src !== 'string') return Promise.resolve(src ?? null);
  if (!scaler) {
    const worker = (scaler = new Worker(new URL('./scale.js', import.meta.url)));
    worker.onmessage = ({ data: { id, bitmap } }) => {
      scaling.get(id)?.(bitmap);
      scaling.delete(id);
    };
    // A worker that can't start would leave the show waiting for its colours: the files go without, and the next one
    // tries a new worker.
    worker.onerror = () => {
      if (scaler === worker) scaler = null;
      for (const answer of scaling.values()) answer(null);
      scaling.clear();
    };
  }
  const id = sent++;
  scaler.postMessage({ id, url: src, size });
  return new Promise((resolve) => scaling.set(id, resolve));
}

/**
 * The games' art as a show has it: the covers in one atlas, and the hero images, each with the look it is from.
 * @typedef {{ atlas: Art['atlas'], heroes: { source: TexImageSource, look: number }[] }} ShowArt
 */

/** @type {ShowArt} */
const NO_ART = { atlas: null, heroes: [] };

/**
 * The art made last, kept between shows: the covers and hero images it is made from, and the art once it is there.
 * @type {{ from: unknown[], art: Promise<ShowArt>, ready: ShowArt | null }}
 */
let made = { from: [], art: Promise.resolve(NO_ART), ready: NO_ART };

/**
 * Gallery's atlas and Drift's hero images for `looks`, made once for the same art. Lamplit asks ahead, in idle time
 * (index.js), so a show starts with them, and with their textures from the show before.
 * @param {Look[]} looks
 */
export function artOf(looks) {
  const from = looks.flatMap((l) => [l.cover, l.hero]);
  if (from.length !== made.from.length || from.some((src, i) => src !== made.from[i])) {
    const entry = { from, art: makeArt(looks), ready: /** @type {ShowArt | null} */ (null) };
    entry.art.then((art) => (entry.ready = art));
    made = entry;
  }
  return made;
}

/**
 * The covers into one atlas, and the first HEROES.most hero images that load. Art that doesn't load is left out.
 * @param {Look[]} looks
 * @returns {Promise<ShowArt>}
 */
async function makeArt(looks) {
  const covers = await Promise.all(looks.slice(0, COVERS.most).map((l) => scaledArt(l.cover, { resizeHeight: COVERS.height })));
  /** @type {ShowArt['heroes']} */
  const heroes = [];
  for (let look = 0; look < looks.length && heroes.length < HEROES.most; look++) {
    const source = await scaledArt(looks[look].hero, { resizeWidth: HEROES.width });
    if (source) heroes.push({ source, look });
  }
  return { atlas: atlasOf(/** @type {TexImageSource[]} */ (covers.filter(Boolean))), heroes };
}

/** The covers side by side, each filling its cell and cropped to 2:3. @param {TexImageSource[]} covers */
function atlasOf(covers) {
  if (!covers.length) return null;
  const cols = Math.min(COVERS.cols, covers.length);
  const rows = Math.ceil(covers.length / cols);
  const canvas = Object.assign(document.createElement('canvas'), { width: cols * COVERS.width, height: rows * COVERS.height });
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  covers.forEach((img, i) => {
    const { width, height } = /** @type {{ width: number, height: number }} */ (img);
    const scale = Math.max(COVERS.width / width, COVERS.height / height);
    const [w, h] = [width * scale, height * scale];
    const [left, top] = [(i % cols) * COVERS.width, Math.floor(i / cols) * COVERS.height];
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, COVERS.width, COVERS.height);
    ctx.clip();
    ctx.drawImage(/** @type {CanvasImageSource} */ (img), left + (COVERS.width - w) / 2, top + (COVERS.height - h) / 2, w, h);
    ctx.restore();
  });
  return { source: canvas, count: covers.length, cols, rows };
}

/**
 * An image, or part of one, drawn `width` × `height` and read back as RGBA bytes for palette.js. The image must be
 * same-origin or carry a CORS header, or the canvas refuses to be read.
 * @param {CanvasImageSource} img
 * @param {number} width @param {number} height
 * @param {[number, number, number, number]} [crop]  x, y, width and height in the image
 */
export function pixelsOf(img, width, height, crop) {
  const canvas = Object.assign(document.createElement('canvas'), { width, height });
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  if (crop) ctx.drawImage(img, ...crop, 0, 0, width, height);
  else ctx.drawImage(img, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

/** @param {number} x */
const smooth = (x) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * A scene on screen, or on its way.
 * @typedef {object} Showing
 * @property {Scene} scene
 * @property {Look} look
 * @property {number} lookIndex
 * @property {number} seed
 * @property {number} start  show time at which the scene's own time is 0
 * @property {number} length  seconds before it hands over
 * @property {{ x: number, y: number, dx: number, dy: number }} path  where its mark drifts, in parts of the screen
 * @property {Art} art  the art it draws with
 */

export class Saver {
  /**
   * @param {HTMLElement} root  an empty element that covers the screen
   * @param {{ keepGoing?: () => boolean, onEnd?: () => void }} [hooks]  checked every frame; the show ends, and
   *   onEnd runs, once keepGoing says no
   */
  constructor(root, hooks = {}) {
    this.root = root;
    this.hooks = hooks;
    root.classList.add('saver');
    this.canvas = document.createElement('canvas');
    this.css = document.createElement('div');
    this.css.className = 'saver-css';
    this.css.append(...[0, 1, 2, 3].map(() => document.createElement('i')));
    this.mark = document.createElement('div');
    this.mark.className = 'saver-mark';
    this.logo = document.createElement('img');
    this.logo.alt = '';
    this.name = document.createElement('span');
    this.mark.append(this.logo, this.name);
    root.append(this.canvas, this.css, this.mark);

    /** @type {Renderer | null} */
    this.renderer = null;
    this.tried = false;
    /** @type {Look[]} */
    this.looks = [{ palette: LAMPLIT }];
    this.lookAt = 0;
    /** @type {Scene[]} scenes still to come before the order is shuffled again */
    this.queue = [];
    /** @type {Showing | null} */
    this.current = null;
    /** @type {Showing | null} */
    this.next = null;
    this.running = false;
    this.raf = 0;
    this.last = 0;
    /** Seconds of show: what the scenes' time and the fades run on. */
    this.clock = 0;
    /** How fast the show runs; the preview speeds it up. */
    this.speed = 1;
    this.paused = false;
    /** The shortest time between frames; the preview sets 0 to measure how fast a scene can draw. */
    this.frameMs = FRAME_MS;
    this.scale = START_SCALE;
    /** The last animation frame's time, the screen's refresh as the frames show it, and refreshes missed lately (adapt). */
    this.tick = 0;
    this.refresh = 1000 / 60;
    this.missed = 0;
    this.fps = 0;
    /** Whether a frame is on the canvas yet, so the screensaver can fade in over the home screen. */
    this.drawn = false;
    /** Why the CSS gradient shows instead of WebGL, for the log. */
    this.reason = '';
    /** @type {(() => void) | null} the next scene's mark, put up once the current one has faded */
    this.pendingMark = null;
    /** The mark is at opacity 0. */
    this.markHidden = false;
    this.releaseTimer = 0;
    /** The games' art, once it is there. */
    this.art = NO_ART;
    /** How the scene on its way comes in (renderer.js WAYS); the preview can hold one. */
    this.way = 0;
    /** @type {number | null} */
    this.wayHeld = null;
    /** @type {Scene | null} the scene the next show opens with, once prime() has picked it */
    this.opening = null;
    /** prime() has drawn its hidden frame. */
    this.primed = false;
    /** How many shows have started, so a fade-in still waiting knows whether its show is still on (shown). */
    this.starts = 0;
    this.frame = this.frame.bind(this);
    this.resize = this.resize.bind(this);
  }

  /** WebGL2, once; null when the page has none or a scene fails, and the CSS gradient shows instead. */
  gl() {
    if (!this.tried) {
      this.tried = true;
      try {
        this.renderer = new Renderer(this.canvas);
        this.canvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          this.fallBack('the GPU took the WebGL context away');
        });
      } catch (e) {
        this.fallBack(e.message);
      }
    }
    return this.renderer;
  }

  /** @param {string} why */
  fallBack(why) {
    this.renderer = null;
    this.tried = true;
    this.root.dataset.mode = 'css';
    this.reason = why;
    if (this.current) this.paintCss(this.current.look);
  }

  /** @param {Look[]} looks */
  setLooks(looks) {
    this.looks = looks.length ? looks : [{ palette: LAMPLIT }];
    this.lookAt = 0;
    const art = artOf(this.looks);
    this.useArt(art.ready ?? NO_ART);
    // Art still on its way joins the show once it is there.
    if (!art.ready) art.art.then((ready) => made === art && this.useArt(ready));
  }

  /** The art the show draws with from now on; the textures of the art before go. @param {ShowArt} art */
  useArt(art) {
    if (art === this.art) return;
    this.renderer?.dropArt();
    this.art = art;
    // The order so far was shuffled without it, and an opening scene picked for other art may need what this lacks.
    this.queue = [];
    if (this.opening?.needs) this.opening = null;
    for (const s of [this.current, this.next]) if (s) s.art = this.artFor(s.lookIndex);
  }

  /** The art a showing draws with: its own game's hero image first. @param {number} lookIndex @returns {Art} */
  artFor(lookIndex) {
    const { atlas, heroes } = this.art;
    const first = Math.max(0, heroes.findIndex((h) => h.look === lookIndex));
    return { atlas, heroes: [...heroes.slice(first), ...heroes.slice(0, first)].map((h) => h.source) };
  }

  /** The next scene in a shuffled order of those the art can show, never the one showing now. */
  pickScene() {
    if (!this.queue.length) {
      const have = { covers: !!this.art.atlas, heroes: this.art.heroes.length };
      this.queue = nextOrder(scenesFor(have), this.current?.scene);
    }
    return /** @type {Scene} */ (this.queue.shift());
  }

  /**
   * @param {Scene} scene @param {number} start
   * @param {number} [lookIndex]  whose look it takes; the next in turn when not given
   * @returns {Showing}
   */
  showing(scene, start, lookIndex = this.lookAt++ % this.looks.length) {
    const angle = Math.random() * Math.PI * 2;
    return {
      scene,
      look: this.looks[lookIndex],
      lookIndex,
      seed: Math.random(),
      start,
      length: SCENE_S + (Math.random() - 0.5) * SCENE_SPREAD,
      path: { x: 0.08 + Math.random() * 0.5, y: 0.14 + Math.random() * 0.6, dx: Math.cos(angle) * 0.0022, dy: Math.sin(angle) * 0.0012 },
      art: this.artFor(lookIndex),
    };
  }

  /** Starts the show, on `scene` if given. @param {Scene} [scene] */
  start(scene) {
    if (this.running) return;
    this.starts++;
    clearTimeout(this.releaseTimer);
    const gl = this.gl();
    this.root.dataset.mode = gl ? 'webgl' : 'css';
    this.clock = 0;
    this.next = null;
    this.current = this.showing(scene ?? this.opening ?? this.pickScene(), 0);
    this.opening = null;
    this.mark.style.opacity = '0';
    this.pendingMark = null;
    this.paintMark(this.current);
    if (!gl) this.paintCss(this.current.look);
    // Each show starts at the full scale: a GPU that had to draw lower last time may be up to speed now.
    this.scale = START_SCALE;
    this.tick = 0;
    this.refresh = 1000 / 60;
    this.missed = 0;
    this.resize();
    window.addEventListener('resize', this.resize);
    this.running = true;
    this.last = performance.now();
    this.drawn = false;
    this.raf = requestAnimationFrame(this.frame);
  }

  /**
   * Stops drawing at once and fades out. The scene buffers are freed once the fade is over, so the last frame stays
   * on the canvas while it fades.
   */
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.root.classList.remove('on', 'waiting');
    delete this.root.dataset.state;
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.renderer?.release(), 1000);
  }

  /**
   * Draws one frame of the scene the next show opens with, unseen, once per renderer: a renderer's first frame costs
   * the GPU 90 ms and more (the driver compiles the shaders for their first draw, and the buffers are new), which
   * would otherwise stall the show's first frames. The buffers go again straight after, so nothing large stays on the
   * GPU while Lamplit waits; later shows start as fast without them. Lamplit calls it ahead, in idle time (index.js).
   */
  prime() {
    const r = this.renderer;
    if (!r || this.primed || this.running || (this.hooks.keepGoing && !this.hooks.keepGoing())) return;
    try {
      this.opening ??= this.pickScene();
      // The scene compiles on the driver's threads; it is drawn once it has.
      if (!r.canDraw(this.opening)) {
        setTimeout(() => this.prime(), 100);
        return;
      }
      // Never where it could be seen, as while the last show fades out; the next warm-up tries again.
      if (getComputedStyle(this.root).visibility !== 'hidden') return;
      this.resize();
      r.drawScene(0, this.showing(this.opening, 0, 0), 0);
      r.present(0, 0, 1, 0);
      r.release();
      this.primed = true;
    } catch (e) {
      this.fallBack(e.message);
    }
  }

  /** Shows `scene` in `look` at once, without a blend: the preview's keys. @param {Scene} scene @param {Look} look */
  cut(scene, look) {
    if (!this.current) return;
    this.next = null;
    this.current = { ...this.showing(scene, this.clock), look };
    this.pendingMark = null;
    this.paintMark(this.current);
    if (!this.renderer) this.paintCss(look);
  }

  /** Hands over to the next scene now, or to `scene`. @param {Scene} [scene] */
  skip(scene) {
    if (!this.current) return;
    this.next = this.showing(scene ?? this.pickScene(), this.clock);
    this.next.start = Infinity;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    let [w, h] = [Math.round(innerWidth * dpr), Math.round(innerHeight * dpr)];
    const over = Math.sqrt((w * h) / MAX_PIXELS);
    if (over > 1) [w, h] = [Math.round(w / over), Math.round(h / over)];
    this.renderer?.resize(w, h, this.scale);
  }

  /** @param {number} now */
  frame(now) {
    if (!this.running) return;
    if (this.hooks.keepGoing && !this.hooks.keepGoing()) {
      this.stop();
      this.hooks.onEnd?.();
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
    // Every frame of the screen, also those the scenes skip.
    this.adapt(now);
    const dt = now - this.last;
    if (dt <= 0 || dt < this.frameMs - 3) return;
    this.last = now;
    this.fps = this.fps ? this.fps * 0.95 + (1000 / dt) * 0.05 : 1000 / dt;
    if (!this.paused) this.clock += (Math.min(dt, 100) / 1000) * this.speed;
    try {
      this.step();
    } catch (e) {
      this.fallBack(e.message);
    }
  }

  /**
   * Draws lower when the screen misses refreshes. The scenes draw 30 frames a second, but the fade-in, the mark's drift
   * and the compositor want every refresh, 8.3 ms apart at 120 Hz: a GPU still at a low power state draws a scene in
   * time for 30 frames a second and still makes the screen miss refreshes. MISSES of them within about half a second
   * step the scale down, also while the show waits unseen to fade in (shown), so it fades in on time.
   * @param {number} now  this animation frame's time
   */
  adapt(now) {
    const gap = now - this.tick;
    this.tick = now;
    // The first frame of a show, and one after a while hidden, say nothing about the GPU.
    if (!this.renderer || this.paused || !this.frameMs || gap <= 0 || gap > 1000) return;
    // A refresh is the shortest gap seen, 60 Hz at most: frames may all come late from the first.
    this.refresh = Math.min(this.refresh, gap);
    this.missed = this.missed * Math.exp(-gap / 500) + (gap > this.refresh * 1.5 ? 1 : 0);
    if (this.missed >= MISSES && this.scale > MIN_SCALE) {
      this.scale = Math.max(MIN_SCALE, this.scale * 0.85);
      this.missed = 0;
      // The buffers made anew take a refresh of their own, which isn't counted.
      this.tick = 0;
      this.resize();
      // Measurement builds only (src-tauri/src/probe.rs): the frame probe logs each step down.
      if (/** @type {any} */ (window).__LAMPLIT_PROBE__) document.dispatchEvent(new CustomEvent('saver-scale', { detail: this.scale }));
    }
  }

  /** One frame of the show. */
  step() {
    const cur = /** @type {Showing} */ (this.current);
    const r = this.renderer;
    // The next scene gets ready (it may still be compiling) before the current one has run its time.
    if (!this.next && this.clock - cur.start > cur.length - BLEND_S) {
      this.next = this.showing(this.pickScene(), Infinity);
    }
    if (this.next && this.next.start === Infinity && (!r || r.canDraw(this.next.scene))) {
      this.next.start = this.clock;
      this.way = this.wayHeld ?? Math.floor(Math.random() * WAYS);
      this.paintMark(this.next, true);
      if (!r) this.paintCss(this.next.look);
    }
    const blend = this.next && this.next.start !== Infinity ? smooth((this.clock - this.next.start) / BLEND_S) : 0;
    if (this.next && blend >= 1) {
      this.current = this.next;
      this.next = null;
      r?.swap();
      return this.step();
    }
    const dark = this.clock > RUN_LIMIT_S;
    const fade = 1 - smooth((this.clock - RUN_LIMIT_S) / FADE_OUT_S);
    if (this.root.dataset.scene !== cur.scene.id) this.root.dataset.scene = cur.scene.id;
    this.moveMark(blend);
    if (r && r.canDraw(cur.scene)) {
      r.drawScene(0, cur, this.clock - cur.start);
      if (blend > 0 && this.next) r.drawScene(1, this.next, this.clock - this.next.start);
      r.present(blend, this.way, fade, this.clock);
      this.shown();
    } else if (!r) {
      this.css.style.opacity = String(fade);
      this.shown();
    }
    if (dark && fade <= 0) {
      // Black stays on screen; nothing needs drawing until someone comes back.
      this.root.dataset.state = 'dark';
      this.running = false;
      cancelAnimationFrame(this.raf);
      window.removeEventListener('resize', this.resize);
      this.renderer?.release();
    }
  }

  /**
   * The first frame is on the canvas. The screensaver waits (screensaver.css .waiting): drawn over the home screen, so
   * the GPU does all the work it will do once it shows and comes up to speed, but too faint to see. Once its frames
   * have come on time for FADE_SPAN_MS, or FADE_WAIT_MS in, it fades in from there. A press meanwhile calls the show off
   * as before.
   */
  shown() {
    if (this.drawn) return;
    this.drawn = true;
    this.root.classList.add('waiting');
    const starts = this.starts;
    const fadeIn = () => {
      if (!this.running || starts !== this.starts) return;
      this.root.classList.remove('waiting');
      this.root.classList.add('on');
    };
    // Any screen Lamplit drives shows 60 frames a second or more, so a frame later than 25 ms is late from the first.
    steady(fadeIn, { cap: FADE_WAIT_MS, span: FADE_SPAN_MS, frame: 1000 / 60 });
  }

  /**
   * The mark of a scene: its game's logo, else its name, else nothing.
   * @param {Showing} s @param {boolean} [later]  while the scene before still shows its own mark, which has faded
   */
  paintMark(s, later = false) {
    const { logo, name = '' } = s.look;
    const apply = () => {
      this.logo.hidden = !logo;
      this.name.textContent = logo ? '' : name;
      // A logo file that doesn't load leaves the name.
      this.logo.onerror = () => {
        this.logo.hidden = true;
        this.name.textContent = name;
      };
      if (logo) this.logo.src = logo;
      else this.logo.removeAttribute('src');
    };
    if (later) this.pendingMark = apply;
    else apply();
  }

  /** Moves and fades the mark: in after a while, out before the scene hands over, drifting all the time. @param {number} blend */
  moveMark(blend) {
    const s = /** @type {Showing} */ (blend > 0 && this.next ? this.next : this.current);
    if (blend > 0.5 && this.pendingMark) {
      this.pendingMark();
      this.pendingMark = null;
    }
    const t = this.clock - s.start;
    const end = s.length - BLEND_S;
    // A scene that is still blending in is under 6 s old, so its mark hasn't started to show.
    const show = smooth((t - 6) / MARK_IN_S) * (1 - smooth((t - (end - MARK_IN_S)) / MARK_IN_S));
    const opacity = (!showsMark(s.scene) || (this.logo.hidden && !this.name.textContent) ? 0 : MARK_PEAK) * show;
    // A mark nobody sees stays where it is, so a frame makes no new strings for its style.
    if (opacity === 0 && this.markHidden) return;
    this.markHidden = opacity === 0;
    const { x, y, dx, dy } = s.path;
    const px = (x + dx * t) * innerWidth;
    const py = (y + dy * t + Math.sin(t * 0.07) * 0.01) * innerHeight;
    this.mark.style.opacity = opacity.toFixed(3);
    this.mark.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0) scale(${(1 + t * 0.0008).toFixed(4)})`;
  }

  /** The CSS gradient in a look's colours. @param {Look} look */
  paintCss(look) {
    look.palette.forEach(([r, g, b], i) => this.css.style.setProperty(`--c${i}`, `rgb(${r} ${g} ${b})`));
  }

  /** What the preview shows in its corner. */
  info() {
    return {
      scene: this.current?.scene.name ?? '',
      look: this.current?.look.name ?? '',
      mode: this.root.dataset.mode ?? '',
      fps: Math.round(this.fps),
      scale: this.renderer ? this.scale : null,
      size: this.renderer ? `${this.renderer.targets[0]?.width ?? 0} × ${this.renderer.targets[0]?.height ?? 0}` : '',
      clock: this.clock,
    };
  }
}
