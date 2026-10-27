// @ts-check
// Draws the screensaver's scenes with WebGL2, in four steps:
//   1. Each scene renders into its own buffer at part of the screen's resolution: linear light, and in alpha how far
//      out of focus each pixel is (3D scenes only).
//   2. A mix pass holds each scene's average brightness down, blurs what is out of focus (from the buffer's
//      mipmaps), and blends the scene handing over into the next.
//   3. A bloom: the bright parts, halved in size four times and added back up, so highlights glow softly.
//   4. The last pass scales up to the canvas, adds the bloom, maps the light to the screen with an AgX curve (bright
//      colours roll off gently instead of clipping), darkens the corners a little and adds a moving grain, which also
//      hides the banding that slow dark gradients show on an 8-bit screen.

import { forMood, gradient } from './palette.js';
import { fragmentSource } from './scenes.js';

/**
 * @typedef {import('./scenes.js').Scene} Scene
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
out vec4 fragColor;
float luma(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
`;

/**
 * Step 2. A scene brighter than MEAN on average is dimmed to it, from its smallest mipmap: a bright palette can't turn
 * the TV into a light panel (an OLED TV wears faster, and dims itself, under a bright full screen). Alpha says how far
 * out of focus a pixel is, and the mipmaps give the blur.
 */
