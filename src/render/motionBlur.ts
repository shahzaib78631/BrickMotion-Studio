/**
 * Motion blur for the Preview and MP4: a frame is the average of several renders spread
 * across the time the shutter is open (camera and bricks both move between them). Only
 * frames where the picture moves get more than one render, so still shots cost nothing.
 *
 * Averaging happens in linear light in a half-float target, so bright edges smear the way
 * a real exposure does.
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { CameraShot } from '../anim/cameraTrack/types';
import { frameRegion, type FrameRect } from './depthOfField';

/** How many renders a frame needs: 1 when the shutter is shut or the picture barely moves. */
export function subframeCount(shutter: number, movedPx: number, max: number): number {
  if (!(shutter > 0) || !(movedPx >= 0.75)) return 1;
  return Math.min(max, Math.max(2, Math.ceil((movedPx * shutter) / 3)));
}

/** Weights of the renders: they sum to one, and soften towards the ends of the exposure. */
export function accumulateWeights(n: number): number[] {
  if (n <= 1) return [1];
  const raw = Array.from({ length: n }, (_, i) => 0.6 + 0.4 * Math.sin((Math.PI * (i + 0.5)) / n));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

/** When each render is taken, in seconds from the frame's own time. */
export function subframeOffsets(n: number, shutter: number, fps: number): number[] {
  if (n <= 1) return [0];
  return Array.from({ length: n }, (_, k) => (k / (n - 1) - 0.5) * (shutter / fps));
}

const projector = new THREE.PerspectiveCamera();
function project(shot: CameraShot, aspect: number, points: THREE.Vector3[], w: number, h: number): THREE.Vector2[] {
  projector.fov = shot.fov;
  projector.aspect = aspect;
  projector.near = 0.1;
  projector.far = 1e5;
  projector.position.copy(shot.position);
  projector.up.set(0, 1, 0);
  projector.lookAt(shot.target);
  if (shot.roll) projector.rotateZ(THREE.MathUtils.degToRad(shot.roll));
  projector.updateProjectionMatrix();
  projector.updateMatrixWorld();
  return points.map((p) => {
    const v = p.clone().project(projector);
    return new THREE.Vector2((v.x * 0.5 + 0.5) * w, (v.y * 0.5 + 0.5) * h);
  });
}

/**
 * How far the picture moves while the shutter is open, in pixels: the largest move of the
 * box corners between camera `a` and camera `b`, plus how far the bricks themselves moved.
 */
export function movedPixels(a: CameraShot, b: CameraShot, box: THREE.Box3, w: number, h: number, bricksMoved: number): number {
  if (box.isEmpty()) return bricksMoved;
  const corners = Array.from({ length: 8 }, (_, i) => new THREE.Vector3(
    i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
  const pa = project(a, w / h, corners, w, h), pb = project(b, w / h, corners, w, h);
  let most = 0;
  for (let i = 0; i < 8; i++) if (Number.isFinite(pa[i].x + pb[i].x)) most = Math.max(most, pa[i].distanceTo(pb[i]));
  return most + bricksMoved;
}

/** Largest on-screen move of the bricks between two poses (positions only), in pixels. */
export function bricksMovedPixels(shot: CameraShot, w: number, h: number, keys: readonly string[],
  a: (key: string) => THREE.Matrix4 | null, b: (key: string) => THREE.Matrix4 | null): number {
  const from: THREE.Vector3[] = [], to: THREE.Vector3[] = [];
  for (const key of keys) {
    const ma = a(key), mb = b(key);
    if (!ma || !mb) continue;
    const pa = new THREE.Vector3().setFromMatrixPosition(ma), pb = new THREE.Vector3().setFromMatrixPosition(mb);
    if (pa.distanceToSquared(pb) < 1e-8) continue;
    from.push(pa); to.push(pb);
  }
  if (!from.length) return 0;
  const sa = project(shot, w / h, from, w, h), sb = project(shot, w / h, to, w, h);
  let most = 0;
  for (let i = 0; i < sa.length; i++) if (Number.isFinite(sa[i].x + sb[i].x)) most = Math.max(most, sa[i].distanceTo(sb[i]));
  return most;
}

const ADD_FRAG = /* glsl */ `
uniform sampler2D tColor; uniform float weight; varying vec2 vUv;
void main() { vec3 c = texture2D(tColor, vUv).rgb; gl_FragColor = vec4(pow(c, vec3(2.2)) * weight, 1.0); }`;
const RESOLVE_FRAG = /* glsl */ `
uniform sampler2D tSum; varying vec2 vUv;
void main() { gl_FragColor = vec4(pow(max(texture2D(tSum, vUv).rgb, 0.0), vec3(1.0 / 2.2)), 1.0); }`;
const VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

/** Adds up renders of the canvas (or a frame inside it) and draws their average back. */
export class MotionBlurAccumulator {
  private sum = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private copy: THREE.FramebufferTexture | null = null;
  private addMat = new THREE.ShaderMaterial({
    uniforms: { tColor: { value: null }, weight: { value: 1 } }, vertexShader: VERT, fragmentShader: ADD_FRAG,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
  });
  private resolveMat = new THREE.ShaderMaterial({
    uniforms: { tSum: { value: null } }, vertexShader: VERT, fragmentShader: RESOLVE_FRAG, depthTest: false, depthWrite: false,
  });
  private quad = new FullScreenQuad(this.addMat);
  private region: FrameRect = { x: 0, y: 0, width: 1, height: 1 };
  private framed = false;

  constructor(private renderer: THREE.WebGLRenderer) {}

  /** Starts a frame; `frame` limits it to part of the canvas (CSS pixels, top-left origin). */
  begin(frame?: FrameRect): void {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const pr = r.getPixelRatio();
    this.framed = !!frame;
    this.region = frame ? frameRegion(frame, size.y / pr, pr) : { x: 0, y: 0, width: size.x, height: size.y };
    const { width: w, height: h } = this.region;
    if (this.sum.width !== w || this.sum.height !== h) this.sum.setSize(w, h);
    if (!this.copy || this.copy.image.width !== w || this.copy.image.height !== h) {
      this.copy?.dispose();
      this.copy = new THREE.FramebufferTexture(w, h);
    }
    const clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    r.setRenderTarget(this.sum);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.setRenderTarget(null);
    r.setClearColor(clear, alpha);
  }

  /** Adds what is on the canvas now, with this weight. */
  add(weight: number): void {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.copyFramebufferToTexture(this.copy!, this.framed ? new THREE.Vector2(this.region.x, this.region.y) : null);
    this.addMat.uniforms.tColor.value = this.copy;
    this.addMat.uniforms.weight.value = weight;
    this.quad.material = this.addMat;
    const auto = r.autoClear;
    r.autoClear = false;
    r.setRenderTarget(this.sum);
    this.quad.render(r);
    r.setRenderTarget(null);
    r.autoClear = auto;
  }

  /** Draws the average onto the canvas. */
  resolve(): void {
    const r = this.renderer;
    const pr = r.getPixelRatio();
    const { x, y, width: w, height: h } = this.region;
    this.resolveMat.uniforms.tSum.value = this.sum.texture;
    this.quad.material = this.resolveMat;
    r.setRenderTarget(null);
    r.setViewport(x / pr, y / pr, w / pr, h / pr);
    r.setScissor(x / pr, y / pr, w / pr, h / pr);
    r.setScissorTest(this.framed);
    this.quad.render(r);
    r.setScissorTest(false);
  }

  dispose(): void {
    this.sum.dispose();
    this.copy?.dispose();
    this.addMat.dispose();
    this.resolveMat.dispose();
    this.quad.dispose();
  }
}
