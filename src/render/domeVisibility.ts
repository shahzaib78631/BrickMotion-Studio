import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { MeshBVH, MeshBVHUniformStruct, BVHShaderGLSL, SAH, CENTER } from 'three-mesh-bvh';

/**
 * Ray-traced dome visibility: for every visible pixel, the fraction of the cosine-weighted
 * hemisphere around the surface normal that no brick (and, for downward rays, no floor) blocks
 * within `maxDistance` studs. This is what EyeSight's uniform white world light "sees", which a
 * short-radius screen-space AO cannot: a brick deep inside a dense model is shadowed by bricks
 * many studs away, and by bricks that are off screen or hidden behind others.
 *
 * Pipeline, every call to render():
 *  1. prepass   (full res)  bricks drawn once more: exact world position + geometric normal (RGBA32F MRT)
 *  2. trace     (scale res) N cosine rays / pixel against a GPU BVH of all bricks (three-mesh-bvh
 *                           packed textures, custom any-hit traversal with a max length) + the floor
 *                           plane; floor pixels (no brick) are found by intersecting the view ray with
 *                           y = groundY. Result blended into a history buffer reprojected from the last
 *                           frame (world-position reprojection, distance test), so the estimate
 *                           converges while still and degrades gracefully while moving.
 *  3. filter    (scale res) joint bilateral (plane distance + normal) 5x5 blur of the history, wider
 *                           where few samples have accumulated.
 *  4. composite (full res)  depth-aware 2x2 upsample, frame *= mix(1, vis^power, strength * faceWeight).
 * The returned texture's red channel is the visibility 0..1 (1 = the whole dome is open).
 *
 * The BVH is built over ONE merged, world-space copy of every opaque brick (instances expanded).
 * Rebuild with rebuild() when pieces are added/removed; refit() when only matrices changed.
 */
export type DomeOptions = {
  /** rays per traced pixel per frame */
  rays: number;
  /** longest ray, studs; hits beyond do not occlude */
  maxDistance: number;
  /** trace resolution relative to the output (0.5 = a quarter of the pixels) */
  scale: number;
  /** most frames the still image averages (the history weight is 1/min(n, cap)) */
  maxFrames: number;
  /** history cap while the camera moves (smaller = less ghosting, more noise) */
  movingFrames: number;
  /** floor height, studs; NaN = no floor */
  groundY: number;
  /** bilateral blur radius in trace texels at 1 sample (shrinks with 1/sqrt(samples)) */
  blur: number;
  /** how much light a ray that hits the floor still brings (one bounce off a white floor), 0..1 */
  floorBounce: number;
};

const DEFAULTS: DomeOptions = { rays: 2, maxDistance: 16, scale: 0.5, maxFrames: 64, movingFrames: 8, groundY: 0, blur: 4, floorBounce: 1 };

const FS_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const PREPASS_VERT = /* glsl */ `
  out vec3 vW;
  void main() {
    vec4 pos = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      pos = instanceMatrix * pos;
    #endif
    vec4 w = modelMatrix * pos; vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const PREPASS_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 camPos;
  in vec3 vW;
  layout(location = 0) out vec4 gPos;
  layout(location = 1) out vec4 gNormal;
  void main() {
    // geometric (flat) normal: the true surface the rays leave from, no smooth-normal leaks
    vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
    if (dot(n, camPos - vW) < 0.0) n = -n;
    gPos = vec4(vW, 1.0);
    gNormal = vec4(n, 1.0);
  }`;

/** Shared GLSL: surface (brick or floor) at a full-res pixel. */
const SURFACE_GLSL = /* glsl */ `
  uniform sampler2D tPos; uniform sampler2D tNrm;
  uniform mat4 invViewProj; uniform vec3 camPos; uniform float groundY; uniform float hasFloor; uniform vec2 fullSize;
  // returns false for background (sky)
  bool surfaceAt(ivec2 px, out vec3 P, out vec3 N) {
    vec4 p = texelFetch(tPos, px, 0);
    if (p.w > 0.5) { P = p.xyz; N = texelFetch(tNrm, px, 0).xyz; return true; }
    if (hasFloor < 0.5) return false;
    vec2 ndc = (vec2(px) + 0.5) / fullSize * 2.0 - 1.0;
    vec4 a = invViewProj * vec4(ndc, -1.0, 1.0); a /= a.w;
    vec4 b = invViewProj * vec4(ndc, 1.0, 1.0); b /= b.w;
    vec3 d = b.xyz - a.xyz;
    if (abs(d.y) < 1e-6) return false;
    float t = (groundY - a.y) / d.y;
    if (t <= 0.0 || t >= 1.0) return false;
    P = a.xyz + d * t; N = vec3(0.0, 1.0, 0.0);
    return true;
  }`;

