// @ts-check
// The screensaver's scenes, each a WebGL2 fragment shader that draws one frame from the time and a palette, and for
// some, particles drawn over it. They write linear light into a buffer smaller than the screen, and how far out of
// focus each pixel is; renderer.js does the rest (focus blur, the handover between scenes, bloom, tone mapping,
// grain). Gallery and Drift show the player's own art: their covers, and their hero images.

/**
 * A game's art as the scenes that show it get it: the covers side by side in one image (an atlas), and hero images.
 * @typedef {object} Art
 * @property {{ source: TexImageSource, count: number, cols: number, rows: number } | null} atlas
 * @property {TexImageSource[]} heroes  the scene's own game's first
 */

/**
 * @typedef {object} Scene
 * @property {string} id
 * @property {string} name  as the preview shows it
 * @property {import('./palette.js').Mood} mood  which way palette.js forMood adapts the palette
 * @property {string} source  GLSL that defines `vec3 scene(vec2 frag)`, and may set `coc`
 * @property {string} [lib]  GLSL that the scene's picture and its particles both use
 * @property {'covers' | 'heroes'} [needs]  art the scene can't show without (two heroes at least)
 * @property {(time: number, count: number) => { a: number, b: number, mix: number, cycle: number }} [heroes]  which
 *   two hero images the scene shows at `time`, and how far it has gone from the first to the second
 * @property {{ count: number, vertex: string, fragment: string }} [particles]  instanced quads; the vertex shader
 *   places each from gl_InstanceID and gl_VertexID
 */

/**
 * What every program gets: the buffer's size in pixels, seconds since the scene began, a number from 0 to 1 that
 * makes each showing different, the palette in linear light (0 deep, 1 to 3 main, 4 light), the main colours as a
 * looping gradient (palette.js gradient), smooth noise in a 3D texture, and the scene's art.
 * Then hashes without sin (Dave Hoskins), which stay stable on every GPU, and gradient noise.
 */
const SHARED = `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
uniform vec2 uRes;
uniform float uTime;
uniform float uSeed;
uniform vec3 uPal[5];
uniform sampler2D uGrad;
uniform sampler3D uNoise;
uniform sampler2D uArt, uArt2;
uniform vec4 uArtInfo;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
// Gradient noise, about -0.7 to 0.7.
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  float a = dot(hash22(i) * 2. - 1., f);
  float b = dot(hash22(i + vec2(1, 0)) * 2. - 1., f - vec2(1, 0));
  float c = dot(hash22(i + vec2(0, 1)) * 2. - 1., f - vec2(0, 1));
  float d = dot(hash22(i + vec2(1, 1)) * 2. - 1., f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// How far out of focus this pixel is, 0 to 1; a 3D scene sets it, and the mix pass blurs by it.
float coc = 0.;
const mat2 OCTAVE = mat2(1.6, 1.2, -1.2, 1.6);
float fbm(vec2 p, int octaves) {
  float s = 0., a = .5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    s += a * gnoise(p);
    p = OCTAVE * p;
    a *= .5;
  }
  return s;
}
// The main colours as one loop: 0, 1/3 and 2/3 are the three colours.
vec3 grad(float t) { return texture(uGrad, vec2(t, .5)).rgb; }
// A colour dimmed to k (0 to 1). Dimmed as it is, a yellow turns olive; this one leans away from the middle of yellow
// as it darkens, towards amber as gold does in shadow, or towards green when it was a yellow-green.
vec3 dim(vec3 c, float k) {
  float yellow = clamp((min(c.r, c.g) - c.b) / max(max(c.r, c.g), 1e-4), 0., 1.);
  float away = .55 * yellow * (1. - clamp(k, 0., 1.));
  float warm = smoothstep(-.04, .04, (c.r - c.g) / max(max(c.r, c.g), 1e-4));
  c.g *= 1. - away * warm;
  c.r *= 1. - away * (1. - warm);
  return c * k;
}
mat3 lookAt(vec3 ro, vec3 ta) {
  vec3 w = normalize(ta - ro);
  vec3 u = normalize(cross(w, vec3(0, 1, 0)));
  return mat3(u, cross(u, w), w);
}
// Smooth noise from the texture, about -1 to 1; one unit of p is one cell of its coarser lattice, and it repeats
// every 8 units.
float noise3(vec3 p) { return texture(uNoise, p * .125).r * 2. - 1.; }
float fbm3(vec3 p, int octaves) {
  float s = 0., a = .5;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    s += a * noise3(p);
    p = p * 2.03 + vec3(1.7, 9.2, 4.1);
    a *= .5;
  }
  return s;
}
`;

export const COMMON = `#version 300 es${SHARED}out vec4 fragColor;
`;

const MAIN = `
void main() {
  vec3 c = max(scene(gl_FragCoord.xy), 0.);
  fragColor = vec4(c, clamp(coc, 0., 1.));
}
`;

