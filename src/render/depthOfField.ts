/**
 * Depth of field for final renders and MP4 frames: a lens blur applied to the finished
 * picture, driven by a depth render of the bricks and the floor.
 *
 * It works on the finished image (not inside the path tracer) because a final render is
 * put together from several passes (see pathTracedStill.ts): a blur inside one of them
 * would leave sharp cut-out edges. Applied at the end, the floor, the backdrop and the
 * bricks blur together.
 *
 * The blur is a single-pass "scatter as gather" disc (after Dennis Gustafsson): each
 * pixel collects samples along a golden-angle spiral, and a sample counts as far as its
 * own blur reaches. Sharp things in front stay sharp; blurred things in front spill over
 * what is behind them, as a real lens does. Colours are blurred in linear light, so
 * highlights open into round bokeh.
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { LENS_BLUR_PX, type LensChoice } from './looks';

/**
 * Blur radius in pixels at a depth, for a lens focused at `focus` whose largest blur is
 * `maxPx`. Thin-lens shape: zero at the focus, growing with |1 − focus/depth|, so the far
 * background reaches about a third of the way to the maximum and near things grow fast.
 */
export function blurRadius(depth: number, focus: number, maxPx: number): number {
  if (maxPx <= 0) return 0;
  if (!(depth > 0) || !Number.isFinite(depth)) return maxPx;
  return Math.min(maxPx, Math.abs(1 - focus / depth) * maxPx * 3);
}

/** The largest blur for a frame `height` pixels tall. */
export const maxBlurPx = (lens: LensChoice, height: number) => (lens.px ?? LENS_BLUR_PX[lens.blur] ?? 0) * (height / 1080);

export type FrameRect = { x: number; y: number; width: number; height: number };
/** A frame inside the canvas (CSS pixels, top-left origin) in device pixels from the bottom left, as WebGL counts. */
export function frameRegion(frame: FrameRect, cssHeight: number, pixelRatio: number): FrameRect {
  return {
    x: Math.round(frame.x * pixelRatio), y: Math.round((cssHeight - frame.y - frame.height) * pixelRatio),
    width: Math.max(1, Math.round(frame.width * pixelRatio)), height: Math.max(1, Math.round(frame.height * pixelRatio)),
  };
}

/**
 * Distance from the camera to the plane in focus: `focus` 0 is the nearest corner of
 * `box` along the view direction, 1 the farthest.
 */
export function focusDistance(camera: THREE.Camera, box: THREE.Box3, focus: number): number {
  camera.updateMatrixWorld();
  const pos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  let near = Infinity, far = -Infinity;
  const c = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const d = c.sub(pos).dot(fwd);
    near = Math.min(near, d);
    far = Math.max(far, d);
  }
  const minD = (camera as THREE.PerspectiveCamera).near ?? 0.1;
  near = Math.max(near, minD);
  far = Math.max(far, near + 1e-3);
  return near + (far - near) * Math.min(1, Math.max(0, focus));
}

