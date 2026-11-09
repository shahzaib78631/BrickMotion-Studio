/**
 * NeuralShade: runs the trained ShadeNet (python/neuralshade) on the GPU in WebGL2.
 *
 * The network takes what the viewport already knows about every pixel (its own frame, the
 * bricks' EyeSight colours, world normals, depth and height above the floor) and predicts the
 * pixel EyeSight's path tracer would have drawn: dome-light occlusion, bounce light, soft
 * shadows and plastic gloss, learned from EyeSight renders instead of imitated with separate
 * effects. It is a small fully-convolutional U-Net, so it runs on any size image.
 *
 * Feature maps are 2D texture arrays (RGBA16F, one layer per 4 channels). A convolution is one
 * fragment shader per output layer doing `mat4 * vec4` over the 3×3 taps; the decoder's
 * upsampling is fused into its first convolution by sampling the coarse map bilinearly.
 * Weights come from shadenet.json + shadenet.bin written by neuralshade/export.py.
 */

type Op =
  | { op: 'conv'; name: string; outGroups: number; inGroups: number; k: number; relu: boolean; offset: number }
  | { op: 'skip'; level: number }
  | { op: 'pool' }
  | { op: 'up'; level: number }
  | { op: 'residual'; mode?: 'residual' | 'mul' };
type Spec = { inChannels: number; half?: boolean; spec?: boolean; detail?: boolean; achroma?: boolean; widths: number[]; floats: number; ops: Op[] };

type FeatureMap = { tex: WebGLTexture; w: number; h: number; layers: number };
type Step =
  | { kind: 'conv'; op: Extract<Op, { op: 'conv' }>; a: number; b: number; up: boolean; out: number }
  | { kind: 'pool'; src: number; out: number }
  | { kind: 'residual'; src: number; mul: boolean; detail: boolean; achroma: boolean };

/** Layers with at most this many (input group, tap) matrices keep their weights in uniforms: far cheaper than a texture fetch per tap. */
const MAXMAT = 144;