/** Ink: coloured smoke on a dark ground, folded by domain warping, with bright threads where it is thinnest. */
const ink = `
vec3 scene(vec2 frag) {
  vec2 uv = (frag - .5 * uRes) / uRes.y;
  float t = uTime * .022 + uSeed * 23.;
  vec2 p = uv * 1.05;
  vec2 q = vec2(fbm(p + vec2(0., t * .6), 4), fbm(p + vec2(5.2, 1.3) - t * .4, 4));
  vec2 r = vec2(fbm(p + 2.3 * q + vec2(1.7, 9.2) + t * .5, 4), fbm(p + 2.3 * q + vec2(8.3, 2.8) - t * .35, 4));
  float f = fbm(p + 2.1 * r + vec2(t * .2, 0.), 5);
  // The body of the smoke, and threads along one level of the field.
  float body = smoothstep(-.12, .5, f);
  float thread = exp(-abs(f - .08) * 14.);
  vec3 col = uPal[0] * .22;
  col += grad(q.x * .6 + t * .12) * body * body * .75;
  col += grad(.4 + r.y * .6 - t * .1) * thread * .8;
  col += uPal[4] * pow(thread, 8.) * .4;
  return col;
}
`;

/**
 * Dunes: a desert at the end of the day under a slow camera. A low sun to one side lights one flank of each dune and
 * leaves the other in the sky's cool light, with long soft shadows, a sheen on the lit sand and haze that takes the far
 * dunes into the sky.
 */