// the distance itself is interpolated (exact across a triangle, even one clipped by the
// camera plane, like the floor); its inverse is taken per pixel
const DEPTH_VERT = /* glsl */ `
#include <common>
varying float vDepth;
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  vDepth = -mvPosition.z;
}`;
const DEPTH_FRAG = /* glsl */ `
varying float vDepth;
void main() { gl_FragColor = vec4(1.0 / max(vDepth, 1e-3), 0.0, 0.0, 1.0); }`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 texel;
uniform float focus;
uniform float maxR;
uniform float radScale;
uniform bool flipColor;
varying vec2 vUv;
const float GOLDEN = 2.39996323;
float coc(float inv) { return min(maxR, abs(1.0 - focus * inv) * maxR * 3.0); }
vec3 lin(vec2 uv) {
  vec4 c = texture2D(tColor, flipColor ? vec2(uv.x, 1.0 - uv.y) : uv);
  return pow(c.rgb, vec3(2.2));
}
void main() {
  float cInv = texture2D(tDepth, vUv).r;
  float cSize = coc(cInv);
  vec3 col = lin(vUv);
  float tot = 1.0;
  float radius = radScale;
  float ang = 0.0;
  for (int i = 0; i < 2000; i++) {
    if (radius >= maxR) break;
    vec2 tc = vUv + vec2(cos(ang), sin(ang)) * texel * radius;
    float sInv = texture2D(tDepth, tc).r;
    float sSize = coc(sInv);
    // a sample behind this pixel cannot blur over it more than this pixel blurs itself
    if (sInv < cInv) sSize = clamp(sSize, 0.0, cSize * 2.0);
    float m = smoothstep(radius - 0.5, radius + 0.5, sSize);
    col += mix(col / tot, lin(tc), m);
    tot += 1.0;
    ang += GOLDEN;
    radius += radScale / radius;
  }
  gl_FragColor = vec4(pow(col / tot, vec3(1.0 / 2.2)), 1.0);
}`;

/** The lens blur, bound to one renderer. */
export class LensPass {
  private depthTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
  private depthMaterial = new THREE.ShaderMaterial({ vertexShader: DEPTH_VERT, fragmentShader: DEPTH_FRAG, side: THREE.DoubleSide });
  private blur = new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: null }, tDepth: { value: null }, texel: { value: new THREE.Vector2() },
      focus: { value: 1 }, maxR: { value: 0 }, radScale: { value: 0.5 }, flipColor: { value: false },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: BLUR_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  private quad = new FullScreenQuad(this.blur);
  private frame: THREE.FramebufferTexture | null = null;
  private image: THREE.DataTexture | null = null;
  private floorGeometry = new THREE.PlaneGeometry(4000, 4000);
  private floor = new THREE.Mesh(this.floorGeometry, this.depthMaterial);

  constructor(private renderer: THREE.WebGLRenderer) {
    this.floor.rotation.x = -Math.PI / 2;
  }

  /** Distance as 1/depth: 0 where nothing was drawn (the backdrop, infinitely far). */
  private renderDepth(root: THREE.Object3D, camera: THREE.Camera, groundY: number | null, w: number, h: number) {
    const r = this.renderer;
    this.depthTarget.setSize(w, h);
    const stage = new THREE.Scene();
    stage.overrideMaterial = this.depthMaterial;
    // instanced outline edges would draw untransformed under the override: hide them
    const hidden: THREE.Object3D[] = [];
    root.traverse((o) => { if ((o as THREE.LineSegments).isLineSegments && o.visible) { o.visible = false; hidden.push(o); } });
    const parent = root.parent;
    stage.add(root);
    if (groundY !== null) {
      this.floor.position.y = groundY;
      stage.add(this.floor);
    }
    const clear = r.getClearColor(new THREE.Color());
    const alpha = r.getClearAlpha();
    r.setClearColor(0x000000, 1);
    r.setRenderTarget(this.depthTarget);
    r.setScissorTest(false);
    r.clear(true, true, true);
    r.render(stage, camera);
    r.setRenderTarget(null);
    r.setClearColor(clear, alpha);
    parent?.add(root);
    for (const o of hidden) o.visible = true;
  }

  /**
   * Blurs what is on the canvas now (`source` 'canvas'), or draws `source` (an sRGB image,
   * top row first) onto it, blurred. With the lens off an image is just drawn.
   * `root` is the bricks, `box` what the focus is measured against, `groundY` the floor
   * height (null: no floor).
   */
  apply(source: 'canvas' | ImageData, opts: { lens: LensChoice; camera: THREE.Camera; root: THREE.Object3D; box: THREE.Box3; groundY: number | null; frame?: FrameRect }): void {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const pr = r.getPixelRatio();
    // `frame`: only that part of the canvas (the Preview's video frame), in CSS pixels
    const region = opts.frame ? frameRegion(opts.frame, size.y / pr, pr) : { x: 0, y: 0, width: size.x, height: size.y };
    const w = region.width, h = region.height;
    const maxR = maxBlurPx(opts.lens, h);
    if (source === 'canvas' && maxR < 0.5) return;
    let color: THREE.Texture;
    if (source === 'canvas') {
      if (!this.frame || this.frame.image.width !== w || this.frame.image.height !== h) {
        this.frame?.dispose();
        this.frame = new THREE.FramebufferTexture(w, h);
      }
      r.setRenderTarget(null);
      r.copyFramebufferToTexture(this.frame, opts.frame ? new THREE.Vector2(region.x, region.y) : null);
      color = this.frame;
    } else {
      if (!this.image || this.image.image.width !== source.width || this.image.image.height !== source.height) {
        this.image?.dispose();
        this.image = new THREE.DataTexture(new Uint8Array(source.width * source.height * 4), source.width, source.height);
        this.image.minFilter = this.image.magFilter = THREE.LinearFilter;
      }
      (this.image.image.data as Uint8Array).set(source.data);
      this.image.needsUpdate = true;
      color = this.image;
    }
    if (maxR >= 0.5) this.renderDepth(opts.root, opts.camera, opts.groundY, w, h);
    const u = this.blur.uniforms;
    u.tColor.value = color;
    u.tDepth.value = this.depthTarget.texture;
    u.texel.value.set(1 / w, 1 / h);
    u.focus.value = maxR >= 0.5 ? focusDistance(opts.camera, opts.box, opts.lens.focus) : 1;
    u.maxR.value = maxR >= 0.5 ? maxR : 0;
    // keeps the sample count near 12 per pixel of blur radius
    u.radScale.value = Math.max(0.5, maxR / 24);
    u.flipColor.value = source !== 'canvas';
    r.setRenderTarget(null);
    r.setViewport(region.x / pr, region.y / pr, w / pr, h / pr);
    r.setScissor(region.x / pr, region.y / pr, w / pr, h / pr);
    r.setScissorTest(!!opts.frame);
    this.quad.render(r);
    r.setScissorTest(false);
  }

  dispose(): void {
    this.depthTarget.dispose();
    this.depthMaterial.dispose();
    this.blur.dispose();
    this.quad.dispose();
    this.frame?.dispose();
    this.image?.dispose();
    this.floorGeometry.dispose();
  }
}
