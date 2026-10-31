/**
 * Ties the Camera track to a video: the scene context the sampler reads (for a Build
 * timeline or a keyframe animation) and applying a sampled shot to a Three camera.
 */
import * as THREE from 'three';
import { buildFocusBox, worldBox3 } from '../camera';
import type { Timeline } from '../timeline';
import type { KeyframeAnimation } from '../../plan/types';
import { buildLayerAt } from '../buildLayer';
import { LENS_BLUR_PX, type LensChoice } from '../../render/looks';
import type { CameraContext, CameraKey, CameraShot } from './types';

/** The piece in the air at t (its landing box, world), or null. */
function pieceAt(tl: Timeline, t: number): THREE.Box3 | null {
  const box = new THREE.Box3();
  for (const u of tl.units) {
    const land = u.land ?? u.box;
    if (!land || u.hidden || t < u.start || t >= u.start + u.dur) continue;
    box.union(worldBox3(land));
  }
  return box.isEmpty() ? null : box;
}

/** Grid spacing (seconds) of the box smoothing. */
const SMOOTH_STEP = 0.1;

/**
 * A box that follows `boxAt` but glides, over about ±`half` seconds, where it would jump
 * (the framing moving from the model to a submodel built beside it, say). Averaged on a
 * fixed time grid and blended between grid points, so it is smooth frame to frame.
 * `cache` (by grid index) saves recomputing the averages.
 */
export function smoothBoxOverTime(boxAt: (t: number) => THREE.Box3, t: number, half: number, cache?: Map<number, THREE.Box3>): THREE.Box3 {
  const n = Math.max(1, Math.round(half / SMOOTH_STEP));
  const at = (g: number) => {
    const hit = cache?.get(g);
    if (hit) return hit;
    const min = new THREE.Vector3(), max = new THREE.Vector3();
    let sum = 0;
    for (let k = -n; k <= n; k++) {
      const w = 0.5 + 0.5 * Math.cos((Math.PI * k) / (n + 1));
      const b = boxAt(Math.max(0, (g + k) * SMOOTH_STEP));
      if (b.isEmpty()) continue;
      min.addScaledVector(b.min, w); max.addScaledVector(b.max, w); sum += w;
    }
    const box = sum ? new THREE.Box3(min.divideScalar(sum), max.divideScalar(sum)) : boxAt(g * SMOOTH_STEP);
    cache?.set(g, box);
    return box;
  };
  const g0 = Math.floor(t / SMOOTH_STEP), u = t / SMOOTH_STEP - g0;
  const a = at(g0), b = at(g0 + 1);
  return new THREE.Box3(a.min.clone().lerp(b.min, u), a.max.clone().lerp(b.max, u));
}

/** `box` grown round its centre so no side is shorter than `share` of the model's longest side. */
export function atLeast(box: THREE.Box3, model: THREE.Box3, share: number): THREE.Box3 {
  if (box.isEmpty() || model.isEmpty()) return box;
  const ms = model.getSize(new THREE.Vector3());
  const least = share * Math.max(ms.x, ms.y, ms.z);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const half = new THREE.Vector3(Math.max(s.x, least), Math.max(s.y, least), Math.max(s.z, least)).multiplyScalar(0.5);
  if (half.x * 2 === s.x && half.y * 2 === s.y && half.z * 2 === s.z) return box;
  return new THREE.Box3(c.clone().sub(half), c.clone().add(half));
}

/** The smallest "what is being built" box, as a share of the model's size: no macro shots of one brick. */
const LEAST_FRAMED = 0.35;

/** Context for a Build video. "What is being built" glides between subjects rather than jumping. */
export function buildCameraContext(tl: Timeline, aspect: number, sensorMm: number): CameraContext {
  const modelBox = worldBox3(tl.modelBox);
  const raw = (t: number) => atLeast(worldBox3(buildFocusBox(tl, t)), modelBox, LEAST_FRAMED);
  const cache = new Map<number, THREE.Box3>();
  return {
    aspect, sensorMm, duration: tl.duration, modelBox,
    buildBox: (t) => smoothBoxOverTime(raw, t, 0.6, cache),
    pieceBox: (t) => pieceAt(tl, t),
  };
}

