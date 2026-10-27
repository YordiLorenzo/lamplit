// @ts-check
// The screensaver's colours, taken from a game's art: median cut finds the art's main colours, and scenePalette shapes
// five of them for a scene, in OKLab so the shaping keeps each hue. Nothing here touches the DOM, so
// tests/screensaver.test.mjs runs it in Node.

/** @typedef {[number, number, number]} RGB  sRGB, 0 to 255 */
/** @typedef {{ rgb: RGB, count: number }} Swatch  a colour of the art, with how many pixels it stands for */
/**
 * The colours of one scene: a deep tone for the background, three main colours, and a light one for highlights.
 * @typedef {[RGB, RGB, RGB, RGB, RGB]} Palette
 */

/** sRGB 0 to 255, to linear 0 to 1. @param {number} c */
const toLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
/** Linear 0 to 1, to sRGB 0 to 255. @param {number} c */
const toSrgb = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * OKLab (Björn Ottosson, 2020): lightness 0 to 1 and two colour axes, where equal steps look equal.
 * @param {RGB} rgb @returns {[number, number, number]}
 */
export function toOklab([r, g, b]) {
  const [R, G, B] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab to linear sRGB, which can fall outside 0 to 1. @param {[number, number, number]} lab */
function labToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (/** @type {number[]} */ c) => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/**
 * OKLCH to sRGB. A colour the screen can't show keeps its lightness and hue and loses chroma until it can.
 * @param {number} L @param {number} C @param {number} h degrees @returns {RGB}
 */
export function fromOklch(L, C, h) {
  const rad = (h * Math.PI) / 180;
  const at = (/** @type {number} */ c) => labToLinear([L, c * Math.cos(rad), c * Math.sin(rad)]);
  let lin = at(C);
  if (!inGamut(lin)) {
    let [lo, hi] = [0, C];
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    lin = at(lo);
  }
  return /** @type {RGB} */ (lin.map((v) => Math.round(Math.min(255, Math.max(0, toSrgb(Math.min(1, Math.max(0, v))))))));
}

/** @param {RGB} rgb @returns {[number, number, number]} lightness, chroma and hue in degrees */
export function toOklch(rgb) {
  const [L, a, b] = toOklab(rgb);
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

/**
 * The art's main colours by median cut: the pixels start as one box, and the box with the widest spread of one
 * channel (weighted by its size) is split at its median until there are `count`. Pixels that are mostly transparent
 * (a logo's background) are left out.
 * @param {ArrayLike<number>} data  RGBA bytes, as getImageData gives them
 * @param {number} [count]
 * @returns {Swatch[]}  most pixels first
 */
export function medianCut(data, count = 8) {
  /** @type {RGB[]} */
  const pixels = [];
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] >= 128) pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (!pixels.length) return [];
  /** @param {RGB[]} box */
  const spread = (box) => {
    let best = { channel: 0, range: -1 };
    for (let ch = 0; ch < 3; ch++) {
      let lo = 255, hi = 0;
      for (const p of box) {
        if (p[ch] < lo) lo = p[ch];
        if (p[ch] > hi) hi = p[ch];
      }
      if (hi - lo > best.range) best = { channel: ch, range: hi - lo };
    }
    return best;
  };
  const boxes = [pixels];
  while (boxes.length < count) {
    let pick = -1, score = 0, channel = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const s = spread(box);
      const weighted = s.range * Math.sqrt(box.length);
      if (s.range > 0 && weighted > score) [pick, score, channel] = [i, weighted, s.channel];
    });
    if (pick < 0) break;
    const box = boxes[pick].sort((a, b) => a[channel] - b[channel]);
    const half = box.length >> 1;
    boxes.splice(pick, 1, box.slice(0, half), box.slice(half));
  }
  // A split at the median can cut a run of one colour in two; those halves are one swatch again.
  /** @type {Map<string, Swatch>} */
  const swatches = new Map();
  for (const box of boxes) {
    const sum = [0, 0, 0];
    for (const p of box) for (let ch = 0; ch < 3; ch++) sum[ch] += p[ch];
    const rgb = /** @type {RGB} */ (sum.map((v) => Math.round(v / box.length)));
    const same = swatches.get(String(rgb));
    if (same) same.count += box.length;
    else swatches.set(String(rgb), { rgb, count: box.length });
  }
  return [...swatches.values()].sort((a, b) => b.count - a.count);
}