const TRACE_FRAG = /* glsl */ `
  precision highp float; precision highp int; precision highp usampler2D;
  #define BVH_STACK_DEPTH 48
  ${BVHShaderGLSL.bvh_struct_definitions}
  ${BVHShaderGLSL.common_functions}
  ${BVHShaderGLSL.bvh_ray_functions}
  ${SURFACE_GLSL}
  uniform BVH bvh;
  uniform sampler2D tHist; uniform mat4 prevViewProj; uniform vec3 prevCamPos; uniform float hasHist;
  uniform float frame; uniform float floorBounce; uniform float maxDist; uniform float cap; uniform vec2 traceSize;
  varying vec2 vUv;

  // any hit closer than tMax (shadow ray): stops at the first triangle found
  bool anyHit(vec3 o, vec3 d, float tMax) {
    int ptr = 0; uint stack[BVH_STACK_DEPTH]; stack[0] = 0u;
    while (ptr > -1 && ptr < BVH_STACK_DEPTH) {
      uint node = stack[ptr]; ptr--;
      float bd;
      if (!intersectsBVHNodeBounds(o, d, bvh.bvhBounds, node, bd) || bd > tMax) continue;
      uvec2 info = uTexelFetch1D(bvh.bvhContents, node).xy;
      if (bool(info.x & 0xffff0000u)) {
        uint count = info.x & 0x0000ffffu, off = info.y;
        for (uint i = off; i < off + count; i++) {
          uvec3 ix = uTexelFetch1D(bvh.index, i).xyz;
          vec3 a = texelFetch1D(bvh.position, ix.x).rgb, b = texelFetch1D(bvh.position, ix.y).rgb, c = texelFetch1D(bvh.position, ix.z).rgb;
          vec3 bc, tn; float dist, side;
          if (intersectsTriangle(o, d, a, b, c, bc, tn, dist, side) && dist > 1e-4 && dist < tMax) return true;
        }
      } else {
        uint left = node + 1u, right = node + info.y, axis = info.x & 0x0000ffffu;
        bool ltr = d[axis] >= 0.0;
        ptr++; stack[ptr] = ltr ? right : left;
        ptr++; stack[ptr] = ltr ? left : right;
      }
    }
    return false;
  }

  // normal quantised to 5+5 bits (octahedral), an integer a half float stores exactly
  vec2 oct(vec3 n) { n /= abs(n.x) + abs(n.y) + abs(n.z); vec2 e = n.xy; if (n.z < 0.0) e = (1.0 - abs(e.yx)) * vec2(e.x >= 0.0 ? 1.0 : -1.0, e.y >= 0.0 ? 1.0 : -1.0); return e; }
  vec3 unoct(vec2 e) { vec3 n = vec3(e, 1.0 - abs(e.x) - abs(e.y)); if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0); return normalize(n); }
  float packN(vec3 n) { vec2 q = floor((oct(n) * 0.5 + 0.5) * 31.0 + 0.5); return q.x + q.y * 32.0 + 1.0; }
  vec3 unpackN(float p) { p -= 1.0; vec2 q = vec2(mod(p, 32.0), floor(p / 32.0)); return unoct(q / 31.0 * 2.0 - 1.0); }

  uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
  float u01(uint v) { return float(pcg(v)) / 4294967296.0; }

  void main() {
    ivec2 tp = ivec2(gl_FragCoord.xy);
    ivec2 px = ivec2((vec2(tp) + 0.5) * fullSize / traceSize);
    vec3 P, N;
    if (!surfaceAt(px, P, N)) { gl_FragColor = vec4(1.0, 0.0, -1.0, 0.0); return; }
    float dist = length(P - camPos);
    vec3 o = P + N * (0.004 + dist * 0.0004);
    // orthonormal basis (Duff et al. 2017)
    float sg = N.z >= 0.0 ? 1.0 : -1.0; float aa = -1.0 / (sg + N.z); float bb = N.x * N.y * aa;
    vec3 T = vec3(1.0 + sg * N.x * N.x * aa, sg * bb, -sg * N.x); vec3 B = vec3(bb, sg + N.y * N.y * aa, -N.y);
    // per pixel scramble of a frame-by-frame R2 sequence: low discrepancy over time
    uint seed = pcg(uint(tp.x) * 1973u + uint(tp.y) * 9277u);
    vec2 jitter = vec2(u01(seed), u01(seed ^ 0x9e3779b9u));
    float open = 0.0;
    for (int i = 0; i < RAYS; i++) {
      float k = frame * float(RAYS) + float(i);
      vec2 u = fract(jitter + k * vec2(0.7548776662, 0.5698402910));
      float r = sqrt(u.x), phi = 6.2831853 * u.y;
      vec3 d = normalize(T * (r * cos(phi)) + B * (r * sin(phi)) + N * sqrt(max(0.0, 1.0 - u.x)));
      float tFloor = (hasFloor > 0.5 && d.y < 0.0) ? (groundY - o.y) / d.y : 1e9;
      // a brick before the floor blocks fully; the floor itself sends some light back up
      if (anyHit(o, d, min(maxDist, tFloor))) continue;
      open += tFloor < maxDist ? floorBounce : 1.0;
    }
    float vis = open / float(RAYS);
    // reproject the history: same world point seen from the last camera, at the same distance
    float n = 0.0, prev = vis;
    if (hasHist > 0.5) {
      vec4 c = prevViewProj * vec4(P, 1.0);
      if (c.w > 0.0) {
        vec2 puv = c.xy / c.w * 0.5 + 0.5;
        if (all(greaterThanEqual(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
          vec4 h = texelFetch(tHist, ivec2(puv * traceSize), 0);
          float expect = length(P - prevCamPos);
          // same distance and same facing: the same surface (not the stud top next to a side face)
          if (h.z > 0.0 && h.w > 0.5 && abs(h.z - expect) < 0.004 * expect + 0.03 && dot(unpackN(h.w), N) > 0.8) { n = min(h.y, cap - 1.0); prev = h.x; }
        }
      }
    }
    float m = mix(prev, vis, 1.0 / (n + 1.0));
    gl_FragColor = vec4(m, n + 1.0, dist, packN(N));
  }`;

