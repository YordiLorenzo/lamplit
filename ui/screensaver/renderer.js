// @ts-check
// Draws the screensaver's scenes with WebGL2. Each scene renders into its own buffer at part of the screen's
// resolution; a final pass scales that up to the canvas, blends two scenes while one hands over to the next, holds
// the average brightness down, rounds off the highlights and adds a moving grain, which also hides the banding that
// slow dark gradients show on an 8-bit screen.

import { gradient } from './palette.js';
import { fragmentSource } from './scenes.js';

/**
 * @typedef {import('./scenes.js').Scene} Scene
 * @typedef {import('./palette.js').Palette} Palette
 */

/** A triangle that covers the screen, from the vertex index alone, so no buffers are needed. */
const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2. - 1., 0., 1.);
}`;

/**
 * The last pass. The average brightness of each scene comes from its buffer's smallest mipmap, and a scene brighter
 * than MEAN on average is dimmed to it: a bright palette can't turn the TV into a light panel (an OLED TV wears faster,
 * and dims itself, under a bright full screen). Highlights bend towards PEAK instead of clipping to white.
 */
const COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uA, uB;
uniform float uLodA, uLodB, uMix, uFade, uTime;
uniform vec2 uRes;
out vec4 fragColor;
const float MEAN = .16, KNEE = .5, PEAK = .86;
float luma(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
vec3 capped(sampler2D s, float lod, vec2 uv) {
  float mean = luma(textureLod(s, vec2(.5), lod).rgb);
  return texture(s, uv).rgb * min(1., MEAN / max(mean, 1e-4));
}
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = capped(uA, uLodA, uv);
  if (uMix > 0.) c = mix(c, capped(uB, uLodB, uv), uMix);
  vec2 q = (uv - .5) * vec2(1., .8);
  c *= 1. - .3 * smoothstep(.12, .5, dot(q, q));
  vec3 over = max(c - KNEE, 0.);
  c = (min(c, vec3(KNEE)) + (PEAK - KNEE) * (1. - exp(-over / (PEAK - KNEE)))) * uFade;
  vec3 s = mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c));
  // Grain: two hashes make a triangle-shaped noise that changes every frame, strongest in the mid-tones.
  vec2 seed = gl_FragCoord.xy + fract(uTime * 7.31) * vec2(97.3, 61.7);
  float n = hash(seed) + hash(seed + 17.13) - 1.;
  float l = luma(s);
  s += n * (1.2 / 255. + .05 * l * (1. - l));
  fragColor = vec4(s, 1.);
}`;

/**
 * @typedef {object} Target  a scene's buffer
 * @property {WebGLFramebuffer} fbo
 * @property {WebGLTexture} tex
 * @property {number} width
 * @property {number} height
 * @property {number} lod  its smallest mipmap level, 1 × 1
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
    // Half floats keep the dark gradients smooth; without them the sRGB format still spends its bits where the eye
    // looks.
    this.halfFloat = !!gl.getExtension('EXT_color_buffer_float');
    // Lets the driver compile on its own threads, so a raymarched scene doesn't hold up a frame (Windows compiles
    // shaders through Direct3D, which takes a while for long loops).
    this.parallel = gl.getExtension('KHR_parallel_shader_compile');
    this.vao = gl.createVertexArray();
    /** @type {Map<string, Program>} */
    this.programs = new Map();
    /** @type {Map<Palette, WebGLTexture>} */
    this.gradients = new Map();
    /** @type {(Target | null)[]} */
    this.targets = [null, null];
    this.composite = this.compile(COMPOSITE, ['uA', 'uB', 'uLodA', 'uLodB', 'uMix', 'uFade', 'uTime', 'uRes']);
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

  /** Whether a scene can draw now. @param {Scene} scene */
  canDraw(scene) {
    return this.ready(this.prepare(scene));
  }

  /** The palette's gradient as a texture, made once per palette. @param {Palette} palette */
  gradientTexture(palette) {
    const { gl } = this;
    let tex = this.gradients.get(palette);
    if (!tex) {
      tex = /** @type {WebGLTexture} */ (gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, gradient(palette, 256));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.gradients.set(palette, tex);
      // A long show cycles through a library's worth of palettes; the oldest go.
      if (this.gradients.size > 24) {
        const [oldest, old] = this.gradients.entries().next().value;
        gl.deleteTexture(old);
        this.gradients.delete(oldest);
      }
    }
    return tex;
  }

  /**
   * The canvas at `width` × `height`, and scene buffers at `scale` of that.
   * @param {number} width @param {number} height @param {number} scale
   */
  resize(width, height, scale) {
    const { gl } = this;
    if (this.canvas.width !== width || this.canvas.height !== height) Object.assign(this.canvas, { width, height });
    const w = Math.max(16, Math.round(width * scale));
    const h = Math.max(16, Math.round(height * scale));
    this.targets = this.targets.map((t) => {
      if (t && t.width === w && t.height === h) return t;
      if (t) this.dropTarget(t);
      const tex = /** @type {WebGLTexture} */ (gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
      gl.texStorage2D(gl.TEXTURE_2D, levels, this.halfFloat ? gl.RGBA16F : gl.SRGB8_ALPHA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = /** @type {WebGLFramebuffer} */ (gl.createFramebuffer());
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fbo, tex, width: w, height: h, lod: levels - 1 };
    });
  }

  /** @param {Target} t */
  dropTarget(t) {
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  /** Frees the buffers while the screensaver is away; the compiled scenes stay. */
  release() {
    this.targets.forEach((t) => t && this.dropTarget(t));
    this.targets = [null, null];
    Object.assign(this.canvas, { width: 1, height: 1 });
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(p.program);
    gl.uniform2f(p.at.uRes, target.width, target.height);
    gl.uniform1f(p.at.uTime, time);
    gl.uniform1f(p.at.uSeed, seed);
    gl.uniform3fv(p.at.uPal, palette.flatMap((rgb) => rgb.map(linear)));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.gradientTexture(palette));
    gl.uniform1i(p.at.uGrad, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /**
   * Puts buffer 0 on the screen, blended towards buffer 1 by `mix`, at `fade` of full brightness.
   * @param {{ mix: number, fade: number, time: number }} frame
   */
  present({ mix, fade, time }) {
    const { gl } = this;
    const p = this.composite;
    this.ready(p);
    const [a, b] = this.targets;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, /** @type {Target} */ (a).tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, /** @type {Target} */ (b).tex);
    gl.uniform1i(p.at.uA, 0);
    gl.uniform1i(p.at.uB, 1);
    gl.uniform1f(p.at.uLodA, /** @type {Target} */ (a).lod);
    gl.uniform1f(p.at.uLodB, /** @type {Target} */ (b).lod);
    gl.uniform1f(p.at.uMix, mix);
    gl.uniform1f(p.at.uFade, fade);
    gl.uniform1f(p.at.uTime, time);
    gl.uniform2f(p.at.uRes, this.canvas.width, this.canvas.height);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

/** An sRGB byte as linear light, which the scenes work in. @param {number} c */
function linear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
