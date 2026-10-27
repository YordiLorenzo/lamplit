// @ts-check
// The screensaver's scenes, each a WebGL2 fragment shader that draws one frame from the time and a palette. They
// write linear light into a buffer smaller than the screen, and how far out of focus each pixel is; renderer.js does
// the rest (focus blur, blends between scenes, bloom, tone mapping, grain).

/**
 * @typedef {object} Scene
 * @property {string} id
 * @property {string} name  as the preview shows it
 * @property {'2d' | '3d'} kind
 * @property {import('./palette.js').Mood} mood  which way palette.js forMood adapts the palette
 * @property {string} source  GLSL that defines `vec3 scene(vec2 frag)`, and may set `coc`
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
`;

const MAIN = `
void main() {
  vec3 c = max(scene(gl_FragCoord.xy), 0.);
  fragColor = vec4(c, clamp(coc, 0., 1.));
}
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
  vec3 col = dim(mix(uPal[0], base, .15 + .85 * lit), (.18 + .95 * lit) * pool);
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
  vec3 col = mix(uPal[0] * .7, dim(grad(t * .2 + .1), .45), uv.y * .8);
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
    vec3 band = dim(grad(fi * .55 + x * .07 + t * .12), mix(.42, 1., fi));
    // Lit along its top edge, darker further down.
    band = dim(band, mix(1.05, .62, smoothstep(0., .3, d)));
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

/** Forms: soft shapes that drift, meet and melt into each other, glossy, coloured by the way each part faces. */
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
    vec3 c = vec3(sin(T * (.31 + .05 * fi) + fi * 1.3) * 1.35,
                  cos(T * (.23 + .04 * fi) + fi * 2.1) * .75,
                  sin(T * (.19 + .03 * fi) + fi * .7) * 1.3);
    d = smin(d, length(p - c) - (.52 + .17 * sin(fi * 1.7 + T * .4)), .8);
  }
  return d;
}
// What a glossy surface mirrors: a soft studio, light above and the deep tone below, with two broad lights.
vec3 studio(vec3 r) {
  vec3 col = mix(uPal[0] * .6, grad(.3 + r.x * .15) * .35, smoothstep(-.4, .8, r.y));
  col += uPal[4] * pow(max(dot(r, normalize(vec3(.5, .8, -.3))), 0.), 24.) * 1.6;
  col += grad(.7) * pow(max(dot(r, normalize(vec3(-.8, .2, -.4))), 0.), 10.) * .5;
  return col;
}
vec3 scene(vec2 frag) {
  vec2 uv = (frag - .5 * uRes) / uRes.y;
  T = uTime * .1 + uSeed * 50.;
  float a = uTime * .016 + uSeed * 6.283;
  vec3 ro = vec3(sin(a) * 6.2, .8 * sin(uTime * .011 + uSeed * 3.), cos(a) * 6.2);
  vec3 rd = lookAt(ro, vec3(0)) * normalize(vec3(uv, 1.8));
  vec3 col = uPal[0] * (.3 + .55 * exp(-dot(uv, uv) * 2.));
  float t = 0., halo = 0.;
  bool hit = false;
  for (int i = 0; i < 90; i++) {
    float d = map(ro + rd * t);
    halo += exp(-d * 2.6);
    if (d < .001) { hit = true; break; }
    t += d;
    if (t > 16.) break;
  }
  col += grad(T * .05 + uv.x * .1) * halo * .008;
  if (hit) {
    vec3 p = ro + rd * t;
    vec2 k = vec2(1, -1) * .0015;
    vec3 n = normalize(k.xyy * map(p + k.xyy) + k.yyx * map(p + k.yyx) + k.yxy * map(p + k.yxy) + k.xxx * map(p + k.xxx));
    float ndv = clamp(dot(n, -rd), 0., 1.);
    vec3 l = normalize(vec3(.6, .7, -.4));
    // A narrow stretch of the gradient across each form, drifting slowly: two neighbouring colours, not a rainbow.
    float g = dot(n, normalize(vec3(.4, .8, .3))) * .14 + p.x * .06 + p.y * .03 + T * .02 + uSeed;
    // A soft body lit from above, light that seems to pass through its thin edges, and a clear coat that mirrors.
    vec3 body = grad(g) * (.12 + .7 * max(dot(n, l), 0.) + .25 * (.5 + .5 * n.y));
    body += grad(g + .12) * pow(1. - ndv, 2.) * .55;
    float fres = .04 + .96 * pow(1. - ndv, 5.);
    col = body + studio(reflect(rd, n)) * mix(.12, 1., fres);
    coc = smoothstep(.4, 3., abs(t - 6.2)) * .8;
  }
  return col;
}
`;

/**
 * Glass: clear forms that turn slowly in front of soft coloured light. Each bends the light behind it, splitting it a
 * little into colours at the edges, and mirrors the room with a thin film's colours; the background is out of focus.
 */
const glass = `
float T;
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float torus(vec3 p, vec2 r) { return length(vec2(length(p.xz) - r.x, p.y)) - r.y; }
float roundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.)) + min(max(q.x, max(q.y, q.z)), 0.) - r;
}
float map(vec3 p) {
  vec3 a = p - vec3(-1.55 + .2 * sin(T * .3), .3 * sin(T * .4), .2);
  a.xz *= rot(T * .21);
  a.xy *= rot(T * .17 + 1.);
  float d = torus(a, vec2(.78, .27));
  vec3 b = p - vec3(1.5, -.2 + .2 * cos(T * .35), .5);
  b.yz *= rot(T * .19);
  b.xy *= rot(T * .13 + .4);
  d = min(d, roundBox(b, vec3(.42), .2));
  vec3 c = p - vec3(.15 * sin(T * .2), 1. + .15 * sin(T * .5), 1.7);
  return min(d, length(c) - .48);
}
vec3 normalAt(vec3 p) {
  vec2 k = vec2(1, -1) * .0015;
  return normalize(k.xyy * map(p + k.xyy) + k.yyx * map(p + k.yyx) + k.yxy * map(p + k.yxy) + k.xxx * map(p + k.xxx));
}
// The light behind the glass: the deep tone, three slow pools of colour and one thin bright line, far away. Directions
// map onto it stereographically, which is smooth for any direction the glass bends the light into (a division by z,
// clamped, would draw a hard outline where the clamp starts).
vec3 backdrop(vec3 rd) {
  vec2 q = 2. * rd.xy / (1. + max(rd.z, -.9));
  vec3 col = uPal[0] * mix(1.1, .35, smoothstep(-.7, .9, q.y));
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(T * .13 + fi * 2.1) * .95, cos(T * .11 + fi * 1.7) * .5);
    vec2 d = q - c;
    col += uPal[i + 1] * exp(-dot(d, d) * 5.5) * .65;
  }
  float line = abs(q.y - .02 - .16 * sin(q.x * 1.3 + T * .25));
  return col + uPal[4] * smoothstep(.014, 0., line) * .32;
}
// What the glass mirrors: the backdrop, and two soft studio lights.
vec3 room(vec3 r) {
  return backdrop(r) * .6 + uPal[4] * (pow(max(dot(r, normalize(vec3(-.5, .7, -.5))), 0.), 60.) * 6.
                                      + pow(max(dot(r, normalize(vec3(.8, .3, -.4))), 0.), 16.) * .9);
}
// The glass at p, seen along rd, as thick glass: the light behind is bent by the front surface alone, by more than
// one thin surface would bend it, and each colour a little differently. The front surface is smooth everywhere, so the
// bending is too: following the light out through the back would show the back's bevels as a second, offset form,
// and where light can't leave (total internal reflection) the picture would jump.
vec3 glassAt(vec3 p, vec3 rd) {
  vec3 n = normalAt(p);
  // Never quite edge-on: at a grazing angle the normal changes from one pixel to the next and the rim would sparkle.
  float ndv = clamp(dot(n, -rd), .08, 1.);
  float fres = .04 + .96 * pow(1. - ndv, 5.);
  vec3 bend = (refract(rd, n, 1. / 1.45) - rd) * 2.4;
  vec3 through;
  for (int c = 0; c < 3; c++) through[c] = backdrop(normalize(rd + bend * (1. + (float(c) - 1.) * .025)))[c];
  // Light crossing more glass (seen face on) is tinted a little more, towards the palette's light colour; towards the
  // edges, where the light travels furthest through the glass, a little less of it gets through.
  through *= mix(vec3(1), uPal[4] * 1.15, .25 * ndv) * mix(.55, 1.1, smoothstep(.12, .7, ndv));
  vec3 film = grad(ndv * 1.7 + T * .04);
  vec3 r = reflect(rd, n);
  vec3 col = mix(through, room(r) * mix(vec3(1), film * 1.5, .55), fres);
  // The studio's key light, mirrored on the glass at any angle.
  col += uPal[4] * pow(max(dot(r, normalize(vec3(-.5, .7, -.5))), 0.), 90.) * 1.2;
  // A soft bright edge where the glass turns away, as light gathers in the thickness of a rim.
  return col + mix(film, uPal[4], .5) * pow(1. - ndv, 2.5) * .16;
}
vec3 scene(vec2 frag) {
  vec2 uv = (frag - .5 * uRes) / uRes.y;
  T = uTime * .12 + uSeed * 60.;
  vec3 ro = vec3(.6 * sin(uTime * .013 + uSeed * 5.), .3 * sin(uTime * .017), -6.);
  vec3 rd = lookAt(ro, vec3(0, .1, .5)) * normalize(vec3(uv, 1.9));
  // The ray's closest pass by a form it missed, as an angle, gives a soft edge round each form.
  float t = 0., near = 1e3, nearT = 0.;
  bool hit = false;
  for (int i = 0; i < 80; i++) {
    float d = map(ro + rd * t);
    if (d < .001) { hit = true; break; }
    if (d / t < near) { near = d / t; nearT = t; }
    t += d;
    if (t > 14.) break;
  }
  if (hit) return glassAt(ro + rd * t, rd);
  vec3 col = backdrop(rd);
  float pixel = 1.2 / (uRes.y * 1.9);
  float edge = 1. - smoothstep(0., pixel, near);
  if (edge > 0.) col = mix(col, glassAt(ro + rd * nearT, rd), edge);
  coc = .85 * (1. - edge);
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
  { id: 'silk', name: 'Silk', kind: '2d', mood: 'day', source: silk },
  { id: 'dunes', name: 'Dunes', kind: '3d', mood: 'day', source: dunes },
  { id: 'waves', name: 'Waves', kind: '2d', mood: 'day', source: waves },
  { id: 'forms', name: 'Forms', kind: '3d', mood: 'night', source: forms },
  { id: 'ink', name: 'Ink', kind: '2d', mood: 'night', source: ink },
  { id: 'glass', name: 'Glass', kind: '3d', mood: 'night', source: glass },
  { id: 'aurora', name: 'Aurora', kind: '3d', mood: 'night', source: aurora },
];

/** A scene's whole fragment shader. @param {Scene} scene */
export const fragmentSource = (scene) => COMMON + scene.source + MAIN;
