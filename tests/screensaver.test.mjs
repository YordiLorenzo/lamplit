// Unit tests for the screensaver's palette (ui/screensaver/palette.js) and its list of scenes. Needs nothing installed:
// `node --test tests/screensaver.test.mjs`. The page's tests (ui.test.mjs) cover the screensaver on screen.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LAMPLIT, forMood, fromOklch, gradient, medianCut, paletteOf, scenePalette, toOklch } from '../ui/screensaver/palette.js';
import { DRIFT, SCENES, driftCycle, fragmentSource, nextOrder, particleSources, scenesFor, showsMark } from '../ui/screensaver/scenes.js';

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
  test('the gradient loops through the three main colours, by day and at night', () => {
    for (const mood of ['day', 'night']) {
      const palette = forMood(LAMPLIT, mood);
      const bytes = gradient(palette, 300, mood);
      const at = (i) => [...bytes.slice(i * 4, i * 4 + 3)];
      assert.equal(bytes.length, 1200);
      assert.ok([...bytes].filter((_, i) => i % 4 === 3).every((a) => a === 255));
      [at(0), at(100), at(200)].forEach((rgb, k) => assert.ok(rgb.every((v, i) => Math.abs(v - palette[k + 1][i]) <= 2), `${mood} ${rgb} ${palette[k + 1]}`));
      // The last step is a step away from the first: no seam where the loop closes.
      assert.ok(at(299).every((v, i) => Math.abs(v - at(0)[i]) < 10), `${mood} ${at(299)} ${at(0)}`);
    }
  });
});

describe('palettes by mood', () => {
  // Three kinds of art that turn to mud most easily: yellow (Cyberpunk 2077's cover), red and amber (Red Dead
  // Redemption 2's), and grey all over.
  const yellow = scenePalette(medianCut(image([[240, 230, 20], 300], [[25, 20, 10], 200], [[90, 200, 60], 60], [[240, 140, 0], 40])));
  const red = scenePalette(medianCut(image([[200, 30, 25], 300], [[210, 140, 10], 100], [[30, 20, 10], 200])));
  const grey = scenePalette(medianCut(image([[118, 118, 120], 100], [[160, 158, 154], 100], [[70, 71, 74], 100])));
  /** Hues 0 to 360 in 37 steps, at three lightnesses: palettes from every kind of art, made the same way each run. */
  const wheel = Array.from({ length: 37 }, (_, i) => paletteOf([[0.45, 0.6, 0.75].map((L, k) => fromOklch(L, 0.14, i * 10 + k * 40))].flat()));
  const all = [LAMPLIT, yellow, red, grey, ...wheel];
  /** Olive, khaki and mustard: a yellow hue that isn't light. */
  const mud = ([L, C, h]) => h > 70 && h < 115 && L < 0.7 && C > 0.04;
  const texels = (bytes) => Array.from({ length: bytes.length / 4 }, (_, i) => lch([...bytes.slice(i * 4, i * 4 + 3)]));

  test('no main colour and no step of the gradient is mud, by day or at night', () => {
    for (const palette of all) {
      for (const mood of ['day', 'night']) {
        const p = forMood(palette, mood);
        const muddy = [...p.slice(1, 4).map(lch), ...texels(gradient(p, 128, mood))].filter(mud);
        assert.deepEqual(muddy, [], `${mood} ${JSON.stringify(palette)}`);
      }
    }
  });
  test('at night the dark is a deep blue or teal, and every main colour glows', () => {
    for (const palette of all) {
      const { deep, main } = parts(forMood(palette, 'night'));
      assert.ok(deep[0] < 0.25 && deep[2] >= 180 && deep[2] <= 280, `deep ${deep}`);
      // As much chroma as the screen can show at that lightness: a teal can't reach as far as a red.
      for (const c of main) assert.ok(c[0] >= 0.6 && c[1] >= 0.1, `main ${c}`);
    }
  });
  test('at night the gradient keeps out of yellow altogether', () => {
    for (const palette of all) {
      const yellows = texels(gradient(forMood(palette, 'night'), 128, 'night')).filter(([, C, h]) => C > 0.05 && h > 62 && h < 118);
      assert.deepEqual(yellows, [], JSON.stringify(palette));
    }
  });
  test("by day a yellow from the art stays warm and light: gold, or green when it leaned green", () => {
    const { main } = parts(forMood(yellow, 'day'));
    for (const c of main.filter(([, , h]) => h > 55 && h < 125)) assert.ok(c[0] >= 0.7, `main ${c}`);
    assert.ok(main.some(([, , h]) => h > 55 && h < 85), `a gold in ${JSON.stringify(main)}`);
  });
  test('grey art stays quiet by day and turns a cool silver-blue at night', () => {
    for (const c of parts(forMood(grey, 'day')).main) assert.ok(c[1] < 0.06, `day ${c}`);
    for (const c of parts(forMood(grey, 'night')).main) assert.ok(c[2] > 200 && c[2] < 260, `night ${c}`);
  });
});

