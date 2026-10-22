import * as THREE from 'three';
import type { Box } from '../ldraw/flatten';
import { clamp01, easeInOutCubic, lerp } from './easing';
import type { Timeline } from './timeline';

export type CamPose = { position: THREE.Vector3; target: THREE.Vector3; fov: number };

export const FOV = 30;
const BUILD_AZ: [number, number] = [30, 55];
const BUILD_EL = 42;
const BUILD_MARGIN = 1.08;
const ORBIT_DEG = 120;
const ORBIT_EL = 30;
const ORBIT_MARGIN = 1.25;
const FOCUS_EASE = 0.6;
const OUTRO_BLEND = 0.8;
/** each camera key frames everything that is on the floor within ±KEY_REACH s… */
const KEY_REACH = 0.6;
/** …and the rig is the average of the keys within ±SMOOTH s, so it moves smoothly but never cuts a piece off */
const SMOOTH = 0.4;

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

function floorRig(tl: Timeline, t: number, aspect: number, az: number): Rig {
  const keys = tl.camKeys;
  if (!keys.length) return fitRig(tl.buildBox, aspect, az, BUILD_EL, BUILD_MARGIN);
  const near = keys.filter((k) => Math.abs(k.t - t) <= SMOOTH + 1e-9);
  const around = near.length ? near : [keys.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))];
  const rigs = around.map((k) => {
    let box: Box | null = null;
    for (const o of keys) if (Math.abs(o.t - k.t) <= KEY_REACH + 1e-9) box = box ? unionBoxes(box, o.box) : o.box;
    return fitRig(box!, aspect, az, BUILD_EL, BUILD_MARGIN);
  });
  const target = new THREE.Vector3();
  let dist = 0;
  for (const r of rigs) {
    target.add(r.target);
    dist += r.dist;
  }
  return { target: target.divideScalar(rigs.length), dist: dist / rigs.length, az, el: BUILD_EL };
}

const unionBoxes = (a: Box, b: Box): Box => ({
  min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
  max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
});

function buildRig(tl: Timeline, t: number, aspect: number): Rig {
  const az = lerp(BUILD_AZ[0], BUILD_AZ[1], clamp01(t / Math.max(tl.buildEnd, 1e-6)));
  let rig = floorRig(tl, t, aspect, az);
  // the innermost submodel being built at its side spot pulls the camera over
  let active = null as Timeline['subBuilds'][number] | null;
  for (const s of tl.subBuilds) if (t >= s.start && t < s.attachStart + FOCUS_EASE && (!active || s.start >= active.start)) active = s;
  if (active) {
    const w = easeInOutCubic(Math.min(clamp01((t - active.start) / FOCUS_EASE), 1 - clamp01((t - active.attachStart) / FOCUS_EASE)));
    rig = mix(rig, fitRig(active.focus, aspect, az, BUILD_EL, BUILD_MARGIN), w);
  }
  return rig;
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