const dunes = `
float terrain(vec2 p) {
  vec2 b = p + 5. * vec2(gnoise(p * .06), gnoise(p * .05 + 3.1));
  float ridge = 1. - abs(sin(b.x * .19 + b.y * .05));
  return ridge * ridge * 1.6 + gnoise(p * .09) * 2.6 + gnoise(p * .27 + 7.) * .35;
}
// The large swell alone: where the terrain lies below it is a trough, which the sky lights less.
float swell(vec2 p) { return gnoise(p * .09) * 2.6 + .8; }
float ripples(vec2 p) { return terrain(p) + gnoise(p * vec2(2.1, .8)) * .025; }
// The sun sits low, ahead and to the left. The sky above is a cool blue, whatever the palette: sand in a yellow
// palette under a sky of the same colour turns olive, while a cool sky keeps the shadows blue and the sand warm.
const vec3 SUN = vec3(-.6, .1, .8);
vec3 sunLight() { return mix(uPal[4], grad(.1), .25) * 2.8; }
vec3 zenith() { return mix(vec3(.02, .042, .125), uPal[0], .15); }
// The haze is the palette's light colour, half greyed and cooled: a dim yellow haze would read as khaki.
vec3 horizon() {
  vec3 c = mix(uPal[4], grad(.62), .25);
  float l = dot(c, vec3(.2126, .7152, .0722));
  return mix(mix(vec3(l), c, .5), vec3(.82, .9, 1.) * l, .35) * .62;
}
vec3 sky(vec3 rd) {
  vec3 sun = normalize(SUN);
  float y = max(rd.y, 0.);
  vec3 col = mix(horizon(), zenith(), pow(smoothstep(0., .34, y), .6));
  float s = max(dot(rd, sun), 0.);
  col += sunLight() * (smoothstep(.9993, .9998, s) * .5 + pow(s, 120.) * .2 + pow(s, 10.) * .09);
  return col + horizon() * exp(-y * 18.) * .3;
}
// Air between the camera and what it sees: the far dunes take on the haze, and the haze glows towards the sun.
vec3 haze(vec3 rd) { return horizon() * 1.1 + sunLight() * pow(max(dot(rd, normalize(SUN)), 0.), 8.) * .1; }
vec3 aerial(vec3 col, vec3 rd, float t) { return mix(col, haze(rd), 1. - exp(-t * .014)); }
float shadow(vec3 ro, vec3 rd) {
  float res = 1., t = .2;
  for (int i = 0; i < 28; i++) {
    vec3 p = ro + rd * t;
    float h = p.y - terrain(p.xz);
    res = min(res, 9. * h / t);
    if (res < .01 || p.y > 4.5) break;
    t += clamp(h * .5, .12, 1.4);
  }
  return smoothstep(0., 1., clamp(res, 0., 1.));
}
// The sand at distance t along the ray: sun and shadow, the sky's light in the troughs, a sheen, and the haze.
vec3 sand(vec3 ro, vec3 rd, float t) {
  vec3 p = ro + rd * t;
  float e = .008 + .0012 * t;
  vec3 n = normalize(vec3(ripples(p.xz - vec2(e, 0)) - ripples(p.xz + vec2(e, 0)), 2. * e,
                          ripples(p.xz - vec2(0, e)) - ripples(p.xz + vec2(0, e))));
  vec3 sun = normalize(SUN);
  float ndv = clamp(dot(n, -rd), 0., 1.);
  float lit = max(dot(n, sun), 0.) * shadow(p + n * .03, sun);
  float trough = clamp(.45 + (terrain(p.xz) - swell(p.xz)) * .4, .2, 1.);
  // The palette lies across the dunes in broad drifts, over a stretch of the gradient that each showing picks.
  vec3 albedo = mix(grad(uSeed + .01 * p.x + .006 * p.z + gnoise(p.xz * .04) * .18), uPal[4], .3);
  vec3 c = dim(albedo * sunLight(), lit * .55);
  // In shadow the sand shows mostly the sky's cool light, as in a photograph: a yellow there would turn olive.
  vec3 shade = mix(vec3(dot(albedo, vec3(.2126, .7152, .0722))), albedo, .3);
  c += shade * (zenith() * 3.4 + horizon() * .25) * (.35 + .65 * n.y) * trough * .75;
  // A sheen on the lit sand that shifts colour with the angle, as a thin film does, and light along the crests.
  float film = ndv * 1.6 + p.y * .12 + uTime * .004;
  c += mix(grad(film + .4), uPal[4], .45) * pow(max(dot(reflect(rd, n), sun), 0.), 12.) * lit * .5;
  c += sunLight() * pow(1. - ndv, 4.) * lit * .12;
  return aerial(c, rd, t);
}
vec3 scene(vec2 frag) {
  vec2 uv = (frag - .5 * uRes) / uRes.y;
  float z = uTime * .42 + uSeed * 400.;
  vec3 ro = vec3(sin(z * .04) * 7., 0., z);
  ro.y = (terrain(ro.xz) + terrain(ro.xz + vec2(0, 5))) * .5 + 1.5 + .25 * sin(uTime * .05);
  vec3 ta = vec3(sin((z + 7.) * .04) * 7. + 1.5 * sin(uTime * .013 + uSeed * 9.), ro.y - .5, z + 7.);
  vec3 rd = lookAt(ro, ta) * normalize(vec3(uv, 1.5));
  // Small steps: a height field isn't a distance field, and a long step would pass through a thin crest. The ray
  // also keeps its closest pass over a crest it went on beyond (a low point of its clearance, as an angle), for a
  // soft edge where a crest stands against the sky or against dunes further away.
  float t = .4, last = .4, near = 1e3, nearT = 0., lastA = 1e3, lastT = 0.;
  bool hit = false;
  for (int i = 0; i < 200; i++) {
    vec3 p = ro + rd * t;
    float h = p.y - terrain(p.xz);
    if (h < .0008 * t) { hit = true; break; }
    float a = h / t;
    if (a > lastA && lastA < near) { near = lastA; nearT = lastT; }
    lastA = a;
    lastT = t;
    last = t;
    t += max(h * .35, .005 * t);
    if (t > 110. || (p.y > 4.5 && rd.y >= 0.)) break;
  }
  if (!hit && lastA < near) { near = lastA; nearT = lastT; }
  if (hit) {
    for (int i = 0; i < 6; i++) {
      float m = (last + t) * .5;
      vec3 p = ro + rd * m;
      if (p.y - terrain(p.xz) < 0.) t = m; else last = m;
    }
  }
  float pixel = 1.3 / (uRes.y * 1.5);
  if (near < 2. * pixel) {
    // The closest pass, found more exactly than the steps did (golden-section search).
    float a = nearT * .85, b = nearT * 1.15;
    for (int i = 0; i < 8; i++) {
      float m1 = mix(a, b, .382), m2 = mix(a, b, .618);
      vec3 p1 = ro + rd * m1, p2 = ro + rd * m2;
      if ((p1.y - terrain(p1.xz)) / m1 < (p2.y - terrain(p2.xz)) / m2) b = m2; else a = m1;
    }
    nearT = (a + b) * .5;
    vec3 p = ro + rd * nearT;
    near = max((p.y - terrain(p.xz)) / nearT, 0.);
  }
  float edge = 1. - smoothstep(0., pixel, near);
  // A ray that runs out of steps below the horizon is looking at dunes too far off to see: haze, not the sky.
  vec3 col = hit ? sand(ro, rd, t) : mix(haze(rd), sky(rd), smoothstep(-.012, .012, rd.y));
  if (edge > 0.) col = mix(col, sand(ro, rd, nearT), edge);
  // Far dunes go soft, the near sand a little too; the middle distance and the sky stay sharp.
  float depth = edge > .5 ? nearT : t;
  if (hit || edge > .5) coc = smoothstep(16., 70., depth) * .65 + smoothstep(3.5, 1.2, depth) * .4;
  return col;
}
`;