describe('scenes', () => {
  test('the seven scenes the player kept, each with its own id, a mood and a scene function', () => {
    assert.deepEqual(SCENES.map((s) => s.id).sort(), ['aurora', 'drift', 'dunes', 'gallery', 'ink', 'nebula', 'ocean']);
    for (const s of SCENES) assert.ok(['day', 'night'].includes(s.mood) && /vec3 scene\(vec2 frag\)/.test(s.source), s.id);
  });
  test('without art, the show still has its five other scenes', () => {
    const bare = scenesFor({ covers: false, heroes: 0 });
    assert.deepEqual(bare.map((s) => s.id).sort(), ['aurora', 'dunes', 'ink', 'nebula', 'ocean']);
  });
  test('Gallery comes in with the covers, Drift with two hero images', () => {
    const ids = (have) => scenesFor(have).map((s) => s.id);
    assert.ok(ids({ covers: true, heroes: 0 }).includes('gallery'));
    assert.ok(!ids({ covers: false, heroes: 1 }).includes('drift'));
    assert.ok(ids({ covers: false, heroes: 2 }).includes('drift'));
    assert.deepEqual(ids({ covers: true, heroes: 4 }), SCENES.map((s) => s.id));
  });
  test('a new order holds every scene once and never starts with the one showing, so no scene follows itself', () => {
    // A seeded random, so every run checks the same thousand orders.
    let seed = 7;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    let current = SCENES[0];
    for (let i = 0; i < 1000; i++) {
      const order = nextOrder(SCENES, current, random);
      assert.deepEqual([...order].sort((a, b) => a.id.localeCompare(b.id)), [...SCENES].sort((a, b) => a.id.localeCompare(b.id)));
      assert.notEqual(order[0], current, `order ${i}`);
      current = order.at(-1);
    }
    assert.deepEqual(nextOrder([SCENES[0]], SCENES[0], random), [SCENES[0]]);
  });
  test("the game's logo drifts over every scene but the two that show the games' own art", () => {
    assert.deepEqual(SCENES.filter((s) => !showsMark(s)).map((s) => s.id).sort(), ['drift', 'gallery']);
  });
  test('each scene that shows art says which, and Drift picks its hero images', () => {
    for (const s of SCENES.filter((x) => x.needs)) assert.ok(['covers', 'heroes'].includes(s.needs ?? ''), s.id);
    assert.ok(SCENES.filter((x) => x.needs === 'heroes').every((x) => typeof x.heroes === 'function'));
  });
  test('the shaders are put together for every scene, with particle shaders only where they belong', () => {
    for (const s of SCENES) {
      assert.match(fragmentSource(s), /^#version 300 es[\s\S]*void main\(\)/, s.id);
      assert.equal(!!particleSources(s), !!s.particles, s.id);
      if (s.particles) assert.match(particleSources(s)?.vertex ?? '', /gl_InstanceID/, s.id);
    }
  });
});

describe("Drift's timing", () => {
  const length = DRIFT.hold + DRIFT.change;
  test('holds the first image, then changes it into the second', () => {
    assert.deepEqual(driftCycle(0, 3), { a: 0, b: 1, mix: 0, cycle: 0 });
    assert.equal(driftCycle(DRIFT.hold - 0.01, 3).mix, 0);
    assert.equal(driftCycle(DRIFT.hold + DRIFT.change / 2, 3).mix, 0.5);
  });
  test('the end of a change is the start of the next hold, on the image it changed into', () => {
    const end = driftCycle(length - 1e-6, 3);
    const next = driftCycle(length, 3);
    assert.ok(end.mix > 0.99 && next.mix === 0 && next.a === end.b, JSON.stringify({ end, next }));
  });
  test('goes round every image and back to the first', () => {
    const seen = Array.from({ length: 4 }, (_, k) => driftCycle(k * length + 1, 4).a);
    assert.deepEqual(seen, [0, 1, 2, 3]);
    assert.equal(driftCycle(4 * length + 1, 4).a, 0);
  });
});
