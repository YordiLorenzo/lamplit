// Unit tests for the screensaver's palette (ui/screensaver/palette.js) and its list of scenes. Needs nothing installed:
// `node --test tests/screensaver.test.mjs`. The page's tests (ui.test.mjs) cover the screensaver on screen.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LAMPLIT, fromOklch, gradient, medianCut, paletteOf, scenePalette, toOklch } from '../ui/screensaver/palette.js';
import { SCENES } from '../ui/screensaver/scenes.js';

/** RGBA bytes of an image made of `parts`: [[r, g, b, a?], pixel count] each. */
function image(...parts) {
  const out = [];
  for (const [[r, g, b, a = 255], n] of parts) for (let i = 0; i < n; i++) out.push(r, g, b, a);
  return new Uint8ClampedArray(out);
}

const hueGap = (a, b) => Math.min(Math.abs(a - b) % 360, 360 - (Math.abs(a - b) % 360));
const lch = (rgb) => toOklch(rgb);
/** The colours a palette is made of, named. */
const parts = ([deep, a, b, c, glow]) => ({ deep: lch(deep), main: [a, b, c].map(lch), glow: lch(glow) });

describe('median cut', () => {
  test('finds the colours of the art, most pixels first', () => {
    const swatches = medianCut(image([[200, 40, 30], 300], [[30, 60, 190], 100]), 4);
    assert.deepEqual(swatches.map((s) => s.rgb), [[200, 40, 30], [30, 60, 190]]);
    assert.deepEqual(swatches.map((s) => s.count), [300, 100]);
  });
  test('leaves out pixels that are mostly transparent, as round a logo', () => {
    const swatches = medianCut(image([[255, 255, 255, 0], 500], [[10, 160, 90], 20]));
    assert.deepEqual(swatches, [{ rgb: [10, 160, 90], count: 20 }]);
  });
  test('art of one colour is one swatch, and no art is none', () => {
    assert.equal(medianCut(image([[90, 90, 90], 64]), 8).length, 1);
    assert.deepEqual(medianCut(new Uint8ClampedArray(0)), []);
  });
  test('splits a gradient into as many swatches as asked', () => {
    const ramp = image(...Array.from({ length: 64 }, (_, i) => [[i * 4, 100, 255 - i * 4], 1]));
    assert.equal(medianCut(ramp, 8).length, 8);
  });
});

describe('scene palette', () => {
  test("keeps the art's hues", () => {
    const { main } = parts(scenePalette(medianCut(image([[200, 40, 30], 300], [[30, 60, 190], 300]))));
    const red = lch([200, 40, 30])[2], blue = lch([30, 60, 190])[2];
    assert.ok(main.some((c) => hueGap(c[2], red) < 6), `red in ${JSON.stringify(main)}`);
    assert.ok(main.some((c) => hueGap(c[2], blue) < 6), `blue in ${JSON.stringify(main)}`);
  });
  test('a deep tone, three mid colours and a light one, none of them white or black', () => {
    for (const palette of [LAMPLIT, scenePalette(medianCut(image([[250, 250, 240], 50], [[5, 5, 5], 50], [[240, 200, 0], 10])))]) {
      const { deep, main, glow } = parts(palette);
      assert.ok(Math.abs(deep[0] - 0.2) < 0.02, `deep ${deep}`);
      for (const c of main) assert.ok(c[0] >= 0.55 && c[0] <= 0.77, `main ${c}`);
      assert.ok(Math.abs(glow[0] - 0.88) < 0.02 && glow[1] < 0.105, `glow ${glow}`);
    }
  });
  test('greyish swatches next to vivid ones are passed over, so no main colour is muddy', () => {
    const art = image([[120, 118, 115], 500], [[140, 135, 130], 400], [[220, 140, 20], 60], [[40, 90, 200], 40]);
    for (const c of parts(scenePalette(medianCut(art))).main) assert.ok(c[1] >= 0.1, `chroma ${c}`);
  });
  test('one colour gets its neighbours on the colour wheel', () => {
    const { main } = parts(scenePalette(medianCut(image([[30, 140, 70], 100]))));
    const gaps = [hueGap(main[0][2], main[1][2]), hueGap(main[0][2], main[2][2]), hueGap(main[1][2], main[2][2])];
    assert.ok(gaps.every((g) => g > 25), JSON.stringify(main));
  });
  test('grey art gives a quiet silver, and no art the same', () => {
    const grey = scenePalette(medianCut(image([[128, 128, 128], 50], [[200, 200, 200], 50], [[30, 30, 30], 50])));
    for (const c of parts(grey).main) assert.ok(c[1] < 0.06, `chroma ${c}`);
    assert.deepEqual(scenePalette([]), scenePalette(medianCut(image([[128, 128, 128], 4]))));
  });
  test('the same art always gives the same palette', () => {
    const art = image([[200, 40, 30], 300], [[30, 60, 190], 100], [[250, 220, 90], 40]);
    assert.deepEqual(scenePalette(medianCut(art)), scenePalette(medianCut(art)));
  });
  test('every colour is a whole sRGB byte triple', () => {
    for (const rgb of [...LAMPLIT, ...paletteOf([[255, 0, 255], [0, 255, 0]])]) {
      assert.ok(rgb.length === 3 && rgb.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), JSON.stringify(rgb));
    }
  });
});

describe('colour helpers', () => {
  test('a colour the screen cannot show keeps its lightness and hue', () => {
    const [L, , h] = lch(fromOklch(0.7, 0.4, 150));
    assert.ok(Math.abs(L - 0.7) < 0.01 && hueGap(h, 150) < 3, `${L} ${h}`);
  });
  test('the gradient loops through the three main colours', () => {
    const bytes = gradient(LAMPLIT, 300);
    const at = (i) => [...bytes.slice(i * 4, i * 4 + 3)];
    assert.equal(bytes.length, 1200);
    assert.ok([...bytes].filter((_, i) => i % 4 === 3).every((a) => a === 255));
    assert.deepEqual([at(0), at(100), at(200)], [LAMPLIT[1], LAMPLIT[2], LAMPLIT[3]]);
    // The last step is a step away from the first: no seam where the loop closes.
    assert.ok(at(299).every((v, i) => Math.abs(v - at(0)[i]) < 8), `${at(299)} ${at(0)}`);
  });
});

describe('scenes', () => {
  test('each has its own id, a kind and a scene function', () => {
    assert.equal(new Set(SCENES.map((s) => s.id)).size, SCENES.length);
    for (const s of SCENES) assert.ok(['2d', '3d'].includes(s.kind) && /vec3 scene\(vec2 frag\)/.test(s.source), s.id);
  });
  test('there are 2D and 3D scenes, so each style has something to show', () => {
    assert.ok(SCENES.filter((s) => s.kind === '2d').length >= 2 && SCENES.filter((s) => s.kind === '3d').length >= 2);
  });
});