/** Degrees between two hues, 0 to 180. @param {number} a @param {number} b */
const hueGap = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/** Below this chroma a colour reads as grey, and its hue means little. */
const GREY = 0.05;

/**
 * Five colours for a scene, from the art's swatches. The three main colours are the art's most vivid ones that differ
 * in hue, brought to a mid lightness and a rich chroma, so no scene glows white, sinks to black or turns to mud; art
 * with fewer distinct colours gets their neighbours on the colour wheel. Only art that is grey all over gives a grey
 * (cool silver) palette.
 * @param {Swatch[]} swatches
 * @returns {Palette}
 */
export function scenePalette(swatches) {
  const total = swatches.reduce((n, s) => n + s.count, 0) || 1;
  const colours = swatches.map((s) => {
    const [L, C, h] = toOklch(s.rgb);
    // Very dark and very light pixels (shadows, sky, a white logo) say least about the art's colour.
    const tone = L < 0.22 ? 0.3 : L > 0.93 ? 0.4 : 1;
    return { L, C, h, w: s.count / total, score: Math.sqrt(s.count / total) * C * tone };
  });
  /** @type {{ L: number, C: number, h: number }[]} */
  const main = [];
  for (const c of [...colours].sort((a, b) => b.score - a.score)) {
    if (main.length < 3 && c.C >= GREY && main.every((m) => hueGap(c.h, m.h) > 30)) main.push(c);
  }
  const grey = !main.length;
  if (grey) {
    // A faint tint in grey art still says which way to lean; with none, a cool blue.
    const tinted = colours.filter((c) => c.C > 0.012).sort((a, b) => b.w - a.w)[0];
    main.push({ L: 0.62, C: 0.045, h: tinted?.h ?? 255 });
  }
  // Too few colours: neighbours on the colour wheel, on the side away from the second colour when there is one.
  const [first, second] = main;
  const away = second && ((second.h - first.h + 540) % 360) - 180 > 0 ? -1 : 1;
  for (const turn of [36 * away, -36 * away, 72 * away]) {
    if (main.length < 3) main.push({ L: first.L + 0.05, C: first.C, h: (first.h + turn + 360) % 360 });
  }
  const shaped = main.map((c) =>
    fromOklch(Math.min(0.76, Math.max(0.56, 0.44 + c.L * 0.36)), grey ? c.C : Math.min(0.21, Math.max(0.12, c.C * 1.3)), c.h)
  );
  // The deep tone takes the hue of the art's dark areas when they have one, else the first main colour's.
  const darks = colours.filter((c) => c.L < 0.4 && c.C > 0.02).sort((a, b) => b.w - a.w);
  const deep = darks[0] ?? first;
  const brightest = [...main].sort((a, b) => b.L - a.L)[0];
  return [
    fromOklch(0.2, Math.min(0.075, Math.max(0.03, deep.C)), deep.h),
    shaped[0],
    shaped[1],
    shaped[2],
    fromOklch(0.88, Math.min(0.1, brightest.C * 0.6), brightest.h),
  ];
}

/**
 * The three main colours as one gradient that loops (a, b, c and back to a), blended in OKLab so the steps look even
 * and no muddy colour sits between two vivid ones.
 * @param {Palette} palette
 * @param {number} [steps]
 * @returns {Uint8Array}  RGBA bytes, `steps` texels wide
 */
export function gradient(palette, steps = 256) {
  const stops = [palette[1], palette[2], palette[3]].map(toOklab);
  const out = new Uint8Array(steps * 4);
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 3;
    const k = Math.floor(t);
    const f = t - k;
    const e = f * f * (3 - 2 * f);
    const [a, b] = [stops[k % 3], stops[(k + 1) % 3]];
    const lab = /** @type {[number, number, number]} */ (a.map((v, j) => v + (b[j] - v) * e));
    const lin = labToLinear(lab).map((v) => Math.min(1, Math.max(0, v)));
    lin.forEach((v, j) => (out[i * 4 + j] = Math.round(toSrgb(v))));
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** A scene palette from a few colours given by hand, each counting the same. @param {RGB[]} colours */
export const paletteOf = (colours) => scenePalette(colours.map((rgb) => ({ rgb, count: 1 })));

/** Lamplit's own colours, for a library without art: its lavender and amber, with a blue between them. */
export const LAMPLIT = paletteOf([
  [171, 132, 222],
  [252, 165, 69],
  [96, 140, 255],
]);