/** Aurora: curtains of light over a still lake, under slowly turning stars. */
const aurora = `
// Directions are given as azimuth and elevation. The azimuth is measured from the camera's own heading and then
// turned with it, so it never jumps where atan wraps round behind the viewer.
float shore(float az) {
  return .004 + .045 * max(0., fbm(vec2(az * 2.6, 1.3), 3) + .05);
}
vec3 sky(float el) {
  float y = max(el, 0.);
  return uPal[0] * mix(.45, .08, smoothstep(0., .6, y)) + grad(.7) * .04 * exp(-y * 10.);
}
float stars(float az, float el, float t) {
  vec2 s = vec2(az, el) * 160.;
  vec2 cell = floor(s);
  float h = hash12(cell);
  if (h < .978) return 0.;
  float d = length(fract(s) - (hash22(cell + 7.) * .6 + .2));
  return smoothstep(.14, 0., d) * (.45 + .55 * sin(t * (.5 + h) + h * 90.)) * smoothstep(.02, .3, el);
}
// Curtains drawn on the sky as they look from the ground: a bright wavy foot, light that fades upward in fine
// vertical rays, and a faint glow under the foot. Nearer curtains (higher i) sit lower, wave more and move more as the
// camera turns.
vec3 curtains(float az, float el, float t) {
  vec3 acc = vec3(0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float x = az * (2.4 + fi * .6) + fi * 7.3;
    float foot = .3 - fi * .055 + .11 * fbm(vec2(x * .55 + t * .012 * (1. + fi * .4), fi * 3.1), 3);
    float d = el - foot;
    float up = d > 0. ? exp(-d * (9. + fi * 2.)) : exp(d * 70.);
    float streak = fbm(vec2(x * 1.6, t * .03 + fi), 2) * 4.;
    float rays = mix(1., .55 + .45 * smoothstep(-.5, .5, gnoise(vec2(x * 11. + streak, t * .04 + fi * 5.))), smoothstep(0., .04, d));
    float along = smoothstep(-.35, .45, gnoise(vec2(x * .7 - t * .01, fi * 9.)));
    vec3 c = mix(mix(grad(fi * .27 + .03), uPal[4], .25), grad(fi * .27 + .36), smoothstep(0., .3, d));
    acc += c * up * rays * along * (1. - fi * .15);
  }
  return acc * .6;
}
vec3 scene(vec2 frag) {
  vec2 uv = (frag - .5 * uRes) / uRes.y;
  float t = uTime + uSeed * 300.;
  float yaw = sin(uTime * .01 + uSeed * 6.) * .45 + uSeed * 6.283;
  vec3 rd = normalize(vec3(uv.x, uv.y + .2, 1.2));
  float az = atan(rd.x, rd.z) + yaw;
  float land = shore(az);
  float px = 1.2 / uRes.y;
  vec3 col;
  if (rd.y > 0.) {
    vec3 above = sky(rd.y) + curtains(az, rd.y, t) + uPal[4] * stars(az, rd.y, t) * .35;
    col = mix(uPal[0] * .06, above, smoothstep(land - px, land + px, rd.y));
  } else {
    // The lake: the sky mirrored, broken by ripples that fade towards the horizon.
    float far = smoothstep(-.02, -.25, rd.y);
    vec2 w = vec2(az * 3., 1. / max(-rd.y, .03)) * .4 + vec2(0, uTime * .03);
    vec2 ripple = vec2(gnoise(w * 2. + t * .06), gnoise(w * 2. + 9. - t * .05)) * .03 * far;
    float raz = az + ripple.x, rel = -rd.y + ripple.y;
    float fres = .15 + .4 * pow(1. + rd.y, 8.);
    col = mix(uPal[0] * .05, sky(rel) + curtains(raz, rel, t), smoothstep(land - px, land + px, rel)) * fres;
  }
  return col;
}
`;

/**
 * Ocean: open sea at the end of the day, the camera low over long swells. The sky is a cool blue overhead with thin
 * cloud lit warm towards a low sun; the water mirrors it, glitters where the sun catches it, and glows green-blue in
 * the crests the light passes through.
 */