const FILTER_FRAG = /* glsl */ `
  precision highp float;
  ${SURFACE_GLSL}
  uniform sampler2D tHist; uniform vec2 traceSize; uniform float blur;
  varying vec2 vUv;
  // runs at trace resolution: one full-res surface sample per trace texel (the one it traced)
  ivec2 fullOf(ivec2 t) { return ivec2((vec2(t) + 0.5) * fullSize / traceSize); }
  void main() {
    ivec2 tp = ivec2(gl_FragCoord.xy);
    vec4 h0 = texelFetch(tHist, tp, 0);
    vec3 P, N;
    if (!surfaceAt(fullOf(tp), P, N)) { gl_FragColor = vec4(1.0, -1.0, 0.0, 1.0); return; }
    // wide while few samples, ~1 texel when converged (radius in trace texels)
    float rad = max(1.0, blur * inversesqrt(max(h0.y, 1.0)));
    float dist = length(P - camPos);
    float sum = 0.0, wsum = 0.0;
    for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
      vec2 o = vec2(float(x), float(y)) * 0.5 * rad;
      ivec2 q = clamp(tp + ivec2(round(o)), ivec2(0), ivec2(traceSize) - 1);
      vec3 Pq, Nq;
      if (!surfaceAt(fullOf(q), Pq, Nq)) continue;
      float plane = abs(dot(Pq - P, N)) / (0.002 * dist + 0.01);
      vec4 h = texelFetch(tHist, q, 0);
      // gaussian x same plane x same facing x trust in the samples it has
      float w = exp(-dot(o, o) / (0.5 * rad * rad + 1e-3)) * exp(-plane * plane) * pow(max(dot(N, Nq), 0.0), 8.0) * h.y;
      sum += h.x * w; wsum += w;
    }
    gl_FragColor = vec4(wsum > 0.0 ? sum / wsum : h0.x, dist, 0.0, 1.0);
  }`;

