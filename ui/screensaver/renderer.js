// @ts-check
// Draws the screensaver's scenes with WebGL2, in four steps:
//   1. Each scene renders into its own buffer at part of the screen's resolution: linear light, and in alpha how far
//      out of focus each pixel is (3D scenes only). Drift also draws particles over its picture: fourteen thousand
//      small quads, placed by a vertex shader.
//   2. A mix pass holds each scene's average brightness down, blurs what is out of focus (from the buffer's
//      mipmaps), and hands one scene over to the next in one of a few ways.
//   3. A bloom: the bright parts, halved in size four times and added back up, so highlights glow softly.
//   4. The last pass scales up to the canvas, adds the bloom, maps the light to the screen with an AgX curve (bright
//      colours roll off gently instead of clipping), darkens the corners a little and adds a moving grain, which also
//      hides the banding that slow dark gradients show on an 8-bit screen.

import { forMood, gradient, toLinear } from './palette.js';
import { fragmentSource, particleSources } from './scenes.js';

/**
 * @typedef {import('./scenes.js').Scene} Scene
 * @typedef {import('./scenes.js').Art} Art
 * @typedef {import('./palette.js').Palette} Palette
 * @typedef {import('./palette.js').Mood} Mood
 */

/** A triangle that covers the target, from the vertex index alone, so no buffers are needed. */
const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2. - 1., 0., 1.);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler3D;
out vec4 fragColor;
float luma(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
`;

/**
 * Step 2. A scene brighter than MEAN on average is dimmed to it, from its smallest mipmap: a bright palette can't turn
 * the TV into a light panel (an OLED TV wears faster, and dims itself, under a bright full screen). Alpha says how far
 * out of focus a pixel is, and the mipmaps give the blur. The next scene comes in by one of four ways: a crossfade;
 * through the darks first, as if the light went out of one picture and came up in the other; through flowing noise; or
 * pushing in, the old scene growing and blurring away as the new one settles.
 */
const MIX = `${HEAD}
uniform sampler2D uA, uB;
uniform sampler3D uNoise;
uniform float uLodA, uLodB, uMix, uFade, uClock;
uniform int uWay;
uniform vec2 uRes;
const float MEAN = .17, BLUR = 2.6;
vec3 scene(sampler2D s, float lod, vec2 uv, float extra) {
  float mean = luma(textureLod(s, vec2(.5), lod).rgb);
  vec4 sharp = texture(s, uv);
  float blur = sharp.a * BLUR + extra;
  vec3 c = blur > .03 ? textureLod(s, uv, blur).rgb : sharp.rgb;
  return c * min(1., MEAN / max(mean, 1e-4));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c;
  if (uMix <= 0.) c = scene(uA, uLodA, uv, 0.);
  else if (uWay == 3) {
    vec2 k = uv - .5;
    vec3 a = scene(uA, uLodA, .5 + k / (1. + .3 * uMix), 3. * uMix);
    vec3 b = scene(uB, uLodB, .5 + k * (1. - .12 * (1. - uMix)), 2.5 * (1. - uMix));
    c = mix(a, b, smoothstep(.15, .85, uMix));
  } else {
    vec3 a = scene(uA, uLodA, uv, 0.), b = scene(uB, uLodB, uv, 0.);
    float m = uMix;
    if (uWay > 0) {
      float key = uWay == 1
        ? sqrt(luma(a) / (luma(a) + .12))
        : texture(uNoise, vec3(uv * vec2(uRes.x / uRes.y, 1.) * .3, uClock * .01)).r;
      float edge = m * 1.36 - .18;
      m = 1. - smoothstep(edge - .18, edge + .18, key);
    }
    c = mix(a, b, m);
  }
  fragColor = vec4(c * uFade, 1.);
}`;

/** Step 3, first: the light above a soft threshold, at half size, from four taps that already blur it a little. */
const BRIGHT = `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec2 uv = gl_FragCoord.xy * 2. * uTexel;
  vec3 c = (texture(uSrc, uv + uTexel * vec2(-1, -1)).rgb + texture(uSrc, uv + uTexel * vec2(1, -1)).rgb
          + texture(uSrc, uv + uTexel * vec2(-1, 1)).rgb + texture(uSrc, uv + uTexel * vec2(1, 1)).rgb) * .25;
  float l = luma(c);
  float soft = clamp(l - .25, 0., .5);
  float over = max(soft * soft / 2. , l - .5) / max(l, 1e-4);
  fragColor = vec4(c * over, 1.);
}`;

/** Halving (dual Kawase filter: the centre and four diagonal taps). */
const DOWN = `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec2 uv = gl_FragCoord.xy * 2. * uTexel;
  vec3 c = texture(uSrc, uv).rgb * 4.;
  c += texture(uSrc, uv + uTexel * vec2(-1, -1)).rgb + texture(uSrc, uv + uTexel * vec2(1, -1)).rgb;
  c += texture(uSrc, uv + uTexel * vec2(-1, 1)).rgb + texture(uSrc, uv + uTexel * vec2(1, 1)).rgb;
  fragColor = vec4(c / 8., 1.);
}`;

/** Doubling, added onto the level above (a tent of eight taps). */
const UP = `${HEAD}
uniform sampler2D uSrc;
uniform vec2 uTexel, uRes;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = texture(uSrc, uv + uTexel * vec2(-2, 0)).rgb + texture(uSrc, uv + uTexel * vec2(2, 0)).rgb;
  c += texture(uSrc, uv + uTexel * vec2(0, -2)).rgb + texture(uSrc, uv + uTexel * vec2(0, 2)).rgb;
  c += (texture(uSrc, uv + uTexel * vec2(-1, -1)).rgb + texture(uSrc, uv + uTexel * vec2(1, -1)).rgb
      + texture(uSrc, uv + uTexel * vec2(-1, 1)).rgb + texture(uSrc, uv + uTexel * vec2(1, 1)).rgb) * 2.;
  fragColor = vec4(c / 12., 1.);
}`;

/**
 * Step 4. AgX after Troy Sobotka, in the polynomial fit by Benjamin Wrensch (2023), with a slightly punchier look.
 * The result is display-encoded; PEAK keeps the brightest pixel short of full white.
 */
const FINAL = `${HEAD}
uniform sampler2D uMixed, uBloom;
uniform float uTime;
uniform vec2 uRes;
const float EXPOSURE = 1.25, BLOOM = .28, PEAK = .93;
vec3 agxCurve(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + .4298 * x2 + .1191 * x - .00232;
}
vec3 agx(vec3 c) {
  const mat3 IN = mat3(.842479062253094, .0423282422610123, .0423756549057051,
                       .0784335999999992, .878468636469772, .0784336,
                       .0792237451477643, .0791661274605434, .879142973793104);
  const mat3 OUT = mat3(1.19687900512017, -.0528968517574562, -.0529716355144438,
                        -.0980208811401368, 1.15190312990417, -.0980434501171241,
                        -.0990297440797205, -.0989611768448433, 1.15107367264116);
  const float LO = -12.47393, HI = 4.026069;
  c = clamp(log2(max(IN * c, 1e-10)), LO, HI);
  c = agxCurve((c - LO) / (HI - LO));
  // The look: a little more contrast and colour than AgX's neutral one.
  float l = luma(c);
  c = pow(max(c, 0.), vec3(1.12));
  c = l + 1.18 * (c - l);
  return clamp(OUT * c, 0., 1.);
}
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = texture(uMixed, uv).rgb + texture(uBloom, uv).rgb * BLOOM;
  vec2 q = (uv - .5) * vec2(1., .82);
  c *= 1. - .28 * smoothstep(.1, .55, dot(q, q));
  vec3 s = agx(c * EXPOSURE) * PEAK;
  // Grain: two hashes make a triangle-shaped noise that changes every frame, strongest in the mid-tones.
  vec2 seed = gl_FragCoord.xy + fract(uTime * 7.31) * vec2(97.3, 61.7);
  float n = hash(seed) + hash(seed + 17.13) - 1.;
  float l = luma(s);
  s += n * (1.2 / 255. + .045 * l * (1. - l));
  fragColor = vec4(s, 1.);
}`;

/** The bloom's levels: half the scene buffer's size, then halved again three times. */
const BLOOM_LEVELS = 4;
/** The ways one scene hands over to the next (MIX): crossfade, darks first, flowing noise, push in. */
export const WAYS = 4;
/** Texture units, the same in every scene's program. */
const UNIT = { grad: 0, noise: 1, art: 2, art2: 3 };
const SAMPLERS = { uGrad: UNIT.grad, uNoise: UNIT.noise, uArt: UNIT.art, uArt2: UNIT.art2 };
const SCENE_UNIFORMS = ['uRes', 'uTime', 'uSeed', 'uPal', 'uArtInfo', ...Object.keys(SAMPLERS)];

/**
 * @typedef {object} Target  a buffer to render into
 * @property {WebGLFramebuffer} fbo
 * @property {WebGLTexture} tex
 * @property {number} width
 * @property {number} height
 * @property {number} lod  its smallest mipmap level, 1 × 1 (0 without mipmaps)
 */

/**
 * @typedef {object} Program
 * @property {WebGLProgram} program
 * @property {WebGLShader[]} shaders
 * @property {Record<string, WebGLUniformLocation | null>} at
 * @property {boolean} linked  checked once the driver has finished
 */

/**
 * A scene's programs: its picture, and its particles when it has them.
 * @typedef {{ main: Program, particles: Program | null }} ScenePrograms
 */

/**
 * Tileable value noise in a 64³ texture: two octaves on lattices of 8 and 16 cells, with quintic interpolation, so
 * a texture lookup gives smooth noise (scenes' noise3 adds octaves). Values 0 to 255, about 128 on average.
 */
function noiseVolume() {
  const N = 64;
  /** @param {number} cells @param {number} seed */
  const lattice = (cells, seed) => {
    const v = new Float32Array(cells ** 3);
    let s = seed;
    for (let i = 0; i < v.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      v[i] = s / 4294967296;
    }
    return v;
  };
  const fade = (/** @type {number} */ t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ t) => a + (b - a) * t;
  const sum = new Float64Array(N ** 3);
  for (const { cells, v, w } of [
    { cells: 8, v: lattice(8, 7), w: 0.65 },
    { cells: 16, v: lattice(16, 19), w: 0.35 },
  ]) {
    // Each of the N steps along an axis lies between two lattice points (the second wrapping round), part of the way
    // from one to the other, eased. That is the same on every axis, so it is worked out once, and the loop below
    // makes no garbage.
    const k = cells / N;
    const lo = Int32Array.from({ length: N }, (_, x) => Math.floor(x * k));
    const hi = lo.map((i) => (i + 1) % cells);
    const u = Float64Array.from(lo, (i, x) => fade(x * k - i));
    for (let z = 0; z < N; z++) {
      for (let y = 0; y < N; y++) {
        // The lattice is laid out x, then y, then z.
        const y0z0 = lo[y] * cells + lo[z];
        const y1z0 = hi[y] * cells + lo[z];
        const y0z1 = lo[y] * cells + hi[z];
        const y1z1 = hi[y] * cells + hi[z];
        for (let x = 0; x < N; x++) {
          const x0 = lo[x] * cells * cells;
          const x1 = hi[x] * cells * cells;
          const near = lerp(lerp(v[x0 + y0z0], v[x1 + y0z0], u[x]), lerp(v[x0 + y1z0], v[x1 + y1z0], u[x]), u[y]);
          const far = lerp(lerp(v[x0 + y0z1], v[x1 + y0z1], u[x]), lerp(v[x0 + y1z1], v[x1 + y1z1], u[x]), u[y]);
          sum[(z * N + y) * N + x] += lerp(near, far, u[z]) * w;
        }
      }
    }
  }
  const out = new Uint8Array(sum.length);
  for (let i = 0; i < sum.length; i++) out[i] = Math.round(sum[i] * 255);
  return out;
}

export class Renderer {
  /**
   * Throws when the canvas has no WebGL2, so the caller can fall back to its CSS gradient.
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.canvas = canvas;
    this.gl = gl;
    // Half floats keep the dark gradients smooth and the highlights above 1 for the bloom; without them the sRGB
    // format still spends its bits where the eye looks.
    this.format = gl.getExtension('EXT_color_buffer_float') ? gl.RGBA16F : gl.SRGB8_ALPHA8;
    // Lets the driver compile on its own threads, so a raymarched scene doesn't hold up a frame (Windows compiles
    // shaders through Direct3D, which takes a while for long loops).
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic');
    this.vao = gl.createVertexArray();
    /** @type {Map<string, ScenePrograms>} */
    this.programs = new Map();
    /** @type {Map<Palette, WebGLTexture>} */
    this.gradients = new Map();
    /** @type {WeakMap<Palette, Record<Mood, Palette>>} */
    this.moods = new WeakMap();
    /** @type {WeakMap<Palette, Float32Array>} a mood's palette in linear light, as uPal takes it */
    this.linear = new WeakMap();
    /** @type {Map<object, { tex: WebGLTexture, aspect: number }>} art uploaded, per image or atlas */
    this.images = new Map();
    /** uArtInfo and Drift's pick of hero images, filled in each frame rather than made anew. */
    this.artInfo = new Float32Array(4);
    /** @type {import('./scenes.js').HeroPick} */
    this.pick = { a: 0, b: 0, mix: 0, cycle: 0 };
    /** @type {(Target | null)[]} the two scenes' buffers */
    this.targets = [null, null];
    /** @type {Target | null} */
    this.mixed = null;
    /** @type {Target[]} */
    this.bloom = [];
    this.noise = this.texture3d(noiseVolume(), 64);
    this.blank = this.blankTexture();
    const passes = {
      mix: [MIX, ['uA', 'uB', 'uNoise', 'uLodA', 'uLodB', 'uMix', 'uFade', 'uClock', 'uWay', 'uRes']],
      bright: [BRIGHT, ['uSrc', 'uTexel']],
      down: [DOWN, ['uSrc', 'uTexel']],
      up: [UP, ['uSrc', 'uTexel', 'uRes']],
      final: [FINAL, ['uMixed', 'uBloom', 'uTime', 'uRes']],
    };
    /** @type {Record<keyof typeof passes, Program>} */
    this.pass = /** @type {any} */ (
      Object.fromEntries(
        Object.entries(passes).map(([name, [source, uniforms]]) => [
          name,
          this.compile(VERTEX, /** @type {string} */ (source), /** @type {string[]} */ (uniforms)),
        ])
      )
    );
    this.passes = Object.values(this.pass);
  }

  /**
   * @param {string} vertex @param {string} fragment
   * @param {string[]} uniforms
   * @returns {Program}
   */
  compile(vertex, fragment, uniforms) {
    const { gl } = this;
    const program = /** @type {WebGLProgram} */ (gl.createProgram());
    const shaders = [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]].map(([type, source]) => {
      const shader = /** @type {WebGLShader} */ (gl.createShader(/** @type {number} */ (type)));
      gl.shaderSource(shader, /** @type {string} */ (source));
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      return shader;
    });
    gl.linkProgram(program);
    return { program, shaders, at: Object.fromEntries(uniforms.map((u) => [u, null])), linked: false };
  }

  /**
   * Whether the program has finished compiling. Its uniforms are looked up then, and its samplers pointed at their
   * texture units; a shader that failed throws with the driver's log.
   * @param {Program | null} p
   */
  ready(p) {
    const { gl } = this;
    if (!p || p.linked) return true;
    if (this.parallel && !gl.getProgramParameter(p.program, this.parallel.COMPLETION_STATUS_KHR)) return false;
    if (!gl.getProgramParameter(p.program, gl.LINK_STATUS)) {
      const log = p.shaders.map((s) => gl.getShaderInfoLog(s)).join('\n') || gl.getProgramInfoLog(p.program);
      throw new Error(`a screensaver shader failed: ${log}`);
    }
    for (const name of Object.keys(p.at)) p.at[name] = gl.getUniformLocation(p.program, name);
    gl.useProgram(p.program);
    for (const [name, unit] of Object.entries(SAMPLERS)) if (p.at[name]) gl.uniform1i(p.at[name], unit);
    p.linked = true;
    return true;
  }

  /** Starts compiling a scene's programs, if it isn't yet. @param {Scene} scene */
  prepare(scene) {
    let p = this.programs.get(scene.id);
    if (!p) {
      const parts = particleSources(scene);
      p = {
        main: this.compile(VERTEX, fragmentSource(scene), SCENE_UNIFORMS),
        particles: parts ? this.compile(parts.vertex, parts.fragment, SCENE_UNIFORMS) : null,
      };
      this.programs.set(scene.id, p);
    }
    return p;
  }

  /** Whether a scene, and the passes after it, can draw now. @param {Scene} scene */
  canDraw(scene) {
    const p = this.prepare(scene);
    for (const pass of this.passes) if (!this.ready(pass)) return false;
    return this.ready(p.main) && this.ready(p.particles);
  }

  /** The palette as a scene of that mood shows it (palette.js forMood), worked out once. @param {Palette} palette @param {Mood} mood */
  inMood(palette, mood) {
    let moods = this.moods.get(palette);
    if (!moods) {
      moods = { day: forMood(palette, 'day'), night: forMood(palette, 'night') };
      this.moods.set(palette, moods);
    }
    return moods[mood];
  }

  /** A mood's palette in linear light, as uPal takes it, worked out once. @param {Palette} colours */
  linearOf(colours) {
    let pal = this.linear.get(colours);
    if (!pal) {
      pal = new Float32Array(colours.flatMap((rgb) => rgb.map(toLinear)));
      this.linear.set(colours, pal);
    }
    return pal;
  }

  /** A palette's gradient as a texture, made once per palette. @param {Palette} palette @param {Mood} mood */
  gradientTexture(palette, mood) {
    const { gl } = this;
    let tex = this.gradients.get(palette);
    if (!tex) {
      tex = /** @type {WebGLTexture} */ (gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, gradient(palette, 256, mood));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.gradients.set(palette, tex);
      // A long show cycles through a library's worth of palettes; the oldest go.
      if (this.gradients.size > 32) {
        const [oldest, old] = this.gradients.entries().next().value;
        gl.deleteTexture(old);
        this.gradients.delete(oldest);
      }
    }
    return tex;
  }

  /** @param {Uint8Array} data @param {number} size */
  texture3d(data, size) {
    const { gl } = this;
    const tex = /** @type {WebGLTexture} */ (gl.createTexture());
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, size, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, wrap, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  /** A 1 × 1 texture for the units a program doesn't use, so no sampler reads an empty unit. */
  blankTexture() {
    const { gl } = this;
    const tex = /** @type {WebGLTexture} */ (gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return tex;
  }

  /**
   * A game's art (a cover atlas, a hero image) as a texture, made once per image: in sRGB, so the scene reads linear
   * light, with mipmaps for the far and the blurred.
   * @param {TexImageSource} source
   */
  image(source) {
    const { gl } = this;
    let entry = this.images.get(source);
    if (!entry) {
      const tex = /** @type {WebGLTexture} */ (gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      const { width, height } = /** @type {{ width: number, height: number }} */ (source);
      entry = { tex, aspect: width / height };
      this.images.set(source, entry);
    }
    return entry;
  }

  /**
   * A buffer in the scene format, with mipmaps when asked.
   * @param {number} width @param {number} height @param {boolean} mipmaps
   * @returns {Target}
   */
  target(width, height, mipmaps) {
    const { gl } = this;
    const tex = /** @type {WebGLTexture} */ (gl.createTexture());
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, this.format, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = /** @type {WebGLFramebuffer} */ (gl.createFramebuffer());
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fbo, tex, width, height, lod: levels - 1 };
  }

  /** @param {Target | null} t */
  dropTarget(t) {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  /**
   * The canvas at `width` × `height`, and the buffers behind it at `scale` of that.
   * @param {number} width @param {number} height @param {number} scale
   */
  resize(width, height, scale) {
    if (this.canvas.width !== width || this.canvas.height !== height) Object.assign(this.canvas, { width, height });
    const w = Math.max(32, Math.round(width * scale));
    const h = Math.max(32, Math.round(height * scale));
    if (this.mixed?.width === w && this.mixed.height === h) return;
    this.dropBuffers();
    this.targets = [this.target(w, h, true), this.target(w, h, true)];
    this.mixed = this.target(w, h, false);
    this.bloom = Array.from({ length: BLOOM_LEVELS }, (_, i) =>
      this.target(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1)), false)
    );
  }

  dropBuffers() {
    for (const t of [...this.targets, this.mixed, ...this.bloom]) this.dropTarget(t);
    this.targets = [null, null];
    this.mixed = null;
    this.bloom = [];
  }

  /**
   * Frees the buffers while the screensaver is away. The compiled scenes and the art's textures stay, so the next
   * show doesn't upload the art again.
   */
  release() {
    this.dropBuffers();
    Object.assign(this.canvas, { width: 1, height: 1 });
  }

  /** Frees the art's textures, once the show has other art. */
  dropArt() {
    for (const { tex } of this.images.values()) this.gl.deleteTexture(tex);
    this.images.clear();
  }

  /** Swaps the two scenes' buffers, when the scene handing over has gone. */
  swap() {
    this.targets.reverse();
  }

  /**
   * Binds `target` (or the canvas) for a pass, and `program` with its source texture in unit 0.
   * @param {Program} p @param {Target | null} target @param {WebGLTexture | null} [src]
   */
  use(p, target, src = null) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.width : this.canvas.width, target ? target.height : this.canvas.height);
    gl.useProgram(p.program);
    if (src) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(p.at.uSrc, 0);
    }
  }

  draw() {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  /** @param {number} unit @param {WebGLTexture | null} tex @param {number} [kind] */
  bind(unit, tex, kind = this.gl.TEXTURE_2D) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(kind, tex);
  }

  /**
   * Draws a scene into buffer `slot` (0 or 1), `time` seconds into it. It runs every frame, so it makes no new objects.
   * @param {number} slot
   * @param {{ scene: Scene, seed: number, look: { palette: Palette }, art: Art }} showing  saver.js Showing
   * @param {number} time
   */
  drawScene(slot, { scene, seed, look, art }, time) {
    const { gl } = this;
    const target = /** @type {Target} */ (this.targets[slot]);
    const p = this.prepare(scene);
    const colours = this.inMood(look.palette, scene.mood);
    const pal = this.linearOf(colours);

    // The textures every program may read: the gradient, the noise, the scene's art.
    this.bind(UNIT.grad, this.gradientTexture(colours, scene.mood));
    this.bind(UNIT.noise, this.noise, gl.TEXTURE_3D);
    const info = this.artInfo.fill(0);
    let art1 = this.blank;
    let art2 = this.blank;
    if (scene.needs === 'covers' && art.atlas) {
      art1 = this.image(art.atlas.source).tex;
      info[0] = art.atlas.count;
      info[1] = art.atlas.cols;
      info[2] = art.atlas.rows;
    } else if (scene.needs === 'heroes' && scene.heroes && art.heroes.length > 1) {
      const pick = scene.heroes(time, art.heroes.length, this.pick);
      const a = this.image(art.heroes[pick.a]);
      const b = this.image(art.heroes[pick.b]);
      art1 = a.tex;
      art2 = b.tex;
      info[0] = pick.mix;
      info[1] = a.aspect;
      info[2] = b.aspect;
      info[3] = pick.cycle;
    }
    this.bind(UNIT.art, art1);
    this.bind(UNIT.art2, art2);

    this.use(p.main, target);
    this.sceneUniforms(p.main, target, time, seed, pal);
    this.draw();
    if (p.particles) {
      // Particles over the picture, each a soft dot with its colour premultiplied by how much it covers.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(p.particles.program);
      this.sceneUniforms(p.particles, target, time, seed, pal);
      gl.bindVertexArray(this.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, scene.particles?.count ?? 0);
      gl.disable(gl.BLEND);
    }
    this.bind(UNIT.grad, target.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /**
   * The uniforms every program of a scene shares, in the program in use.
   * @param {Program} prog @param {Target} target @param {number} time @param {number} seed @param {Float32Array} pal
   */
  sceneUniforms(prog, target, time, seed, pal) {
    const { gl } = this;
    gl.uniform2f(prog.at.uRes, target.width, target.height);
    gl.uniform1f(prog.at.uTime, time);
    gl.uniform1f(prog.at.uSeed, seed);
    gl.uniform3fv(prog.at.uPal, pal);
    gl.uniform4fv(prog.at.uArtInfo, this.artInfo);
  }

  /**
   * Puts the scene in buffer 0 on the screen, handing over to buffer 1 by `mix` in the way `way`, at `fade` of full
   * brightness, `time` seconds into the show.
   * @param {number} mix @param {number} way @param {number} fade @param {number} time
   */
  present(mix, way, fade, time) {
    const { gl } = this;
    const a = /** @type {Target} */ (this.targets[0]);
    const b = /** @type {Target} */ (this.targets[1]);
    const mixed = /** @type {Target} */ (this.mixed);
    const { pass } = this;

    this.use(pass.mix, mixed);
    this.bind(0, a.tex);
    this.bind(1, b.tex);
    this.bind(2, this.noise, gl.TEXTURE_3D);
    gl.uniform1i(pass.mix.at.uA, 0);
    gl.uniform1i(pass.mix.at.uB, 1);
    gl.uniform1i(pass.mix.at.uNoise, 2);
    gl.uniform1f(pass.mix.at.uLodA, a.lod);
    gl.uniform1f(pass.mix.at.uLodB, b.lod);
    gl.uniform1f(pass.mix.at.uMix, mix);
    gl.uniform1i(pass.mix.at.uWay, way);
    gl.uniform1f(pass.mix.at.uFade, fade);
    gl.uniform1f(pass.mix.at.uClock, time);
    gl.uniform2f(pass.mix.at.uRes, mixed.width, mixed.height);
    this.draw();

    // The bloom: down to a sixteenth, then back up, each level added onto the one above.
    this.use(pass.bright, this.bloom[0], mixed.tex);
    gl.uniform2f(pass.bright.at.uTexel, 1 / mixed.width, 1 / mixed.height);
    this.draw();
    for (let i = 1; i < this.bloom.length; i++) {
      const from = this.bloom[i - 1];
      this.use(pass.down, this.bloom[i], from.tex);
      gl.uniform2f(pass.down.at.uTexel, 1 / from.width, 1 / from.height);
      this.draw();
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.bloom.length - 1; i > 0; i--) {
      const from = this.bloom[i];
      const to = this.bloom[i - 1];
      this.use(pass.up, to, from.tex);
      gl.uniform2f(pass.up.at.uTexel, 0.5 / from.width, 0.5 / from.height);
      gl.uniform2f(pass.up.at.uRes, to.width, to.height);
      this.draw();
    }
    gl.disable(gl.BLEND);

    this.use(pass.final, null);
    this.bind(0, mixed.tex);
    this.bind(1, this.bloom[0].tex);
    gl.uniform1i(pass.final.at.uMixed, 0);
    gl.uniform1i(pass.final.at.uBloom, 1);
    gl.uniform1f(pass.final.at.uTime, time);
    gl.uniform2f(pass.final.at.uRes, this.canvas.width, this.canvas.height);
    this.draw();
  }
}
