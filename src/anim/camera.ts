import * as THREE from 'three';
import type { Box } from '../ldraw/flatten';
import { clamp01, easeInOutCubic, lerp } from './easing';
import { CLOSE_EASE, type Timeline } from './timeline';

export type CamPose = { position: THREE.Vector3; target: THREE.Vector3; fov: number };

export const FOV = 30;
const BUILD_AZ: [number, number] = [30, 55];
const BUILD_EL = 42;
const BUILD_MARGIN = 1.08;
const ORBIT_DEG = 120;
const ORBIT_EL = 30;
const ORBIT_MARGIN = 1.25;
const OUTRO_BLEND = 0.8;
/** each camera key frames everything nearby in time */
const KEY_REACH = 0.6;
const rad = THREE.MathUtils.degToRad;

/** Direction from the target to the camera; azimuth from +Z towards +X. */
function viewDir(azDeg: number, elDeg: number) {
  const az = rad(azDeg);
  const el = rad(elDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

export function sphericalPosition(target: THREE.Vector3, dist: number, azDeg: number, elDeg: number) {
  return target.clone().addScaledVector(viewDir(azDeg, elDeg), dist);
}

/** Smallest distance from the box centre at which every corner is inside the frame. */
export function fitDistance(box: THREE.Box3, fovDeg: number, aspect: number, azimuthDeg: number, elevationDeg: number): number {
  const z = viewDir(azimuthDeg, elevationDeg);
  const x = new THREE.Vector3(0, 1, 0).cross(z).normalize();
  const y = z.clone().cross(x);
  const c = box.getCenter(new THREE.Vector3());
  const tanV = Math.tan(rad(fovDeg) / 2);
  const tanH = tanV * aspect;
  let d = 0;
  const o = new THREE.Vector3();
  for (const px of [box.min.x, box.max.x])
    for (const py of [box.min.y, box.max.y])
      for (const pz of [box.min.z, box.max.z]) {
        o.set(px, py, pz).sub(c);
        d = Math.max(d, o.dot(z) + Math.max(Math.abs(o.dot(x)) / tanH, Math.abs(o.dot(y)) / tanV));
      }
  return Math.max(d, 1);
}

/** LDU box → world box (1 unit = 1 stud, +Y up). */
export function worldBox3(b: Box): THREE.Box3 {
  const a = new THREE.Vector3(b.min[0] / 20, -b.min[1] / 20, -b.min[2] / 20);
  const c = new THREE.Vector3(b.max[0] / 20, -b.max[1] / 20, -b.max[2] / 20);
  return new THREE.Box3(a.clone().min(c), a.max(c));
}

type Rig = { target: THREE.Vector3; dist: number; az: number; el: number };

const fitRig = (b: Box, aspect: number, az: number, el: number, margin: number): Rig => {
  const box = worldBox3(b);
  return { target: box.getCenter(new THREE.Vector3()), dist: fitDistance(box, FOV, aspect, az, el) * margin, az, el };
};

const mix = (a: Rig, b: Rig, u: number): Rig => ({
  target: a.target.clone().lerp(b.target, u),
  dist: lerp(a.dist, b.dist, u),
  az: lerp(a.az, b.az, u),
  el: lerp(a.el, b.el, u),
});

/** Camera framing is fitted and smoothed ONCE for each timeline and aspect.
 * Recomputing the neighbouring-key average every video frame was expensive and
 * caused sudden camera jumps whenever a key entered or left the time window. */
const rigCache = new WeakMap<Timeline, Map<number, Rig[]>>();

function frameRigs(tl: Timeline, aspect: number): Rig[] {
  let byAspect = rigCache.get(tl);
  if (!byAspect) rigCache.set(tl, (byAspect = new Map()));
  const cached = byAspect.get(aspect);
  if (cached) return cached;
  const keys = tl.camKeys;
  const raw = keys.map((key) => {
    let box = key.box;
    for (const other of keys) if (other !== key && Math.abs(other.t - key.t) <= KEY_REACH + 1e-9) box = unionBoxes(box, other.box);
    const az = lerp(BUILD_AZ[0], BUILD_AZ[1], clamp01(key.t / Math.max(tl.buildEnd, 1e-6)));
    return fitRig(box, aspect, az, BUILD_EL, BUILD_MARGIN);
  });
  // A tapered 5-key convolution removes tiny camera adjustments without
  // changing motion from frame to frame; Catmull-Rom below gives C1 movement.
  const smoothed = raw.map((r, i) => {
    const target = new THREE.Vector3();
    let dist = 0;
    let weightSum = 0;
    for (let d = -2; d <= 2; d++) {
      const k = i + d;
      if (k < 0 || k >= raw.length) continue;
      const weight = 3 - Math.abs(d);
      weightSum += weight;
      target.addScaledVector(raw[k].target, weight);
      dist += raw[k].dist * weight;
    }
    target.divideScalar(weightSum);
    // Slightly conservative framing leaves room for interpolated positions.
    return { target, dist: Math.max(dist / weightSum * 1.08, r.dist * 1.04), az: r.az, el: r.el };
  });
  byAspect.set(aspect, smoothed);
  return smoothed;
}

const cubic = (p0: number, p1: number, p2: number, p3: number, u: number): number => {
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * (p2 - p0) / 2
    + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * (p3 - p1) / 2;
};

function floorRig(tl: Timeline, t: number, aspect: number, az: number): Rig {
  const keys = tl.camKeys;
  if (!keys.length) return fitRig(tl.buildBox, aspect, az, BUILD_EL, BUILD_MARGIN);
  const rigs = frameRigs(tl, aspect);
  // Keys are uniformly spaced by CAM_KEY_STEP, except possibly the final one.
  const step = keys.length > 1 ? keys[1].t - keys[0].t : 0.2;
  const i = Math.min(keys.length - 1, Math.max(0, Math.floor(t / step)));
  const j = Math.min(keys.length - 1, i + 1);
  if (i === j) return { ...rigs[i], az };
  const u = clamp01((t - keys[i].t) / (keys[j].t - keys[i].t));
  const a = rigs[Math.max(0, i - 1)];
  const b = rigs[i];
  const c = rigs[j];
  const d = rigs[Math.min(rigs.length - 1, j + 1)];
  return {
    target: new THREE.Vector3(
      cubic(a.target.x, b.target.x, c.target.x, d.target.x, u),
      cubic(a.target.y, b.target.y, c.target.y, d.target.y, u),
      cubic(a.target.z, b.target.z, c.target.z, d.target.z, u),
    ),
    dist: Math.max(1, cubic(a.dist, b.dist, c.dist, d.dist, u)),
    az,
    el: BUILD_EL,
  };
}

const unionBoxes = (a: Box, b: Box): Box => ({
  min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
  max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
});

type CloseUp = { start: number; end: number; rig: (aspect: number, az: number) => Rig };
const closeUpCache = new WeakMap<Timeline, CloseUp[]>();

/**
 * Submodel close-ups (the builds the timeline marks `closeUp`). Each holds one framing: the side spot
 * plus every flight while it lasts, so nothing being built is out of frame. The timeline lets earlier
 * flights land first, so the camera is fully in before the first piece flies; it has eased back out
 * when the attach starts, so the attach plays in the wide shot.
 */
export function closeUps(tl: Timeline): CloseUp[] {
  let list = closeUpCache.get(tl);
  if (list) return list;
  list = [];
  for (const sb of tl.subBuilds) {
    if (!sb.closeUp) continue;
    const from = sb.start - CLOSE_EASE;
    let box: Box = sb.focus;
    for (const u of tl.units) if (u.box && u.start < sb.attachStart - 1e-6 && u.start + u.dur > from) box = unionBoxes(box, u.box);
    list.push({ start: sb.start, end: sb.attachStart, rig: (aspect, az) => fitRig(box, aspect, az, BUILD_EL, BUILD_MARGIN) });
  }
  closeUpCache.set(tl, list);
  return list;
}

/** 0 = wide shot, 1 = close-up. A build shorter than the ease eases out over the build itself. */
function closeWeight(c: CloseUp, t: number) {
  if (t < c.start) return easeInOutCubic(clamp01((t - (c.start - CLOSE_EASE)) / CLOSE_EASE));
  const outFrom = Math.max(c.start, c.end - CLOSE_EASE);
  return 1 - easeInOutCubic(clamp01((t - outFrom) / Math.max(c.end - outFrom, 1e-6)));
}

function buildRig(tl: Timeline, t: number, aspect: number): Rig {
  const az = lerp(BUILD_AZ[0], BUILD_AZ[1], clamp01(t / Math.max(tl.buildEnd, 1e-6)));
  const wide = floorRig(tl, t, aspect, az);
  let best: CloseUp | null = null;
  let w = 0;
  for (const c of closeUps(tl)) {
    const cw = closeWeight(c, t);
    if (cw > w) ((w = cw), (best = c));
  }
  return best && w > 0 ? mix(wide, best.rig(aspect, az), w) : wide;
}

export function cameraAt(tl: Timeline, t: number, aspect: number): CamPose {
  let rig: Rig;
  if (t <= tl.buildEnd) rig = buildRig(tl, Math.min(t, tl.buildEnd), aspect);
  else if (tl.heroOrbit) {
    const u = clamp01((t - tl.buildEnd) / (tl.duration - tl.buildEnd));
    const az = BUILD_AZ[1] + ORBIT_DEG * u;
    const orbit = fitRig(tl.modelBox, aspect, az, ORBIT_EL, ORBIT_MARGIN);
    const from = buildRig(tl, tl.buildEnd, aspect);
    from.az = az;
    rig = mix(from, orbit, easeInOutCubic(clamp01((t - tl.buildEnd) / OUTRO_BLEND)));
  } else rig = buildRig(tl, tl.buildEnd, aspect);
  return { position: sphericalPosition(rig.target, rig.dist, rig.az, rig.el), target: rig.target, fov: FOV };
}