// full res: joint bilateral upsample of the filtered trace-res visibility (2x2 taps, distance-matched)
const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  ${SURFACE_GLSL}
  uniform sampler2D tVis; uniform vec2 traceSize;
  uniform float strength; uniform float sides; uniform float floorK; uniform float power; uniform float fixedVis;
  varying vec2 vUv;
  void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    vec3 P, N;
    if (!surfaceAt(px, P, N)) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    bool brick = texelFetch(tPos, px, 0).w > 0.5;
    float v = fixedVis;
    if (v < 0.0) {
      float dist = length(P - camPos);
      vec2 f = (vec2(px) + 0.5) * traceSize / fullSize - 0.5;
      ivec2 b = ivec2(floor(f)); vec2 fr = f - vec2(b);
      float sum = 0.0, wsum = 0.0;
      for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
        vec4 t = texelFetch(tVis, clamp(b + ivec2(i, j), ivec2(0), ivec2(traceSize) - 1), 0);
        float bw = (i == 0 ? 1.0 - fr.x : fr.x) * (j == 0 ? 1.0 - fr.y : fr.y);
        float dw = t.y < 0.0 ? 0.0 : exp(-abs(t.y - dist) / (0.01 * dist + 0.02));
        sum += t.x * bw * dw; wsum += bw * dw;
      }
      v = wsum > 1e-4 ? sum / wsum : texture2D(tVis, vUv).x;
    }
    float face = brick ? mix(sides, 1.0, smoothstep(0.35, 0.85, N.y)) : floorK;
    gl_FragColor = vec4(0.0, 0.0, 0.0, mix(1.0, pow(clamp(v, 0.0, 1.0), power), clamp(strength * face, 0.0, 1.0)));
  }`;

export type DomeComposite = { /** 0..1 how much of the frame the dome lights */ strength: number; /** weight on upright faces */ sides?: number; /** weight on the floor */ floor?: number; /** curve on visibility */ power?: number; /** A/B control: a constant in place of the traced visibility */ fixed?: number };

export class DomeVisibility {
  readonly options: DomeOptions;
  /** world position (xyz, w = 1 on bricks) and geometric normal, full res, from the last render() */
  readonly prepass: THREE.WebGLRenderTarget;
  private hist: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private out: THREE.WebGLRenderTarget;
  private prepassMat: THREE.ShaderMaterial;
  private traceMat: THREE.ShaderMaterial;
  private filterMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private quad = new FullScreenQuad();
  private bvh: MeshBVH | null = null;
  private bvhUniform = new MeshBVHUniformStruct();
  private geometry: THREE.BufferGeometry | null = null;
  private sources: { mesh: THREE.Mesh; instances: number[]; verts: number }[] = [];
  private root: THREE.Object3D | null = null;
  private frame = 0;
  private hasHist = false;
  private prevViewProj = new THREE.Matrix4();
  private prevCamPos = new THREE.Vector3();
  private width = 1;
  private height = 1;
  /** profiling hook: called around each GPU stage of render() (e.g. to wrap them in timer queries) */
  stageHook: ((stage: 'prepass' | 'trace' | 'filter', phase: 'begin' | 'end') => void) | null = null;
  /** triangles in the BVH and the last build/refit time (ms, CPU) */
  readonly stats = { triangles: 0, buildMs: 0, refitMs: 0 };

  constructor(private renderer: THREE.WebGLRenderer, options: Partial<DomeOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.prepass = new THREE.WebGLRenderTarget(1, 1, { count: 2, type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, colorSpace: THREE.NoColorSpace });
    const hrt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, colorSpace: THREE.NoColorSpace });
    this.hist = [hrt(), hrt()];
    this.out = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, colorSpace: THREE.NoColorSpace });
    this.prepassMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: PREPASS_VERT, fragmentShader: PREPASS_FRAG, side: THREE.DoubleSide, uniforms: { camPos: { value: new THREE.Vector3() } } });
    const surf = () => ({ tPos: { value: null }, tNrm: { value: null }, invViewProj: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() }, groundY: { value: 0 }, hasFloor: { value: 1 }, fullSize: { value: new THREE.Vector2(1, 1) } });
    this.traceMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: TRACE_FRAG, defines: { RAYS: this.options.rays }, depthTest: false, depthWrite: false,
      uniforms: { ...surf(), bvh: { value: this.bvhUniform }, tHist: { value: null }, prevViewProj: { value: new THREE.Matrix4() }, prevCamPos: { value: new THREE.Vector3() }, hasHist: { value: 0 }, frame: { value: 0 }, floorBounce: { value: 0 }, maxDist: { value: 16 }, cap: { value: 64 }, traceSize: { value: new THREE.Vector2(1, 1) } },
    });
    this.filterMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: FILTER_FRAG, depthTest: false, depthWrite: false,
      uniforms: { ...surf(), tHist: { value: null }, traceSize: { value: new THREE.Vector2(1, 1) }, blur: { value: 6 } },
    });
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: COMPOSITE_FRAG, depthTest: false, depthWrite: false, transparent: true,
      uniforms: { ...surf(), tVis: { value: null }, traceSize: { value: new THREE.Vector2(1, 1) }, strength: { value: 1 }, sides: { value: 1 }, floorK: { value: 1 }, power: { value: 1 }, fixedVis: { value: -1 } },
      // frame * alpha, the frame's own alpha untouched (same blending as StudioAO)
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
  }

  /** Changes options; a different ray count recompiles the trace shader. Restarts accumulation. */
  set(o: Partial<DomeOptions>): void {
    if (o.rays !== undefined && o.rays !== this.options.rays) { this.traceMat.defines.RAYS = o.rays; this.traceMat.needsUpdate = true; }
    const resize = o.scale !== undefined && o.scale !== this.options.scale;
    Object.assign(this.options, o);
    if (resize) this.setSize(this.width, this.height);
    this.reset();
  }

  /** Output size in drawing-buffer pixels. */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width)); this.height = Math.max(1, Math.round(height));
    this.prepass.setSize(this.width, this.height);
    const tw = Math.max(1, Math.round(this.width * this.options.scale)), th = Math.max(1, Math.round(this.height * this.options.scale));
    for (const h of this.hist) h.setSize(tw, th);
    this.out.setSize(tw, th);
    this.reset();
  }

  /** Uses the bricks under `root` (e.g. studio.bricks.root) as occluders and builds the BVH. */
  setScene(root: THREE.Object3D): void { this.root = root; this.rebuild(); }

  private collect(): void {
    this.sources = [];
    const root = this.root!;
    root.updateMatrixWorld(true);
    const m = new THREE.Matrix4();
    root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.every((x) => x.transparent && x.opacity < 0.95) || mats.every((x) => (x as THREE.MeshPhysicalMaterial).transmission > 0.5)) return;
      const inst = mesh as THREE.InstancedMesh;
      const instances: number[] = [];
      if (inst.isInstancedMesh) {
        for (let i = 0; i < inst.count; i++) { inst.getMatrixAt(i, m); if (Math.abs(m.determinant()) > 1e-12) instances.push(i); }
      } else instances.push(-1);
      if (instances.length) this.sources.push({ mesh, instances, verts: mesh.geometry.attributes.position.count });
    });
  }

  /** Writes every instance's world-space vertices into `pos`. */
  private fill(pos: Float32Array): void {
    const m = new THREE.Matrix4(), im = new THREE.Matrix4(), v = new THREE.Vector3();
    let off = 0;
    for (const s of this.sources) {
      const p = s.mesh.geometry.attributes.position as THREE.BufferAttribute;
      for (const i of s.instances) {
        m.copy(s.mesh.matrixWorld);
        if (i >= 0) { (s.mesh as THREE.InstancedMesh).getMatrixAt(i, im); m.multiply(im); }
        const e = m.elements;
        for (let k = 0; k < s.verts; k++) {
          v.fromBufferAttribute(p, k);
          pos[off++] = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12];
          pos[off++] = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
          pos[off++] = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14];
        }
      }
    }
  }

  /** Full rebuild: pieces added/removed/hidden. Cost grows with triangles (see stats.buildMs). */
  rebuild(): void {
    if (!this.root) return;
    const t0 = performance.now();
    this.collect();
    let verts = 0, tris = 0;
    for (const s of this.sources) {
      const g = s.mesh.geometry;
      verts += s.verts * s.instances.length;
      tris += ((g.index ? g.index.count : s.verts) / 3) * s.instances.length;
    }
    const pos = new Float32Array(Math.max(verts, 3) * 3);
    const index = new Uint32Array(Math.max(tris, 1) * 3);
    let io = 0, base = 0;
    for (const s of this.sources) {
      const g = s.mesh.geometry;
      for (let n = 0; n < s.instances.length; n++) {
        if (g.index) { const ix = g.index.array; for (let k = 0; k < g.index.count; k++) index[io++] = ix[k] + base; }
        else for (let k = 0; k < s.verts; k++) index[io++] = k + base;
        base += s.verts;
      }
    }
    this.fill(pos);
    this.geometry?.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.geometry = geometry;
    this.bvh = new MeshBVH(geometry, { strategy: tris > 600_000 ? CENTER : SAH, maxLeafSize: 8 });
    this.bvhUniform.updateFrom(this.bvh);
    this.stats.triangles = tris;
    this.stats.buildMs = performance.now() - t0;
    this.reset();
  }

  /**
   * Same pieces, new matrices (an animation step): rewrites the vertices and refits the BVH
   * bounds without rebuilding the tree. The tree gets slower as pieces move far from where it
   * was built; rebuild() now and then. Pieces that change visibility need rebuild().
   */
  refit(): void {
    if (!this.bvh || !this.geometry || !this.root) return;
    const t0 = performance.now();
    this.root.updateMatrixWorld(true);
    const attr = this.geometry.attributes.position as THREE.BufferAttribute;
    this.fill(attr.array as Float32Array);
    attr.needsUpdate = true;
    this.bvh.refit();
    this.bvhUniform.updateFrom(this.bvh);
    this.stats.refitMs = performance.now() - t0;
    this.reset();
  }

  /** Forget the accumulated history (model or lighting changed). */
  reset(): void { this.hasHist = false; }

  /** Number of frames accumulated at the centre pixel is not tracked on the CPU; this counts render() calls since reset. */
  get frames(): number { return this.frame; }

  private surfUniforms(u: Record<string, THREE.IUniform>, camera: THREE.Camera, invViewProj: THREE.Matrix4): void {
    u.tPos.value = this.prepass.textures[0];
    u.tNrm.value = this.prepass.textures[1];
    u.invViewProj.value.copy(invViewProj);
    u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
    const g = this.options.groundY;
    u.groundY.value = Number.isFinite(g) ? g : 0;
    u.hasFloor.value = Number.isFinite(g) ? 1 : 0;
    u.fullSize.value.set(this.width, this.height);
  }

  /**
   * One accumulation step for `camera` (call once per frame, after the frame is drawn or before:
   * it leaves the render target, viewport and clear state as it found them).
   * Returns the filtered visibility at TRACE resolution (r = visibility 0..1, g = distance to the
   * camera for a depth-aware upsample, g < 0 = sky). composite() does that upsample.
   */
  render(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): THREE.Texture {
    const r = this.renderer, root = this.root;
    if (!root || !this.bvh) return this.out.texture;
    const prev = { target: r.getRenderTarget(), alpha: r.getClearAlpha(), color: r.getClearColor(new THREE.Color()), auto: r.autoClear, shadow: r.shadowMap.autoUpdate, tone: r.toneMapping };
    camera.updateMatrixWorld();
    const viewProj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const invViewProj = viewProj.clone().invert();
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    try {
      // 1. prepass: bricks only, flat materials
      const meshes: THREE.Mesh[] = [], hidden: THREE.Object3D[] = [];
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
        else if (((o as THREE.Line).isLine || (o as THREE.Points).isPoints) && o.visible) { o.visible = false; hidden.push(o); }
      });
      const original = meshes.map((m) => m.material);
      for (const m of meshes) m.material = this.prepassMat;
      this.prepassMat.uniforms.camPos.value.copy(camPos);
      r.shadowMap.autoUpdate = false; r.autoClear = true; r.toneMapping = THREE.NoToneMapping;
      this.stageHook?.('prepass', 'begin');
      r.setRenderTarget(this.prepass); r.setClearColor(0x000000, 0); r.clear();
      try { r.render(root, camera); } finally {
        this.stageHook?.('prepass', 'end');
        meshes.forEach((m, i) => { m.material = original[i]; });
        for (const o of hidden) o.visible = true;
      }
      // 2. trace + temporal accumulation (ping-pong)
      const [src, dst] = this.hist;
      const moved = !this.prevViewProj.equals(viewProj);
      const tu = this.traceMat.uniforms;
      this.surfUniforms(tu, camera, invViewProj);
      tu.tHist.value = src.texture;
      tu.prevViewProj.value.copy(this.hasHist ? this.prevViewProj : viewProj);
      tu.prevCamPos.value.copy(this.hasHist ? this.prevCamPos : camPos);
      tu.hasHist.value = this.hasHist ? 1 : 0;
      tu.frame.value = this.frame++ % 4096;
      tu.maxDist.value = this.options.maxDistance;
      tu.floorBounce.value = this.options.floorBounce;
      tu.cap.value = moved ? this.options.movingFrames : this.options.maxFrames;
      tu.traceSize.value.set(dst.width, dst.height);
      this.quad.material = this.traceMat;
      this.stageHook?.('trace', 'begin');
      r.setRenderTarget(dst); this.quad.render(r);
      this.stageHook?.('trace', 'end');
      this.hist = [dst, src];
      this.hasHist = true;
      this.prevViewProj.copy(viewProj); this.prevCamPos.copy(camPos);
      // 3. bilateral filter + upsample
      const fu = this.filterMat.uniforms;
      this.surfUniforms(fu, camera, invViewProj);
      fu.tHist.value = dst.texture;
      fu.traceSize.value.set(dst.width, dst.height);
      fu.blur.value = this.options.blur;
      this.quad.material = this.filterMat;
      this.stageHook?.('filter', 'begin');
      r.setRenderTarget(this.out); this.quad.render(r);
      this.stageHook?.('filter', 'end');
    } finally {
      r.setRenderTarget(prev.target); r.setClearColor(prev.color, prev.alpha);
      r.autoClear = prev.auto; r.shadowMap.autoUpdate = prev.shadow; r.toneMapping = prev.tone;
    }
    return this.out.texture;
  }

  /** The last visibility texture. */
  get texture(): THREE.Texture { return this.out.texture; }

  /**
   * Multiplies whatever is in the current render target (the finished frame) by
   * mix(1, visibility^power, strength * faceWeight). Call right after render() with the same
   * camera, the output render target bound and a viewport covering the whole output.
   */
  composite(o: DomeComposite): void {
    const r = this.renderer, u = this.compMat.uniforms;
    u.tVis.value = this.out.texture; u.traceSize.value.set(this.out.width, this.out.height);
    for (const k of ['tPos', 'tNrm', 'invViewProj', 'camPos', 'groundY', 'hasFloor', 'fullSize']) u[k].value = this.filterMat.uniforms[k].value;
    u.strength.value = o.strength; u.sides.value = o.sides ?? 1; u.floorK.value = o.floor ?? 1; u.power.value = o.power ?? 1; u.fixedVis.value = o.fixed ?? -1;
    const auto = r.autoClear; r.autoClear = false;
    try { this.quad.material = this.compMat; this.quad.render(r); } finally { r.autoClear = auto; }
  }

  dispose(): void {
    this.prepass.dispose(); for (const h of this.hist) h.dispose(); this.out.dispose();
    for (const m of [this.prepassMat, this.traceMat, this.filterMat, this.compMat]) m.dispose();
    this.quad.dispose(); this.bvhUniform.dispose(); this.geometry?.dispose();
  }
}