const ocean = `
const vec3 SUN = vec3(.33, .1, .94);
// Narrow crests and wide troughs, as real swells have.
float swell(float x) { return exp(sin(x) - 1.); }
float sea(vec2 p, float t, bool detail) {
  p += .7 * vec2(noise3(vec3(p * .04, t * .015)), noise3(vec3(p * .04 + 4.1, t * .015)));
  float h = .5 * swell(dot(p, vec2(.94, .34)) * .3 + t * .5)
          + .3 * swell(dot(p, vec2(.62, -.78)) * .52 - t * .65)
          + .17 * swell(dot(p, vec2(-.2, .98)) * .9 + t * .85)
          + .09 * swell(dot(p, vec2(.85, .52)) * 1.55 - t * 1.2);
  if (detail) h += .05 * noise3(vec3(p * .9, t * .3)) + .025 * noise3(vec3(p * 2.2, t * .45 + 3.));
  return h - .45;
}
vec3 sunLight() { return mix(uPal[4], vec3(1., .74, .48), .45) * 3.; }
vec3 zenith() { return mix(vec3(.025, .07, .2), uPal[0], .12); }
// The haze along the horizon: pale and cool away from the sun, an evening orange and rose towards it.
vec3 horizon(vec3 rd) {
  vec3 warm = mix(uPal[4], vec3(1., .5, .28), .55);
  float toward = pow(max(dot(normalize(rd.xz), normalize(SUN.xz)), 0.), 2.);
  return mix(vec3(.42, .52, .7), warm, toward) * .5;
}
vec3 sky(vec3 rd) {
  float y = max(rd.y, 0.);
  float s = max(dot(rd, normalize(SUN)), 0.);
  vec3 hz = horizon(rd);
  vec3 col = mix(hz, zenith(), pow(smoothstep(0., .24, y), .7));
  // Thin high cloud, lit warm on the side towards the sun.
  vec2 cp = rd.xz / max(rd.y, .04) * .6 + vec2(uTime * .015, 0.);
  float cloud = smoothstep(.0, .5, fbm3(vec3(cp * .5, uTime * .004 + uSeed * 9.), 3) + .08) * smoothstep(.015, .12, y) * (1. - smoothstep(.3, .7, y));
  col = mix(col, mix(hz * 1.3, sunLight() * .3, pow(s, 3.)), cloud * .55);
  col += sunLight() * (smoothstep(.9993, .9998, s) * .7 + pow(s, 90.) * .22 + pow(s, 8.) * .08);
  return col + hz * exp(-y * 20.) * .3;
}
vec3 scene(vec2 frag) {
  vec2 uv = (frag - .5 * uRes) / uRes.y;
  float t = uTime + uSeed * 80.;
  float yaw = .12 * sin(uTime * .011 + uSeed * 6.) + uSeed * .3;
  vec3 ro = vec3(uTime * .3, 2.3 + .15 * sin(uTime * .07), uTime * 1.1);
  vec3 fwd = vec3(sin(yaw), -.04, cos(yaw));
  vec3 rd = lookAt(ro, ro + fwd) * normalize(vec3(uv, 1.6));
  vec3 col = sky(rd);
  if (rd.y < .02) {
    float d = .5, last = .5;
    bool hit = false;
    for (int i = 0; i < 110; i++) {
      vec3 p = ro + rd * d;
      float h = p.y - sea(p.xz, t, false);
      if (h < .002 * d) { hit = true; break; }
      last = d;
      d += max(h * .7, .01 * d);
      if (d > 260.) break;
    }
    if (hit) {
      for (int i = 0; i < 5; i++) {
        float m = (last + d) * .5;
        vec3 p = ro + rd * m;
        if (p.y - sea(p.xz, t, false) < 0.) d = m; else last = m;
      }
    }
    vec3 p = ro + rd * d;
    float e = .015 + .0025 * d;
    float h0 = sea(p.xz, t, true);
    vec3 n = normalize(vec3(h0 - sea(p.xz + vec2(e, 0), t, true), e, h0 - sea(p.xz + vec2(0, e), t, true)));
    // Far off the swells are smaller than a pixel: the surface flattens towards a mirror.
    n = normalize(mix(n, vec3(0, 1, 0), smoothstep(40., 220., d)));
    float ndv = clamp(dot(n, -rd), 0., 1.);
    float fres = .02 + .98 * pow(1. - ndv, 5.);
    vec3 r = reflect(rd, n);
    r.y = abs(r.y);
    vec3 sun = normalize(SUN);
    vec3 deep = mix(vec3(.002, .02, .045), uPal[0] * .2, .2);
    float crest = clamp(p.y + .45, 0., 1.2);
    vec3 through = vec3(.015, .09, .085) * sunLight() * crest * crest * .35 * (.4 + .6 * max(dot(rd.xz, sun.xz), 0.));
    vec3 water = mix(deep + through, sky(r), fres);
    water += sunLight() * pow(max(dot(r, sun), 0.), 900.) * 7.;
    water += horizon(rd) * smoothstep(.5, .75, crest + .12 * noise3(vec3(p.xz * 1.5, t * .4))) * .18;
    float haze = 1. - exp(-d * .006);
    col = mix(col, mix(water, horizon(rd) * 1.05 + sunLight() * pow(max(dot(rd, sun), 0.), 10.) * .1, haze), smoothstep(.02, -.004, rd.y));
  }
  return col;
}
`;

/**
 * Nebula: drifting slowly through glowing gas, with stars far behind and a few bright young stars inside it lighting
 * the gas around them.
 */