const MIX = `${HEAD}
uniform sampler2D uA, uB;
uniform float uLodA, uLodB, uMix, uFade;
uniform vec2 uRes;
const float MEAN = .17, BLUR = 2.6;
vec3 scene(sampler2D s, float lod, vec2 uv) {
  float mean = luma(textureLod(s, vec2(.5), lod).rgb);
  vec4 sharp = texture(s, uv);
  vec3 c = sharp.a > .01 ? textureLod(s, uv, sharp.a * BLUR).rgb : sharp.rgb;
  return c * min(1., MEAN / max(mean, 1e-4));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = scene(uA, uLodA, uv);
  if (uMix > 0.) c = mix(c, scene(uB, uLodB, uv), uMix);
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
    this.vao = gl.createVertexArray();
    /** @type {Map<string, Program>} */
    this.programs = new Map();
    /** @type {Map<Palette, WebGLTexture>} */
    this.gradients = new Map();
    /** @type {WeakMap<Palette, Record<Mood, Palette>>} */
    this.moods = new WeakMap();
    /** @type {(Target | null)[]} the two scenes' buffers */
    this.targets = [null, null];
    /** @type {Target | null} */
    this.mixed = null;
    /** @type {Target[]} */
    this.bloom = [];
    const passes = {
      mix: [MIX, ['uA', 'uB', 'uLodA', 'uLodB', 'uMix', 'uFade', 'uRes']],
      bright: [BRIGHT, ['uSrc', 'uTexel']],
      down: [DOWN, ['uSrc', 'uTexel']],
      up: [UP, ['uSrc', 'uTexel', 'uRes']],
      final: [FINAL, ['uMixed', 'uBloom', 'uTime', 'uRes']],
    };
    /** @type {Record<keyof passes, Program>} */
    this.pass = /** @type {any} */ (
      Object.fromEntries(Object.entries(passes).map(([name, [source, uniforms]]) => [name, this.compile(/** @type {string} */ (source), /** @type {string[]} */ (uniforms))]))
    );
  }

  /**
   * @param {string} fragment
   * @param {string[]} uniforms
   * @returns {Program}
   */
  compile(fragment, uniforms) {
    const { gl } = this;
    const program = /** @type {WebGLProgram} */ (gl.createProgram());
    const shaders = [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]].map(([type, source]) => {
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
   * Whether the program has finished compiling. Its uniforms are looked up then; a shader that failed throws with
   * the driver's log.
   * @param {Program} p
   */
  ready(p) {
    const { gl } = this;
    if (p.linked) return true;
    if (this.parallel && !gl.getProgramParameter(p.program, this.parallel.COMPLETION_STATUS_KHR)) return false;
    if (!gl.getProgramParameter(p.program, gl.LINK_STATUS)) {
      const log = p.shaders.map((s) => gl.getShaderInfoLog(s)).join('\n') || gl.getProgramInfoLog(p.program);
      throw new Error(`a screensaver shader failed: ${log}`);
    }
    for (const name of Object.keys(p.at)) p.at[name] = gl.getUniformLocation(p.program, name);
    p.linked = true;
    return true;
  }

  /** Starts compiling a scene, if it isn't yet. @param {Scene} scene */
  prepare(scene) {
    let p = this.programs.get(scene.id);
    if (!p) {
      p = this.compile(fragmentSource(scene), ['uRes', 'uTime', 'uSeed', 'uPal', 'uGrad']);
      this.programs.set(scene.id, p);
    }
    return p;
  }

  /** Whether a scene, and the passes after it, can draw now. @param {Scene} scene */
  canDraw(scene) {
    return Object.values(this.pass).every((p) => this.ready(p)) && this.ready(this.prepare(scene));
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

  /**
   * A buffer, with mipmaps when asked.
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
    for (const t of [...this.targets, this.mixed, ...this.bloom]) {
      if (!t) continue;
      this.gl.deleteFramebuffer(t.fbo);
      this.gl.deleteTexture(t.tex);
    }
    this.targets = [null, null];
    this.mixed = null;
    this.bloom = [];
  }

  /** Frees the buffers while the screensaver is away; the compiled scenes stay. */
  release() {
    this.dropBuffers();
    Object.assign(this.canvas, { width: 1, height: 1 });
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

  /**
   * Draws a scene into buffer `slot` (0 or 1).
   * @param {number} slot
   * @param {Scene} scene
   * @param {{ time: number, seed: number, palette: Palette }} look
   */
  drawScene(slot, scene, { time, seed, palette }) {
    const { gl } = this;
    const target = /** @type {Target} */ (this.targets[slot]);
    const p = this.prepare(scene);
    const colours = this.inMood(palette, scene.mood);
    this.use(p, target);
    gl.uniform2f(p.at.uRes, target.width, target.height);
    gl.uniform1f(p.at.uTime, time);
    gl.uniform1f(p.at.uSeed, seed);
    gl.uniform3fv(p.at.uPal, colours.flatMap((rgb) => rgb.map(linear)));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.gradientTexture(colours, scene.mood));
    gl.uniform1i(p.at.uGrad, 0);
    this.draw();
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /**
   * Puts the scene in buffer 0 on the screen, blended towards buffer 1 by `mix`, at `fade` of full brightness.
   * @param {{ mix: number, fade: number, time: number }} frame
   */
  present({ mix, fade, time }) {
    const { gl } = this;
    const [a, b] = /** @type {Target[]} */ (this.targets);
    const mixed = /** @type {Target} */ (this.mixed);
    const { pass } = this;

    this.use(pass.mix, mixed);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b.tex);
    gl.uniform1i(pass.mix.at.uA, 0);
    gl.uniform1i(pass.mix.at.uB, 1);
    gl.uniform1f(pass.mix.at.uLodA, a.lod);
    gl.uniform1f(pass.mix.at.uLodB, b.lod);
    gl.uniform1f(pass.mix.at.uMix, mix);
    gl.uniform1f(pass.mix.at.uFade, fade);
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
      const [from, to] = [this.bloom[i], this.bloom[i - 1]];
      this.use(pass.up, to, from.tex);
      gl.uniform2f(pass.up.at.uTexel, 0.5 / from.width, 0.5 / from.height);
      gl.uniform2f(pass.up.at.uRes, to.width, to.height);
      this.draw();
    }
    gl.disable(gl.BLEND);

    this.use(pass.final, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mixed.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloom[0].tex);
    gl.uniform1i(pass.final.at.uMixed, 0);
    gl.uniform1i(pass.final.at.uBloom, 1);
    gl.uniform1f(pass.final.at.uTime, time);
    gl.uniform2f(pass.final.at.uRes, this.canvas.width, this.canvas.height);
    this.draw();
  }
}

/** An sRGB byte as linear light, which the scenes work in. @param {number} c */
function linear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
