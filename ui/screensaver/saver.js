// @ts-check
// The screensaver on screen: its scenes in turn, each coloured from one game and handing over to the next, and that
// game's logo or name drifting faintly through it. Gallery and Drift show the games' covers and hero images
// themselves. Without WebGL2 it shows a CSS gradient that moves the same way. Lamplit (index.js) and the preview
// (preview.js) both drive this.

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
/** A scene lasts this long, in seconds, give or take a third of SCENE_SPREAD. */
const SCENE_S = 95;
const SCENE_SPREAD = 30;
/** The blend from one scene to the next. */
const BLEND_S = 7;
/** The scenes render at this part of the canvas's size, less on a GPU that can't keep up. */
const START_SCALE = 0.6;
const MIN_SCALE = 0.34;
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
/** Drift's hero images: up to this many, scaled down to this width (Steam's are 3840 pixels wide). */
const HEROES = { most: 4, width: 1600 };

/**
 * An image from a URL (Lamplit's asset protocol sends the CORS header, so WebGL may use it), or one already made.
 * @param {string | TexImageSource} src
 * @returns {Promise<TexImageSource>}
 */
async function imageOf(src) {
  if (typeof src !== 'string') return src;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await img.decode();
  return img;
}

/** @param {number} width @param {number} height */
const canvas2d = (width, height) => {
  const c = Object.assign(document.createElement('canvas'), { width, height });
  return { canvas: c, ctx: /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')) };
};

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
    this.slow = 0;
    this.fps = 0;
    /** Whether a frame is on the canvas yet, so the screensaver can fade in over the home screen. */
    this.drawn = false;
    /** Why the CSS gradient shows instead of WebGL, for the log. */
    this.reason = '';
    /** @type {(() => void) | null} the next scene's mark, put up once the current one has faded */
    this.pendingMark = null;
    this.releaseTimer = 0;
    /** @type {{ atlas: Art['atlas'], heroes: { source: TexImageSource, look: number }[] }} the games' art, once loaded */
    this.art = { atlas: null, heroes: [] };
    /** How the scene on its way comes in (renderer.js WAYS); the preview can hold one. */
    this.way = 0;
    /** @type {number | null} */
    this.wayHeld = null;
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
    this.art = { atlas: null, heroes: [] };
    this.loadArt(this.looks);
  }

  /**
   * The covers into one atlas and the hero images scaled down, for Gallery and Drift. They join the show once loaded;
   * art that doesn't load is left out.
   * @param {Look[]} looks
   */
  async loadArt(looks) {
    const load = (/** @type {string | TexImageSource | null | undefined} */ src) => (src ? imageOf(src).catch(() => null) : null);
    const [covers, heroes] = await Promise.all([
      Promise.all(looks.slice(0, COVERS.most).map((l) => load(l.cover))),
      Promise.all(looks.map((l) => load(l.hero))),
    ]);
    if (looks !== this.looks) return;
    const found = /** @type {TexImageSource[]} */ (covers.filter(Boolean));
    let atlas = null;
    if (found.length) {
      const cols = Math.min(COVERS.cols, found.length);
      const rows = Math.ceil(found.length / cols);
      const { canvas, ctx } = canvas2d(cols * COVERS.width, rows * COVERS.height);
      found.forEach((img, i) => {
        const { width, height } = /** @type {{ width: number, height: number }} */ (img);
        // Fill the cell, cropping what doesn't fit 2:3.
        const scale = Math.max(COVERS.width / width, COVERS.height / height);
        const [w, h] = [width * scale, height * scale];
        const [x, y] = [(i % cols) * COVERS.width + (COVERS.width - w) / 2, Math.floor(i / cols) * COVERS.height + (COVERS.height - h) / 2];
        ctx.save();
        ctx.beginPath();
        ctx.rect((i % cols) * COVERS.width, Math.floor(i / cols) * COVERS.height, COVERS.width, COVERS.height);
        ctx.clip();
        ctx.drawImage(/** @type {CanvasImageSource} */ (img), x, y, w, h);
        ctx.restore();
      });
      atlas = { source: canvas, count: found.length, cols, rows };
    }
    const scaled = heroes.flatMap((img, look) => {
      if (!img) return [];
      const { width, height } = /** @type {{ width: number, height: number }} */ (img);
      const w = Math.min(HEROES.width, width);
      const { canvas, ctx } = canvas2d(w, Math.round((height * w) / width));
      ctx.drawImage(/** @type {CanvasImageSource} */ (img), 0, 0, canvas.width, canvas.height);
      return [{ source: canvas, look }];
    });
    this.art = { atlas, heroes: scaled.slice(0, HEROES.most) };
    // The order so far was shuffled without them.
    this.queue = [];
  }

  /** The art a showing draws with: its own game's hero image first. @param {Showing} s @returns {Art} */
  artFor(s) {
    const { heroes } = this.art;
    const first = Math.max(0, heroes.findIndex((h) => h.look === s.lookIndex));
    return { atlas: this.art.atlas, heroes: [...heroes.slice(first), ...heroes.slice(0, first)].map((h) => h.source) };
  }

  /** The next scene in a shuffled order of those the art can show, never the one showing now. */
  pickScene() {
    if (!this.queue.length) {
      const have = { covers: !!this.art.atlas, heroes: this.art.heroes.length };
      this.queue = nextOrder(scenesFor(have), this.current?.scene);
    }
    return /** @type {Scene} */ (this.queue.shift());
  }

  /** @param {Scene} scene @param {number} start @returns {Showing} */
  showing(scene, start) {
    const lookIndex = this.lookAt++ % this.looks.length;
    const angle = Math.random() * Math.PI * 2;
    return {
      scene,
      look: this.looks[lookIndex],
      lookIndex,
      seed: Math.random(),
      start,
      length: SCENE_S + (Math.random() - 0.5) * SCENE_SPREAD,
      path: { x: 0.08 + Math.random() * 0.5, y: 0.14 + Math.random() * 0.6, dx: Math.cos(angle) * 0.0022, dy: Math.sin(angle) * 0.0012 },
    };
  }

  /** Starts the show, on `scene` if given. @param {Scene} [scene] */
  start(scene) {
    if (this.running) return;
    clearTimeout(this.releaseTimer);
    const gl = this.gl();
    this.root.dataset.mode = gl ? 'webgl' : 'css';
    this.clock = 0;
    this.next = null;
    this.current = this.showing(scene ?? this.pickScene(), 0);
    this.mark.style.opacity = '0';
    this.pendingMark = null;
    this.paintMark(this.current);
    if (!gl) this.paintCss(this.current.look);
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
    this.root.classList.remove('on');
    delete this.root.dataset.state;
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => this.renderer?.release(), 1000);
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
    const dt = now - this.last;
    if (dt <= 0 || dt < this.frameMs - 3) return;
    this.last = now;
    this.fps = this.fps ? this.fps * 0.95 + (1000 / dt) * 0.05 : 1000 / dt;
    if (!this.paused) this.clock += (Math.min(dt, 100) / 1000) * this.speed;
    this.adapt(dt);
    try {
      this.step();
    } catch (e) {
      this.fallBack(e.message);
    }
  }

  /**
   * Draws lower when frames come late: half a second of frames more than 40% late steps the scale down.
   * @param {number} dt
   */
  adapt(dt) {
    if (!this.renderer || this.paused || !this.frameMs) return;
    this.slow = dt > this.frameMs * 1.4 ? this.slow + dt : Math.max(0, this.slow - dt);
    if (this.slow > 500 && this.scale > MIN_SCALE) {
      this.scale = Math.max(MIN_SCALE, this.scale * 0.85);
      this.slow = 0;
      this.resize();
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
      const look = (/** @type {Showing} */ s) => ({ time: this.clock - s.start, seed: s.seed, palette: s.look.palette, art: this.artFor(s) });
      r.drawScene(0, cur.scene, look(cur));
      if (blend > 0 && this.next) r.drawScene(1, this.next.scene, look(this.next));
      r.present({ mix: blend, way: this.way, fade, time: this.clock });
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

  /** The first frame is on the canvas: only now does the screensaver fade in over the home screen. */
  shown() {
    if (this.drawn) return;
    this.drawn = true;
    this.root.classList.add('on');
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