/**
 * Context for a keyframe Timeline video. With a linked Build underneath, "what is being
 * built" follows that Build on its own clock; otherwise it is the animation's bounds.
 */
export function timelineCameraContext(animation: KeyframeAnimation, bounds: THREE.Box3, buildTimeline: Timeline | null, editingModel: string,
  aspect: number, sensorMm: number): CameraContext {
  const duration = (animation.endFrame - animation.startFrame + 1) / animation.fps;
  const layer = buildLayerAt(animation, editingModel);
  if (!buildTimeline) return { aspect, sensorMm, duration, modelBox: bounds, buildBox: () => bounds, pieceBox: () => null };
  const toBuild = (seconds: number) => {
    const frame = animation.startFrame + seconds * animation.fps;
    return layer ? Math.max(0, ((frame - layer.startFrame) / animation.fps) * layer.speed) : seconds;
  };
  const inner = buildCameraContext(buildTimeline, aspect, sensorMm);
  return { ...inner, duration, buildBox: (t) => inner.buildBox(toBuild(t)), pieceBox: (t) => inner.pieceBox(toBuild(t)) };
}

/** Points a camera as the shot says: position, aim, lens, then the Dutch roll about the view axis. */
export function applyShot(camera: THREE.PerspectiveCamera, shot: CameraShot): void {
  camera.position.copy(shot.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(shot.target);
  if (shot.roll) camera.rotateZ(THREE.MathUtils.degToRad(shot.roll));
  camera.fov = shot.fov;
  camera.updateProjectionMatrix();
}

export type ExportCameraSetting = 'automatic' | 'buildView' | 'track';
/** 'track' falls back to the automatic camera when the model has no camera track yet. */
export function resolveExportCamera(setting: ExportCameraSetting, hasTrack: boolean): ExportCameraSetting {
  return setting === 'track' && !hasTrack ? 'automatic' : setting;
}

/**
 * Whether the viewport plays the Camera track while the playhead moves. In camera view (looking
 * through the saved scene camera) it does when the video uses the track, so the frame shows
 * what the MP4 will.
 */
export function viewportFollowsTrack(o: { cameraView: boolean; follow: boolean; stagingPending: boolean;
  exportCamera: ExportCameraSetting; trackKeys: number; scene?: { useCameraForVideo?: boolean; activeCameraId?: string | null } }): boolean {
  if (!o.trackKeys || !o.follow || o.stagingPending) return false;
  return !o.cameraView || videoCameraInCharge(o.scene, o.exportCamera, o.trackKeys) === 'track';
}

/** Which camera films the video: a Camera track the video uses beats a saved scene camera. */
export function videoCameraInCharge(scene: { useCameraForVideo?: boolean; activeCameraId?: string | null } | undefined,
  setting: ExportCameraSetting, trackKeys: number): 'track' | 'scene' | 'automatic' {
  if (resolveExportCamera(setting, trackKeys > 0) === 'track') return 'track';
  return scene?.useCameraForVideo === true && !!scene.activeCameraId ? 'scene' : 'automatic';
}

/**
 * A key that reproduces a view exactly: aimed at a fixed point, at a fixed distance, with
 * the lens worked back from the field of view. Used for "Key from view".
 */
export function cameraPoseToKey(position: THREE.Vector3, target: THREE.Vector3, fovDeg: number, sensorMm: number, t: number): Omit<CameraKey, 'id' | 'origin'> {
  const d = position.clone().sub(target);
  const dist = Math.max(1e-6, d.length());
  const elevation = THREE.MathUtils.radToDeg(Math.asin(Math.min(1, Math.max(-1, d.y / dist))));
  const azimuth = THREE.MathUtils.radToDeg(Math.atan2(d.x, d.z));
  const lensMm = Math.max(1, sensorMm) / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  return {
    t, target: { kind: 'point', at: [target.x, target.y, target.z] }, offset: [0, 0, 0], azimuth, elevation,
    distance: { fit: false, value: dist }, roll: 0, lensMm, focus: 'target', blur: 0,
  };
}

/** The depth of field a shot asks for: its focus, and its blur as an exact size. */
export function shotLens(shot: CameraShot): LensChoice {
  return { blur: shot.blur > 0 ? 'medium' : 'off', focus: shot.focus, px: shot.blur * LENS_BLUR_PX.strong };
}