const nebula = `
// The camera's path: the gas keeps clear of it, so the camera passes between the clouds and sees them from a distance
// instead of flying through fog.
vec2 path(float z) { return vec2(sin(z * .04) * 1.5, cos(z * .031) * .8); }
// The glowing gas, in sheets and filaments (a ridged noise), and the dust that darkens it in lanes.
float gas(vec3 p) {
  float clearing = smoothstep(1.3, 4., length(p.xy - path(p.z)));
  vec3 q = p + 1.8 * vec3(noise3(p * .08), noise3(p * .08 + 5.2), noise3(p * .08 + 9.1));
  float n = fbm3(q * .26, 4);
  float ridge = 1. - abs(n * 2.6);
  return pow(smoothstep(.55, 1., ridge), 1.5) * smoothstep(-.2, .2, fbm3(q * .07 + 3., 2)) * clearing;
}
float dust(vec3 p) { return smoothstep(.05, .35, fbm3(p * .11 + 11., 3)); }
vec3 starAt(float i) {
  return vec3(sin(i * 1.7 + uSeed * 9.) * 3.5, cos(i * 2.3) * 2.2, i * 11. + 5.);
}
vec3 scene(vec2 frag) {
  vec2 uv = (frag - .5 * uRes) / uRes.y;
  float z = uTime * .42 + uSeed * 300.;
  vec3 ro = vec3(path(z), z);
  // The view wanders from straight ahead to the clouds on either side, so the clear path ahead is rarely in the middle.
  vec3 ta = vec3(path(z + 4.) + vec2(sin(uTime * .02 + uSeed * 6.) * 2.6, cos(uTime * .016 + uSeed * 3.) * 1.3), z + 4.);
  vec3 rd = lookAt(ro, ta) * normalize(vec3(uv, 1.3));
  // Stars far away, beyond the gas.
  vec2 sp = vec2(atan(rd.x, rd.z), rd.y) * 220.;
  float sh = hash12(floor(sp));
  float stars = sh > .985 ? smoothstep(.16, 0., length(fract(sp) - hash22(floor(sp) + 3.) * .6 - .2)) * (sh - .985) * 60. : 0.;
  vec3 col = uPal[4] * stars * .25 + uPal[0] * .25 * (1. - abs(uv.y));
  // Through the gas, front to back: what each step glows, dimmed by what lies in front of it.
  vec3 glow = vec3(0);
  float clear = 1.;
  float d = .3 + hash12(frag) * .35;
  for (int i = 0; i < 48; i++) {
    vec3 p = ro + rd * d;
    float g = gas(p), k = dust(p) * smoothstep(1.3, 4., length(p.xy - path(p.z)));
    float dt = .32 + d * .02;
    if (g > .005 || k > .01) {
      vec3 c = mix(grad(noise3(p * .05) * .7 + .5 + uSeed), uPal[4], pow(g, 2.) * .6);
      // Near gas glows clearer than far gas, which the eye reads as depth rather than fog.
      glow += clear * c * g * dt * (.4 + 1.1 * g) * exp(-d * .05);
      clear *= exp(-(g * .3 + k * 1.1) * dt);
      if (clear < .03) break;
    }
    d += dt;
  }
  col = col * clear + glow;
  // Young stars inside the gas, seen through what lies in front of them.
  float base = floor(ro.z / 11.);
  for (int i = 0; i < 3; i++) {
    vec3 s = starAt(base + float(i)) - ro;
    float along = dot(s, rd);
    if (along < 0.) continue;
    float off = length(s - rd * along) / along;
    col += mix(uPal[4], grad(base + float(i) * .37), .3) * (exp(-off * 90.) * .9 + exp(-off * 12.) * .12) * smoothstep(40., 8., along);
  }
  return col;
}
`;

/**
 * Gallery: the player's covers, standing in a dark room in a row that never ends, the camera moving slowly along it.
 * A glossy floor mirrors them, a light passes over them now and then, and the ones further off go out of focus.
 */
const gallery = `
const float SLOTS = 8., GAP = 1.5;
const vec2 HALF = vec2(.5, .75);
float camX() { return uTime * .2 + uSeed * 40.; }
// A slot of the row: where its cover stands, which way it turns, and which cover it shows. The row wraps round the
// camera, so a slot that falls behind comes back ahead with the next cover.
void slot(float i, out vec3 c, out float yaw, out float cover) {
  float span = SLOTS * GAP;
  float x = i * GAP;
  float lap = floor((camX() - x + span * .5) / span);
  x += lap * span;
  c = vec3(x, .07 * sin(uTime * .21 + i * 1.7), .55 * sin(i * 2.4 + 1.3));
  yaw = .3 * sin(i * 1.9 + uTime * .04);
  cover = mod(i + lap * SLOTS, max(uArtInfo.x, 1.));
}
float roundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r;
}
// The nearest cover along a ray: its distance, how much of the pixel it covers, and where on it the ray lands.
float hitCover(vec3 ro, vec3 rd, float px, out vec2 local, out float cover, out float yawOut, out float covered) {
  float best = 1e3;
  covered = 0.;
  for (float i = 0.; i < SLOTS; i++) {
    vec3 c; float yaw, k;
    slot(i, c, yaw, k);
    vec3 n = vec3(sin(yaw), 0., -cos(yaw));
    float den = dot(rd, n);
    if (abs(den) < 1e-3) continue;
    float t = dot(c - ro, n) / den;
    if (t < .1 || t > best) continue;
    vec3 p = ro + rd * t - c;
    vec2 l = vec2(dot(p, vec3(cos(yaw), 0., sin(yaw))), p.y);
    float d = roundRect(l, HALF, .045);
    float a = 1. - smoothstep(-px * t, px * t, d);
    if (a > .001) { best = t; local = l; cover = k; yawOut = yaw; covered = a; }
  }
  return best;
}
vec3 art(vec2 l, float cover, float lod) {
  vec2 cells = uArtInfo.yz;
  vec2 cell = vec2(mod(cover, cells.x), floor(cover / cells.x));
  // The camera's frame (lookAt) has x running to the left, so the image's left is at +x.
  vec2 f = clamp(vec2(.5 - l.x / (2. * HALF.x), .5 - l.y / (2. * HALF.y)), .004, .996);
  return textureLod(uArt, (cell + f) / cells, lod).rgb;
}
float sweep() { return camX() + 3.4 * sin(uTime * .085 + uSeed * 4.); }
vec3 coverLight(vec3 p, vec2 l, float yaw, vec3 rd, vec3 a) {
  vec3 n = vec3(sin(yaw), 0., -cos(yaw));
  float ndv = abs(dot(n, rd));
  float s = (p.x - sweep()) + .45 * p.y;
  float band = exp(-s * s * 5.);
  vec3 c = a * (.62 + .38 * max(dot(n, normalize(vec3(-.4, .5, -1.))), 0.));
  c += uPal[4] * band * (.1 + .45 * pow(1. - ndv, 2.));
  // A thin bright edge, as round a print in a light box.
  return c + uPal[4] * smoothstep(-.02, 0., roundRect(l, HALF, .045)) * .25;
}
vec3 room(vec2 uv) {
  vec3 col = uPal[0] * (.16 + .2 * exp(-uv.y * uv.y * 4.));
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(uTime * .03 + fi * 2.1) * .9, .25 + .2 * cos(uTime * .021 + fi * 1.3));
    col += grad(fi * .21 + uSeed) * exp(-dot(uv - c, uv - c) * 9.) * .05;
  }
  return col;
}
vec3 scene(vec2 frag) {
  vec2 uv = (frag - .5 * uRes) / uRes.y;
  vec3 ro = vec3(camX(), .15 + .05 * sin(uTime * .07), -5.1);
  vec3 rd = lookAt(ro, vec3(camX() - .35, -.12, 0.)) * normalize(vec3(uv, 1.65));
  float px = 1.3 / (uRes.y * 1.65);
  float texels = 576. / (2. * HALF.y);
  vec3 col = room(uv);
  coc = .8;
  vec2 l; float cover, yaw, covered;
  float t = hitCover(ro, rd, px, l, cover, yaw, covered);
  float floorT = rd.y < 0. ? (-1.02 - ro.y) / rd.y : 1e3;
  if (floorT < t) {
    // The floor: dark and glossy, mirroring the covers a little blurred, and catching the passing light.
    vec3 p = ro + rd * floorT;
    vec3 r = vec3(rd.x, -rd.y, rd.z);
    float fres = .05 + .55 * pow(1. - abs(rd.y), 6.);
    col = mix(uPal[0] * .08, room(uv), smoothstep(6., 22., floorT));
    vec2 l2; float c2, y2, a2;
    float t2 = hitCover(p, r, px * 3., l2, c2, y2, a2);
    if (t2 < 1e3) {
      vec3 q = p + r * t2;
      float lod = log2(max((floorT + t2) * px * texels, 1.)) + 2.;
      col += coverLight(q, l2, y2, r, art(l2, c2, lod)) * a2 * fres * exp(-t2 * .8);
    }
    float s = p.x - sweep();
    col += uPal[4] * exp(-s * s * 2.) * .04 * (1. - smoothstep(3., 12., floorT));
    coc = clamp(abs(floorT - 5.2) * .16, 0., .8);
  }
  if (t < floorT && t < 1e3) {
    vec3 p = ro + rd * t;
    float lod = log2(max(t * px * texels, 1.));
    col = mix(col, coverLight(p, l, yaw, rd, art(l, cover, lod)), covered);
    coc = clamp(abs(t - 5.2) * .2, 0., .85) * covered + coc * (1. - covered);
  }
  return col;
}
`;

