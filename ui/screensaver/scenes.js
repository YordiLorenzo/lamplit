// @ts-check
// The screensaver's scenes, each a WebGL2 fragment shader that draws one frame from the time and a palette. They
// write linear light into a buffer smaller than the screen; renderer.js scales it up, blends two scenes during a
// change, keeps the brightness down and adds the grain.

/**
 * @typedef {object} Scene
 * @property {string} id
 * @property {string} name  as the preview shows it
 * @property {'2d' | '3d'} kind
 * @property {string} source  GLSL that defines `vec3 scene(vec2 frag)`
 */

/**
 * What every scene gets: the buffer's size in pixels, seconds since the scene began, a number from 0 to 1 that makes
 * each showing different, the palette in linear light (0 deep, 1 to 3 main, 4 light) and the main colours as a
 * looping gradient (palette.js gradient). Then hashes without sin (Dave Hoskins), which stay stable on every GPU, and
 * gradient noise.
 */
export const COMMON = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 uRes;
uniform float uTime;
uniform float uSeed;
uniform vec3 uPal[5];
uniform sampler2D uGrad;
out vec4 fragColor;

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
mat3 lookAt(vec3 ro, vec3 ta) {
  vec3 w = normalize(ta - ro);
  vec3 u = normalize(cross(w, vec3(0, 1, 0)));
  return mat3(u, cross(u, w), w);
}
`;

const MAIN = `
void main() { fragColor = vec4(max(scene(gl_FragCoord.xy), 0.), 1.); }
`;

/** Silk: colour draped like satin in long folds, bent by domain warping and lit by a light that wanders. */
const silk = `
vec2 warp(vec2 uv, float t) {
  vec2 q = vec2(fbm(uv * .8 + vec2(0., t), 3), fbm(uv * .8 + vec2(5.2, 1.3 - t * .8), 3));
  return vec2(fbm(uv * .7 + 1.4 * q + vec2(1.7 + t * .6, 9.2), 3), fbm(uv * .7 + 1.4 * q + vec2(8.3, 2.8 - t * .5), 3));
}
// Long folds across the cloth, bent by the warp into flowing curves.
float folds(vec2 uv, float t) {
  vec2 r = warp(uv, t);
  vec2 w = uv + .9 * r;
  return .6 * sin(dot(w, vec2(1.2, .5)) * 3.2 + 2.2 * r.y + t * 1.5);
}
vec3 scene(vec2 frag) {
  vec2 uv = (frag - .5 * uRes) / uRes.y;
  float t = uTime * .03 + uSeed * 37.;
  vec2 r = warp(uv, t);
  // The colour runs along the gradient across the cloth, so neighbouring colours blend in OKLab (palette.js)
  // instead of averaging to grey.
  vec3 base = grad(.45 * uv.x + .25 * uv.y + .7 * r.x - .45 * r.y + t * .12);
  // The folds' slope, a pixel or two to each side, for the light.
  float e = 1.5 / uRes.y;
  float h = folds(uv, t);
  vec2 slope = vec2(folds(uv + vec2(e, 0), t) - h, folds(uv + vec2(0, e), t) - h) / e;
  vec3 n = normalize(vec3(-slope * .3, 1.));
  vec3 l = normalize(vec3(cos(t * 2.1) * .7, .5 + sin(t * 1.6) * .4, .6));
  float lit = smoothstep(-.7, 1., dot(n, l));
  // A broad pool of light that wanders, and the deep tone in the valleys of the folds.
  vec2 spot = vec2(.55 * sin(t * 1.3), .3 * cos(t * 1.7));
  float pool = .55 + .6 * exp(-dot(uv - spot, uv - spot) * 1.6);
  vec3 col = mix(uPal[0], base, .15 + .85 * lit) * (.18 + .95 * lit) * pool;
  // Satin: a sheen that runs along the folds.
  float nh = max(dot(n, normalize(l + vec3(0, 0, 1))), 0.);
  col += mix(base, uPal[4], .5) * (pow(nh, 10.) * .25 + pow(nh, 40.) * .3) * pool;
  return col;
}
`;

/** Waves: layers of soft bands, back to front, each casting a shadow on the one behind it. */
const waves = `
vec3 scene(vec2 frag) {
  vec2 uv = frag / uRes;
  float aspect = uRes.x / uRes.y;
  float x = uv.x * aspect;
  float t = uTime * .045 + uSeed * 19.;
  vec3 col = mix(uPal[0] * .7, grad(t * .2 + .1) * .45, uv.y * .8);
  float px = 1.5 / uRes.y;
  const int N = 7;
  for (int i = 0; i < N; i++) {
    float fi = float(i) / float(N - 1);
    float base = .98 - fi * .82;
    float edge = base
      + .085 * sin(x * (1.05 + fi * .5) + t * (1. + fi * .7) + fi * 5.1)
      + .045 * sin(x * (2.2 - fi * .6) - t * 1.4 + fi * 2.3)
      + .05 * gnoise(vec2(x * .7 + t * .6, fi * 7.3 + t * .1));
    float d = edge - uv.y;
    // The band in front darkens what lies just above its edge.
    col *= 1. - .42 * exp(min(d, 0.) * 22.) * step(d, 0.);
    vec3 band = grad(fi * .55 + x * .07 + t * .12) * mix(.42, 1., fi);
    // Lit along its top edge, darker further down.
    band *= mix(1.05, .62, smoothstep(0., .3, d));
    band += uPal[4] * exp(-max(d, 0.) * 55.) * .16 * (.4 + .6 * fi);
    col = mix(col, band, smoothstep(-px, px, d));
  }
  return col;
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

/** Dunes: an iridescent landscape under a slow camera, its colour shifting with the angle it is seen at. */
const dunes = `
float terrain(vec2 p) {
  vec2 b = p + 5. * vec2(gnoise(p * .06), gnoise(p * .05 + 3.1));
  float ridge = 1. - abs(sin(b.x * .19 + b.y * .05));
  return ridge * ridge * 1.6 + gnoise(p * .09) * 2.6 + gnoise(p * .27 + 7.) * .35;
}
float ripples(vec2 p) { return terrain(p) + gnoise(p * vec2(2.1, .8)) * .03; }
vec3 sunDir() { return normalize(vec3(-.75, .22, .62)); }
vec3 sky(vec3 rd) {
  float y = max(rd.y, 0.);
  float s = max(dot(rd, sunDir()), 0.);
  vec3 col = mix(grad(.62) * .55 + uPal[4] * .06, uPal[0] * .3, pow(y, .5));
  return col + mix(grad(.62), uPal[4], .5) * (pow(s, 120.) * .5 + pow(s, 8.) * .22);
}
vec3 scene(vec2 frag) {
  vec2 uv = (frag - .5 * uRes) / uRes.y;
  float z = uTime * .45 + uSeed * 400.;
  vec3 ro = vec3(sin(z * .04) * 7., 0., z);
  ro.y = (terrain(ro.xz) + terrain(ro.xz + vec2(0, 5))) * .5 + 1.5;
  vec3 ta = vec3(sin((z + 7.) * .04) * 7., ro.y - .55, z + 7.);
  vec3 rd = lookAt(ro, ta) * normalize(vec3(uv, 1.5));
  // Small steps: a height field isn't a distance field, and a long step would pass through a thin crest.
  float t = .4, last = .4;
  // The ray's closest pass over the terrain, as an angle, for a soft edge where a crest meets the sky.
  float near = 1e3, nearT = 0.;
  bool hit = false;
  for (int i = 0; i < 160; i++) {
    vec3 p = ro + rd * t;
    float d = p.y - terrain(p.xz);
    if (d < .001 * t) { hit = true; break; }
    if (d / t < near) { near = d / t; nearT = t; }
    last = t;
    t += max(d * .3, .01 * t);
    // Above the highest the terrain reaches and still climbing: only sky lies ahead.
    if (t > 90. || (p.y > 4.5 && rd.y >= 0.)) break;
  }
  if (hit) {
    for (int i = 0; i < 5; i++) {
      float m = (last + t) * .5;
      vec3 p = ro + rd * m;
      if (p.y - terrain(p.xz) < 0.) t = m; else last = m;
    }
  }
  vec3 col = sky(rd);
  // A miss that passed within a pixel of a crest is shaded there and blended into the sky.
  float pixel = 1.5 / uRes.y;
  float cover = hit ? 1. : 1. - smoothstep(0., pixel, near);
  if (!hit && cover > 0.) t = nearT;
  if (cover > 0.) {
    vec3 p = ro + rd * t;
    float e = .01 + .0015 * t;
    vec3 n = normalize(vec3(ripples(p.xz - vec2(e, 0)) - ripples(p.xz + vec2(e, 0)), 2. * e,
                            ripples(p.xz - vec2(0, e)) - ripples(p.xz + vec2(0, e))));
    float ndv = clamp(dot(n, -rd), 0., 1.);
    float dif = clamp(dot(n, sunDir()), 0., 1.);
    // Thin-film colour, as on a soap bubble: it moves with the viewing angle as the camera glides.
    float film = ndv * 1.8 + p.y * .16 + gnoise(p.xz * .1) * .35 + uTime * .004;
    vec3 c = grad(film) * (.05 + 1.2 * pow(dif, 1.5)) + uPal[0] * .4 * (.4 + .6 * n.y);
    c += mix(grad(film + .5), uPal[4], .4) * pow(clamp(dot(reflect(rd, n), sunDir()), 0., 1.), 18.) * .55;
    c += grad(film + .33) * pow(1. - ndv, 5.) * .5;
    col = mix(col, mix(c, col, 1. - exp(-.00022 * t * t)), cover);
  }
  return col;
}
`;

/** Forms: soft shapes that drift, meet and melt into each other, coloured by the way each part faces. */
const forms = `
float T;
float smin(float a, float b, float k) {
  float h = clamp(.5 + .5 * (b - a) / k, 0., 1.);
  return mix(b, a, h) - k * h * (1. - h);
}
float map(vec3 p) {
  float d = 1e3;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    vec3 c = vec3(sin(T * (.31 + .05 * fi) + fi * 1.3) * 1.6,
                  cos(T * (.23 + .04 * fi) + fi * 2.1) * .9,
                  sin(T * (.19 + .03 * fi) + fi * .7) * 1.1);
    d = smin(d, length(p - c) - (.52 + .17 * sin(fi * 1.7 + T * .4)), .8);
  }
  return d;
}
vec3 scene(vec2 frag) {
  vec2 uv = (frag - .5 * uRes) / uRes.y;
  T = uTime * .11 + uSeed * 50.;
  float a = uTime * .018 + uSeed * 6.283;
  vec3 ro = vec3(sin(a) * 6., .8 * sin(uTime * .011 + uSeed * 3.), cos(a) * 6.);
  vec3 rd = lookAt(ro, vec3(0)) * normalize(vec3(uv, 1.7));
  vec3 col = uPal[0] * (.38 + .5 * exp(-dot(uv, uv) * 2.2));
  float t = 0., halo = 0.;
  bool hit = false;
  for (int i = 0; i < 90; i++) {
    float d = map(ro + rd * t);
    halo += exp(-d * 2.6);
    if (d < .001) { hit = true; break; }
    t += d;
    if (t > 14.) break;
  }
  col += grad(T * .05 + uv.x * .1) * halo * .009;
  if (hit) {
    vec3 p = ro + rd * t;
    vec2 k = vec2(1, -1) * .0015;
    vec3 n = normalize(k.xyy * map(p + k.xyy) + k.yyx * map(p + k.yyx) + k.yxy * map(p + k.yxy) + k.xxx * map(p + k.xxx));
    float ndv = clamp(dot(n, -rd), 0., 1.);
    vec3 l = normalize(vec3(.6, .7, -.4));
    float g = dot(n, normalize(vec3(.4, .8, .3))) * .38 + .5 + p.y * .08 + T * .03;
    vec3 body = grad(g) * (.2 + .8 * clamp(dot(n, l), 0., 1.)) + uPal[0] * .2;
    body += uPal[4] * pow(clamp(dot(reflect(rd, n), l), 0., 1.), 42.) * .55;
    col = mix(body, grad(g + .33) * 1.15, pow(1. - ndv, 3.) * .85);
  }
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

/** @type {Scene[]} */
export const SCENES = [
  { id: 'silk', name: 'Silk', kind: '2d', source: silk },
  { id: 'dunes', name: 'Dunes', kind: '3d', source: dunes },
  { id: 'waves', name: 'Waves', kind: '2d', source: waves },
  { id: 'forms', name: 'Forms', kind: '3d', source: forms },
  { id: 'ink', name: 'Ink', kind: '2d', source: ink },
  { id: 'aurora', name: 'Aurora', kind: '3d', source: aurora },
];

/** A scene's whole fragment shader. @param {Scene} scene */
export const fragmentSource = (scene) => COMMON + scene.source + MAIN;