const VERT = `#version 300 es
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const CONV = `#version 300 es
precision highp float; precision highp int; precision highp sampler2DArray; precision highp sampler2D;
uniform sampler2DArray uA; uniform sampler2DArray uB; uniform sampler2D uW;
uniform int nA; uniform int nB; uniform int K; uniform int relu; uniform int outGroup; uniform int outGroups; uniform int aUp; uniform int wBase; // wBase in texels
uniform ivec2 size;
#ifdef UNIFORM_W
uniform mat4 uWm[MAXMAT]; uniform vec4 uBias; // this output group's weights, one mat4 per (input group, tap)
#endif
out vec4 o;
vec4 W(int t) { return texelFetch(uW, ivec2(t & 4095, t >> 12), 0); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int nIn = nA + nB, R = K / 2, taps = K * K;
  #ifdef UNIFORM_W
  vec4 acc = uBias;
  #else
  vec4 acc = W(wBase + outGroups * nIn * taps * 4 + outGroup);
  #endif
  for (int ig = 0; ig < nIn; ig++) {
    for (int ky = -R; ky <= R; ky++) for (int kx = -R; kx <= R; kx++) {
      // GL rows run bottom-up, the training images top-down: a tap ky rows below in the image is -ky here
      ivec2 q = p + ivec2(kx, -ky);
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      vec4 v;
      if (ig < nA) v = aUp == 1 ? texture(uA, vec3((vec2(q) + 0.5) / vec2(size), float(ig))) : texelFetch(uA, ivec3(q, ig), 0);
      else v = texelFetch(uB, ivec3(q, ig - nA), 0);
      #ifdef UNIFORM_W
      acc += uWm[ig * taps + (ky + R) * K + (kx + R)] * v;
      #else
      int t = wBase + (((outGroup * nIn + ig) * taps) + (ky + R) * K + (kx + R)) * 4;
      acc += mat4(W(t), W(t + 1), W(t + 2), W(t + 3)) * v;
      #endif
    }
  }
  o = relu == 1 ? max(acc, 0.0) : acc;
}`;

const POOL = `#version 300 es
precision highp float; precision highp sampler2DArray;
uniform sampler2DArray uA; uniform int layer; out vec4 o;
void main() { ivec2 p = ivec2(gl_FragCoord.xy) * 2; o = (texelFetch(uA, ivec3(p, layer), 0) + texelFetch(uA, ivec3(p + ivec2(1, 0), layer), 0) + texelFetch(uA, ivec3(p + ivec2(0, 1), layer), 0) + texelFetch(uA, ivec3(p + ivec2(1, 1), layer), 0)) * 0.25; }`;

// the 12 input channels are frame(3) albedo(3) normal(3) mask depth height, packed 4 to a layer
const PACK = `#version 300 es
precision highp float; precision highp sampler2D;
uniform sampler2D uFrame; uniform sampler2D uAlbedo; uniform sampler2D uNormal; uniform sampler2D uPos; uniform sampler2D uVis; uniform sampler2D uSpec; uniform int uUseSpec; uniform ivec2 uFull; uniform int layer; uniform int uAlbedoSRGB; uniform int uHalf; out vec4 o;
vec4 channels(ivec2 p) {
  // the albedo target is an sRGB texture, so a fetch returns linear light; training saw the stored sRGB bytes
  vec3 lin = max(texelFetch(uAlbedo, p, 0).rgb, 0.0);
  vec3 albedo = uAlbedoSRGB == 1 ? mix(lin * 12.92, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, lin)) : lin;
  vec3 frame = texelFetch(uFrame, p, 0).rgb;
  vec4 nrm = texelFetch(uNormal, p, 0), pos = texelFetch(uPos, p, 0);
  float covered = nrm.a > 0.5 ? 1.0 : 0.0;
  vec3 n = (nrm.rgb * 2.0 - 1.0) * covered;
  float depth = pos.r, height = pos.g;
  if (layer == 0) return vec4(frame, albedo.r);
  else if (layer == 1) return vec4(albedo.gb, n.xy);
  else if (layer == 2) return vec4(n.z, covered, depth, height);
  // dome visibility (bilinear: it is traced at a lower resolution); three spare channels
  vec3 shine = uUseSpec == 1 ? texelFetch(uSpec, p, 0).rgb : vec3(0.0);
  return vec4(texture(uVis, (vec2(p) + 0.5) / vec2(uFull)).r, shine);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  // half resolution: the input is the 2x2 average of the full-resolution channels (avg_pool2d in training)
  if (uHalf == 1) { ivec2 q = p * 2; o = (channels(q) + channels(q + ivec2(1, 0)) + channels(q + ivec2(0, 1)) + channels(q + ivec2(1, 1))) * 0.25; }
  else o = channels(p);
}`;

// 'mul' networks scale the frame's lighting in linear light and add a little: layer 0 = scale rgb + add r, layer 1 = add g b
const FINAL_MUL = `#version 300 es
precision highp float; precision highp sampler2D; precision highp sampler2DArray;
uniform sampler2D uFrame; uniform sampler2DArray uOut; uniform int uHalf; uniform ivec2 uFull; out vec4 o;
vec4 outAt(ivec2 p, int layer) { return uHalf == 1 ? texture(uOut, vec3((vec2(p) + 0.5) / vec2(uFull), float(layer))) : texelFetch(uOut, ivec3(p, layer), 0); }
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((max(c, 1e-6) + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, 1e-6), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = outAt(p, 0), b = outAt(p, 1);
  vec3 scale = log(1.0 + exp(a.rgb + 0.5413)), add = vec3(a.a, b.r, b.g);
  vec3 lin = clamp(toLin(texelFetch(uFrame, p, 0).rgb) * scale + 0.1 * add, 0.0, 1.0);
  o = vec4(toSrgb(lin), 1.0);
}`;

// 'detail' networks add shine at full resolution: sharp pixels come from exact specular and rounded-edge maps, the (smooth) brightness
// from the network. Layers: 0 = scale rgb + add r, 1 = add g b + specular gain r g, 2 = specular gain b + edge gain rgb.
// The edge map must match edge_map() in python/neuralshade/neuralshade/model.py.
const FINAL_DETAIL = `#version 300 es
precision highp float; precision highp sampler2D; precision highp sampler2DArray;
uniform sampler2D uFrame; uniform sampler2DArray uOut; uniform sampler2DArray uGuide; uniform sampler2D uNormal; uniform sampler2D uPos; uniform sampler2D uSpecMap;
uniform int uHalf; uniform ivec2 uFull; uniform ivec2 uHalfSize; uniform vec2 uDetailScale; uniform float uGreyScale; uniform int uAchroma; out vec4 o;
vec4 outAt(ivec2 p, int layer) { return uHalf == 1 ? texture(uOut, vec3((vec2(p) + 0.5) / vec2(uFull), float(layer))) : texelFetch(uOut, ivec3(p, layer), 0); }
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((max(c, 1e-6) + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, 1e-6), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 normalAt(ivec2 q, out float cov) {
  ivec2 c = clamp(q, ivec2(0), uFull - 1);
  vec4 t = texelFetch(uNormal, c, 0);
  cov = t.a > 0.5 ? 1.0 : 0.0;
  return (t.rgb * 2.0 - 1.0) * cov;
}
float edgeAt(ivec2 p) {
  float cov; vec3 n = normalAt(p, cov);
  float d = texelFetch(uPos, clamp(p, ivec2(0), uFull - 1), 0).r;
  float best = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 q = p + (i == 0 ? ivec2(1, 0) : i == 1 ? ivec2(-1, 0) : i == 2 ? ivec2(0, 1) : ivec2(0, -1));
    float cq; vec3 nq = normalAt(q, cq);
    float dq = texelFetch(uPos, clamp(q, ivec2(0), uFull - 1), 0).r;
    float bend = clamp(1.0 - dot(n, nq), 0.0, 1.0);
    float near = abs(d - dq) < 0.0002 ? 1.0 : 0.0;
    best = max(best, bend * cov * cq * near);
  }
  return best;
}
// Edge-aware (joint bilateral) upsample of the half-resolution outputs: a pixel only takes values from texels that look like it
// (same coverage, facing and depth), so a correction never leaks across a brick edge. Must match jbu_upsample() in model.py.
void upsample(ivec2 p, out vec4 a, out vec4 b, out vec4 c) {
  if (uHalf != 1) { a = texelFetch(uOut, ivec3(p, 0), 0); b = texelFetch(uOut, ivec3(p, 1), 0); c = uAchroma == 1 ? vec4(0.0) : texelFetch(uOut, ivec3(p, 2), 0); return; }
  float cov; vec3 n = normalAt(p, cov);
  float d = texelFetch(uPos, clamp(p, ivec2(0), uFull - 1), 0).r;
  vec2 u = (vec2(p) + 0.5) * vec2(uHalfSize) / vec2(uFull) - 0.5;
  ivec2 q0 = ivec2(floor(u)); vec2 f = u - vec2(q0);
  float den = 0.0; a = vec4(0.0); b = vec4(0.0); c = vec4(0.0);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    ivec2 q = clamp(q0 + ivec2(i, j), ivec2(0), uHalfSize - 1);
    float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
    vec4 g1 = texelFetch(uGuide, ivec3(q, 1), 0), g2 = texelFetch(uGuide, ivec3(q, 2), 0);
    vec3 nh = vec3(g1.z, g1.w, g2.x); float covh = g2.y, dh = g2.z;
    float sc = 1.0 - abs(cov - covh);
    float nd = cov > 0.5 ? clamp(dot(n, nh) / max(covh, 1e-3), 0.0, 1.0) : 1.0;
    float dd = (cov > 0.5 && covh > 0.99) ? exp(-abs(d - dh) / 0.0006) : 1.0;
    float w = wb * (0.01 + sc * sc * nd * dd);
    a += w * texelFetch(uOut, ivec3(q, 0), 0); b += w * texelFetch(uOut, ivec3(q, 1), 0); if (uAchroma != 1) c += w * texelFetch(uOut, ivec3(q, 2), 0); den += w;
  }
  a /= den; b /= den; c /= den;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a, b, c; upsample(p, a, b, c);
  vec3 scale = log(1.0 + exp(a.rgb + 0.5413)), add = vec3(a.a, b.r, b.g);
  scale = mix(scale, vec3(dot(scale, vec3(0.2126, 0.7152, 0.0722))), uGreyScale); // debug: one gain for all channels
  vec3 gSpec = vec3(b.b, b.a, c.r), gEdge = c.gba;
  if (uAchroma == 1) { add = vec3(a.a); gSpec = vec3(b.r); gEdge = vec3(b.g); } // brightness-only terms
  float spec = texelFetch(uSpecMap, p, 0).g;
  vec3 lin = toLin(texelFetch(uFrame, p, 0).rgb) * scale + 0.1 * add + uDetailScale.x * gSpec * spec + uDetailScale.y * gEdge * edgeAt(p);
  o = vec4(toSrgb(clamp(lin, 0.0, 1.0)), 1.0);
}`;

const FINAL = `#version 300 es
precision highp float; precision highp sampler2D; precision highp sampler2DArray;
uniform sampler2D uFrame; uniform sampler2DArray uOut; uniform int uHalf; uniform ivec2 uFull; out vec4 o;
vec4 outAt(ivec2 p, int layer) { return uHalf == 1 ? texture(uOut, vec3((vec2(p) + 0.5) / vec2(uFull), float(layer))) : texelFetch(uOut, ivec3(p, layer), 0); }
void main() { ivec2 p = ivec2(gl_FragCoord.xy); o = vec4(clamp(texelFetch(uFrame, p, 0).rgb + outAt(p, 0).rgb, 0.0, 1.0), 1.0); }`;

export class NeuralShade {
  private maps: FeatureMap[] = [];
  private steps: Step[] = [];
  private input!: FeatureMap;
  private width = 0;
  private height = 0;
  private fbo: WebGLFramebuffer;
  private vao: WebGLVertexArrayObject;
  private programs: Record<'conv' | 'convU' | 'pool' | 'pack' | 'final' | 'finalMul' | 'finalDetail', WebGLProgram>;
  private weightData: Float32Array;
  private whiteTex: WebGLTexture;
  private weights: WebGLTexture;
  /** when set, run() times every pass on the GPU (EXT_disjoint_timer_query_webgl2) and adds the milliseconds here by name */
  profile: Map<string, number> | null = null;
  /** debugging: stop after this many network steps (the final pass is then skipped) */
  debugSteps = Infinity;
  /** true for networks that read the dome-visibility channel (see domeVisibility.ts) */
  get needsVis(): boolean { return this.spec.inChannels > 12; }
  get stepCount(): number { return this.steps.length; }
  get stepNames(): string[] { return this.steps.map((s) => (s.kind === 'conv' ? s.op.name : s.kind)); }
  private pending: { name: string; query: WebGLQuery }[] = [];

  private constructor(private gl: WebGL2RenderingContext, private spec: Spec, weights: Float32Array, private half = false) {
    const need = ['EXT_color_buffer_float', 'EXT_color_buffer_half_float'];
    if (!gl.getExtension(need[0]) && !gl.getExtension(need[1])) throw new Error('NeuralShade needs EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    this.fbo = gl.createFramebuffer()!;
    this.vao = gl.createVertexArray()!;
    this.weightData = weights;
    this.whiteTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.programs = { conv: this.program(CONV), convU: this.program(CONV, `#define UNIFORM_W\n#define MAXMAT ${MAXMAT}`), pool: this.program(POOL), pack: this.program(PACK), final: this.program(FINAL), finalMul: this.program(FINAL_MUL), finalDetail: this.program(FINAL_DETAIL) };
    const texels = Math.ceil(weights.length / 4);
    const rows = Math.ceil(texels / 4096);
    const padded = new Float32Array(rows * 4096 * 4);
    padded.set(weights);
    this.weights = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.weights);
    // three.js leaves its last texture's unpack state behind (UNPACK_FLIP_Y_WEBGL = true after an image
    // texture), which would upload the weight rows upside down; upload with defaults, then put three's back
    const unpack = [gl.UNPACK_FLIP_Y_WEBGL, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, gl.UNPACK_ALIGNMENT, gl.UNPACK_ROW_LENGTH, gl.UNPACK_SKIP_PIXELS, gl.UNPACK_SKIP_ROWS];
    const defaults = [0, 0, 4, 0, 0, 0];
    const saved = unpack.map((k) => Number(gl.getParameter(k)));
    const unpackBuffer = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) as WebGLBuffer | null;
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    unpack.forEach((k, i) => gl.pixelStorei(k, defaults[i]));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4096, rows, 0, gl.RGBA, gl.FLOAT, padded);
    unpack.forEach((k, i) => gl.pixelStorei(k, saved[i]));
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, unpackBuffer);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  /** Loads `<url>.json` and `<url>.bin`. `half`: 16-bit feature maps (faster, a little less exact). */
  static async load(gl: WebGL2RenderingContext, url: string, opts: { half?: boolean } = {}): Promise<NeuralShade> {
    const [spec, bin] = await Promise.all([fetch(`${url}.json`).then((r) => r.json() as Promise<Spec>), fetch(`${url}.bin`).then((r) => r.arrayBuffer())]);
    return new NeuralShade(gl, spec, new Float32Array(bin), opts.half ?? false);
  }

  private program(fragment: string, defines = ''): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, defines ? fragment.replace('#version 300 es', `#version 300 es\n${defines}`) : fragment));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    return p;
  }

  private alloc(w: number, h: number, layers: number): number {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, this.half ? gl.RGBA16F : gl.RGBA32F, w, h, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.maps.push({ tex, w, h, layers });
    return this.maps.length - 1;
  }

  /** Allocates the feature maps for an image of this size (the network is fully convolutional). */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    for (const m of this.maps) this.gl.deleteTexture(m.tex);
    this.maps = []; this.steps = [];
    this.width = width; this.height = height;
    const half = !!this.spec.half;
    const base: [number, number] = half ? [Math.max(1, width >> 1), Math.max(1, height >> 1)] : [width, height];
    const sizes: [number, number][] = [base];
    for (let i = 1; i <= this.spec.widths.length; i++) sizes.push([Math.max(1, sizes[i - 1][0] >> 1), Math.max(1, sizes[i - 1][1] >> 1)]);
    let level = 0;
    let cur = this.alloc(base[0], base[1], this.spec.inChannels / 4);
    this.input = this.maps[cur];
    const skips: number[] = [];
    let pendingUp: { a: number; level: number } | null = null;
    for (const op of this.spec.ops) {
      if (op.op === 'conv') {
        const [w, h] = sizes[level];
        const out = this.alloc(w, h, op.outGroups);
        if (pendingUp) {
          this.steps.push({ kind: 'conv', op, a: pendingUp.a, b: skips[pendingUp.level], up: true, out });
          pendingUp = null;
        } else this.steps.push({ kind: 'conv', op, a: cur, b: -1, up: false, out });
        cur = out;
      } else if (op.op === 'skip') skips[op.level] = cur;
      else if (op.op === 'pool') {
        level++;
        const out = this.alloc(sizes[level][0], sizes[level][1], this.maps[cur].layers);
        this.steps.push({ kind: 'pool', src: cur, out });
        cur = out;
      } else if (op.op === 'up') { level = op.level; pendingUp = { a: cur, level: op.level }; }
      else if (op.op === 'residual') this.steps.push({ kind: 'residual', src: cur, mul: op.mode === 'mul', detail: !!this.spec.detail, achroma: !!this.spec.achroma });
    }
  }

  private draw(target: FeatureMap | null, layer: number, w: number, h: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? this.fbo : null);
    if (target) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, target.tex, 0, layer);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTex(unit: number, target: number, tex: WebGLTexture) { this.gl.activeTexture(this.gl.TEXTURE0 + unit); this.gl.bindTexture(target, tex); }

  /**
   * Shades one frame. Inputs are textures of the same size: the viewport's frame, albedo, normals
   * (alpha = coverage) and position (RGBA16F: depth ÷ far and height ÷ 64 studs). Draws to `target`
   * (a framebuffer, or the canvas when null). Call before three.js draws again: it leaves WebGL
   * state its own, so reset three's cache afterwards (renderer.resetState()). `albedoIsSRGBTexture`:
   * the albedo is a three.js sRGB render target (the GPU decodes it on read).
   */
  run(frame: WebGLTexture, albedo: WebGLTexture, normal: WebGLTexture, pos: WebGLTexture, target: WebGLFramebuffer | null = null, albedoIsSRGBTexture = false, vis: WebGLTexture | null = null, spec: WebGLTexture | null = null): void {
    const gl = this.gl;
    if (!this.steps.length) throw new Error('call resize() first');
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);

    const set1i = (p: WebGLProgram, name: string, v: number) => gl.uniform1i(gl.getUniformLocation(p, name), v);
    // 1. pack the G-buffers into the 12-channel input
    let p = this.programs.pack;
    gl.useProgram(p);
    this.bindTex(0, gl.TEXTURE_2D, frame); this.bindTex(1, gl.TEXTURE_2D, albedo); this.bindTex(2, gl.TEXTURE_2D, normal); this.bindTex(3, gl.TEXTURE_2D, pos); this.bindTex(4, gl.TEXTURE_2D, vis ?? this.whiteTex); this.bindTex(5, gl.TEXTURE_2D, spec ?? this.whiteTex);
    set1i(p, 'uFrame', 0); set1i(p, 'uAlbedo', 1); set1i(p, 'uNormal', 2); set1i(p, 'uPos', 3); set1i(p, 'uVis', 4); set1i(p, 'uSpec', 5); set1i(p, 'uUseSpec', this.spec.spec && spec ? 1 : 0); gl.uniform2i(gl.getUniformLocation(p, 'uFull'), this.width, this.height); set1i(p, 'uAlbedoSRGB', albedoIsSRGBTexture ? 1 : 0);
    set1i(p, 'uHalf', this.spec.half ? 1 : 0);
    for (let l = 0; l < this.input.layers; l++) { set1i(p, 'layer', l); this.draw(this.input, l, this.input.w, this.input.h); }

    // 2. the network
    const timer = this.profile ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
    const timed = (name: string, work: () => void) => {
      if (!timer) return work();
      const q = gl.createQuery()!;
      gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
      work();
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      this.pending.push({ name, query: q });
    };
    let stepIndex = 0;
    for (const s of this.steps) {
      if (stepIndex++ >= this.debugSteps) break;
      timed(s.kind === 'conv' ? s.op.name : s.kind, () => {
      if (s.kind === 'conv') {
        const out = this.maps[s.out], a = this.maps[s.a], b = s.b >= 0 ? this.maps[s.b] : a;
        const nIn = a.layers + (s.b >= 0 ? b.layers : 0), mats = nIn * s.op.k * s.op.k;
        const inUniforms = mats <= MAXMAT;
        p = inUniforms ? this.programs.convU : this.programs.conv;
        gl.useProgram(p);
        this.bindTex(0, gl.TEXTURE_2D_ARRAY, a.tex); this.bindTex(1, gl.TEXTURE_2D_ARRAY, b.tex); this.bindTex(2, gl.TEXTURE_2D, this.weights);
        set1i(p, 'uA', 0); set1i(p, 'uB', 1); set1i(p, 'uW', 2);
        set1i(p, 'nA', a.layers); set1i(p, 'nB', s.b >= 0 ? b.layers : 0); set1i(p, 'K', s.op.k); set1i(p, 'relu', s.op.relu ? 1 : 0);
        set1i(p, 'outGroups', s.op.outGroups); set1i(p, 'aUp', s.up ? 1 : 0); set1i(p, 'wBase', s.op.offset / 4);
        gl.uniform2i(gl.getUniformLocation(p, 'size'), out.w, out.h);
        for (let g = 0; g < s.op.outGroups; g++) {
          set1i(p, 'outGroup', g);
          if (inUniforms) {
            // this output group's matrices are contiguous in the weight blob: 16 floats each, column-major like a mat4
            const start = s.op.offset + g * mats * 16;
            gl.uniformMatrix4fv(gl.getUniformLocation(p, 'uWm'), false, this.weightData.subarray(start, start + mats * 16));
            const bias = s.op.offset + s.op.outGroups * mats * 16 + g * 4;
            gl.uniform4fv(gl.getUniformLocation(p, 'uBias'), this.weightData.subarray(bias, bias + 4));
          }
          this.draw(out, g, out.w, out.h);
        }
      } else if (s.kind === 'pool') {
        p = this.programs.pool;
        gl.useProgram(p);
        const out = this.maps[s.out], a = this.maps[s.src];
        this.bindTex(0, gl.TEXTURE_2D_ARRAY, a.tex); set1i(p, 'uA', 0);
        for (let l = 0; l < out.layers; l++) { set1i(p, 'layer', l); this.draw(out, l, out.w, out.h); }
      } else {
        p = s.detail ? this.programs.finalDetail : s.mul ? this.programs.finalMul : this.programs.final;
        gl.useProgram(p);
        this.bindTex(0, gl.TEXTURE_2D, frame); this.bindTex(1, gl.TEXTURE_2D_ARRAY, this.maps[s.src].tex);
        if (s.detail) { this.bindTex(2, gl.TEXTURE_2D, normal); this.bindTex(3, gl.TEXTURE_2D, pos); this.bindTex(4, gl.TEXTURE_2D, spec ?? this.whiteTex); this.bindTex(5, gl.TEXTURE_2D_ARRAY, this.input.tex); set1i(p, 'uNormal', 2); set1i(p, 'uPos', 3); set1i(p, 'uSpecMap', 4); set1i(p, 'uGuide', 5); gl.uniform2i(gl.getUniformLocation(p, 'uHalfSize'), this.input.w, this.input.h); const dbg = (globalThis as { __neuralDebug?: { spec?: number; edge?: number } }).__neuralDebug; gl.uniform2f(gl.getUniformLocation(p, 'uDetailScale'), dbg?.spec ?? 1, dbg?.edge ?? 1); gl.uniform1i(gl.getUniformLocation(p, 'uAchroma'), s.achroma ? 1 : 0); gl.uniform1f(gl.getUniformLocation(p, 'uGreyScale'), (globalThis as { __neuralDebug?: { grey?: number } }).__neuralDebug?.grey ?? 0); }
        set1i(p, 'uFrame', 0); set1i(p, 'uOut', 1); set1i(p, 'uHalf', this.spec.half ? 1 : 0); gl.uniform2i(gl.getUniformLocation(p, 'uFull'), this.width, this.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target);
        gl.viewport(0, 0, this.width, this.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      });
    }
    gl.bindVertexArray(null);
  }

  /** Collects finished GPU timings into `profile` (call after the frames have completed). */
  collectProfile(): void {
    const gl = this.gl;
    const rest: typeof this.pending = [];
    for (const { name, query } of this.pending) {
      if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
        this.profile?.set(name, (this.profile.get(name) ?? 0) + (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6);
        gl.deleteQuery(query);
      } else rest.push({ name, query });
    }
    this.pending = rest;
  }

  dispose(): void {
    for (const m of this.maps) this.gl.deleteTexture(m.tex);
    this.gl.deleteTexture(this.weights);
    this.gl.deleteTexture(this.whiteTex);
    this.gl.deleteFramebuffer(this.fbo);
  }
}