/**
 * Drift: the player's hero art, slowly panning, comes apart into thousands of points of light that swirl across the
 * screen and settle into another game's hero art. Each point keeps a pixel of the first picture's colour and takes
 * on the second's as it flies.
 */
const DRIFT_GRID = [160, 90];
const driftLib = `
const vec2 GRID = vec2(${DRIFT_GRID[0]}., ${DRIFT_GRID[1]}.);
// The picture covering the screen, slowly zooming and panning; uv runs 0 to 1 across the screen, y down.
vec2 kenBurns(vec2 uv, float aspect, float k) {
  float screen = uRes.x / uRes.y;
  vec2 fit = aspect > screen ? vec2(screen / aspect, 1.) : vec2(1., aspect / screen);
  float zoom = 1.1 + .06 * sin(uTime * .031 + k * 1.7);
  vec2 pan = .04 * vec2(sin(uTime * .023 + k * 2.1), cos(uTime * .019 + k));
  return .5 + (uv - .5) * fit / zoom + pan * fit;
}
// When the point at uv leaves, 0 to .5 of the change: a slow sweep across the picture, broken up by noise.
float leaves(vec2 uv) {
  float sweep = .6 * (uv.x * .75 + (1. - uv.y) * .25);
  return .5 * clamp(sweep + .4 * (noise3(vec3(uv * 3.2, uArtInfo.w * 7.3)) * .5 + .5), 0., 1.);
}
`;
const drift = `
vec3 scene(vec2 frag) {
  vec2 uv = vec2(frag.x / uRes.x, 1. - frag.y / uRes.y);
  float s = uArtInfo.x, k = uArtInfo.w;
  vec3 a = texture(uArt, kenBurns(uv, uArtInfo.y, k)).rgb;
  vec3 b = texture(uArt2, kenBurns(uv, uArtInfo.z, k + 1.)).rgb;
  vec2 q = uv - .5;
  vec3 col = uPal[0] * .2 * (1. - dot(q, q));
  col = mix(col, a, 1. - smoothstep(leaves(uv), leaves(uv) + .04, s));
  return mix(col, b, smoothstep(.9, 1., s));
}
`;
const driftParticles = {
  count: DRIFT_GRID[0] * DRIFT_GRID[1],
  vertex: `
out vec3 vColor;
out vec2 vCorner;
out float vAlpha;
void main() {
  int id = gl_InstanceID;
  vec2 home = (vec2(id % int(GRID.x), id / int(GRID.x)) + .5) / GRID;
  // Where it lands: anywhere, so the points cross the screen and the new picture forms as a scatter rather than in
  // rows or columns (a shuffle of the grid that is linear keeps whole columns together).
  vec2 there = hash22(vec2(float(id) * .7311, 9.13));
  float s = uArtInfo.x, k = uArtInfo.w;
  // Each point leaves a little before or after its neighbours, and wanders off its cell, so no rows show.
  vec2 r = hash22(vec2(float(id), 3.7));
  float q = clamp((s - leaves(home) - r.x * .07) / .45, 0., 1.);
  float e = q * q * (3. - 2. * q);
  float lift = sin(3.14159 * e);
  vec2 swirl = vec2(noise3(vec3(home * 1.6, uTime * .06)), noise3(vec3(home * 1.6 + 7., uTime * .06)));
  vec2 pos = mix(home, there, e) + (swirl * .34 + (r - .5) * .12) * lift + vec2(0., -.05) * lift;
  vec3 a = texture(uArt, kenBurns(home, uArtInfo.y, k)).rgb;
  vec3 b = texture(uArt2, kenBurns(there, uArtInfo.z, k + 1.)).rgb;
  vColor = mix(a, b, smoothstep(.25, .75, e)) * (1. + 2.2 * lift);
  vAlpha = step(.0001, q) * (1. - smoothstep(.9, 1., s)) * (1. - .45 * lift);
  int v = gl_VertexID;
  vCorner = vec2(v == 1 || v == 4 || v == 5 ? 1. : -1., v == 2 || v == 3 || v == 5 ? 1. : -1.);
  vec2 size = (2. - 1.2 * lift) / GRID;
  vec2 ndc = vec2(pos.x, 1. - pos.y) * 2. - 1.;
  gl_Position = vec4(ndc + vCorner * size, 0., 1.);
}
`,
  fragment: `
in vec3 vColor;
in vec2 vCorner;
in float vAlpha;
void main() {
  float a = vAlpha * smoothstep(1., .35, length(vCorner));
  fragColor = vec4(vColor * a, a);
}
`,
};

/** @type {Scene[]} */
export const SCENES = [
  { id: 'dunes', name: 'Dunes', mood: 'day', source: dunes },
  { id: 'gallery', name: 'Gallery', mood: 'night', source: gallery, needs: 'covers' },
  { id: 'ocean', name: 'Ocean', mood: 'day', source: ocean },
  { id: 'drift', name: 'Drift', mood: 'night', source: drift, lib: driftLib, particles: driftParticles, needs: 'heroes', heroes: driftCycle },
  { id: 'ink', name: 'Ink', mood: 'night', source: ink },
  { id: 'nebula', name: 'Nebula', mood: 'night', source: nebula },
  { id: 'aurora', name: 'Aurora', mood: 'night', source: aurora },
];

/** Drift's timing: each hero image holds this long, in seconds, then takes this long to become the next one. */
export const DRIFT = { hold: 22, change: 10 };

/**
 * Which two of `count` hero images Drift shows at `time`, and how far it has gone from the first to the second
 * (0 while it holds, 0 to 1 during the change).
 * @param {number} time @param {number} count
 */
export function driftCycle(time, count) {
  const length = DRIFT.hold + DRIFT.change;
  const cycle = Math.floor(Math.max(0, time) / length);
  const local = Math.max(0, time) - cycle * length;
  return { a: cycle % count, b: (cycle + 1) % count, mix: Math.min(1, Math.max(0, (local - DRIFT.hold) / DRIFT.change)), cycle };
}

/**
 * The scenes a show can use: all of them but those whose art isn't there (Gallery needs covers, Drift two hero
 * images).
 * @param {{ covers: boolean, heroes: number }} have
 */
export function scenesFor(have) {
  return SCENES.filter((s) => (s.needs !== 'covers' || have.covers) && (s.needs !== 'heroes' || have.heroes >= 2));
}

/**
 * The scenes in a new shuffled order (Fisher-Yates) that doesn't start with `current`, so one scene never follows
 * itself when the order comes round again.
 * @param {Scene[]} scenes
 * @param {Scene | null | undefined} current
 * @param {() => number} [random]
 */
export function nextOrder(scenes, current, random = Math.random) {
  const order = [...scenes];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (order.length > 1 && order[0] === current) order.push(/** @type {Scene} */ (order.shift()));
  return order;
}

/**
 * Whether the game's logo or name drifts over the scene. Not over Gallery and Drift: they show the game's own covers
 * and hero art, where a logo crossing another game's cover reads as a glitch.
 * @param {Scene} scene
 */
export const showsMark = (scene) => !scene.needs;

/** A scene's whole fragment shader. @param {Scene} scene */
export const fragmentSource = (scene) => COMMON + (scene.lib ?? '') + scene.source + MAIN;

/** The vertex and fragment shaders of a scene's particles, null when it has none. @param {Scene} scene */
export function particleSources(scene) {
  if (!scene.particles) return null;
  const head = `#version 300 es${SHARED}${scene.lib ?? ''}`;
  return { vertex: head + scene.particles.vertex, fragment: `${head}out vec4 fragColor;\n${scene.particles.fragment}` };
}

