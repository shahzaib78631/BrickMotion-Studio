import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Projection } from './studio';

/** Axis-aligned view presets, Blender's numpad 1/3/7 (Ctrl for the opposites). */
export type ViewName = 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom';
/** 'user' is any view orbited off the axis-aligned presets. */
export type ViewState = ViewName | 'user';

/**
 * Direction from the orbit target toward the camera for each preset. The app's
 * front faces the default camera on +Z (pieces in front of the model sit at
 * larger world z); screen-right in that front view is +X, so Right/Left sit on
 * ±X like Blender's numpad 3/1.
 */
export const VIEW_DIRS: Record<ViewName, readonly [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
};

export const OPPOSITE_VIEW: Record<ViewName, ViewName> = {
  front: 'back',
  back: 'front',
  right: 'left',
  left: 'right',
  top: 'bottom',
  bottom: 'top',
};

/** Spherical coordinates around the orbit target: azimuth from +Z toward +X, polar from +Y. */
export function sphericalOf(offset: THREE.Vector3): { az: number; pol: number; dist: number } {
  const dist = offset.length();
  return {
    az: Math.atan2(offset.x, offset.z),
    pol: dist > 1e-9 ? Math.acos(THREE.MathUtils.clamp(offset.y / dist, -1, 1)) : Math.PI / 2,
    dist,
  };
}

/** Inverse of sphericalOf. */
export function offsetOf(az: number, pol: number, dist: number): THREE.Vector3 {
  const s = Math.sin(pol);
  return new THREE.Vector3(dist * s * Math.sin(az), dist * Math.cos(pol), dist * s * Math.cos(az));
}

/** The preset the camera sits on (within `eps` rad), else 'user'. */
export function viewAt(offset: THREE.Vector3, eps = 0.02): ViewState {
  const { dist } = sphericalOf(offset);
  if (dist < 1e-6) return 'user';
  const dir = offset.clone().divideScalar(dist);
  for (const name of Object.keys(VIEW_DIRS) as ViewName[]) {
    const d = VIEW_DIRS[name];
    if (dir.x * d[0] + dir.y * d[1] + dir.z * d[2] >= Math.cos(eps)) return name;
  }
  return 'user';
}

/** Orbits `offset` around the target by angles in radians (up > 0 rises toward Top). */
export function orbitOffset(offset: THREE.Vector3, dAz: number, dUp: number, minPol = 0, maxPol = Math.PI): THREE.Vector3 {
  const { az, pol, dist } = sphericalOf(offset);
  return offsetOf(az + dAz, THREE.MathUtils.clamp(pol - dUp, minPol, maxPol), dist);
}

/** The exact opposite side of a view: Front↔Back, Top↔Bottom, or a 180° orbit away. */
export function oppositeOffset(offset: THREE.Vector3): THREE.Vector3 {
  const { az, pol, dist } = sphericalOf(offset);
  return offsetOf(az + Math.PI, Math.PI - pol, dist);
}

/** Half height of the ortho frustum matching a perspective camera's framing at `dist`. */
export function orthoHalfHeight(fovDeg: number, dist: number): number {
  return Math.tan((fovDeg * Math.PI) / 360) * Math.max(dist, 1e-3);
}

/** Shortest signed arc between two azimuths. */
export function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Frames `box` from the current view direction: the box's bounding sphere fits
 * the smaller screen axis with a margin, target at the sphere centre, distance
 * kept. Works for the perspective camera and the orthographic one — for ortho,
 * distance only keeps the near/far range sane, `setOrthoHeight` sizes the view.
 */
export function frameBox(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  controls: OrbitControls,
  box: THREE.Box3,
  setOrthoHeight?: (h: number) => void,
): void {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 3);
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-12) dir.set(0, 0.001, 1); // never frame straight down a degenerate axis
  dir.normalize();
  controls.target.copy(sphere.center);
  if (camera instanceof THREE.OrthographicCamera) {
    const aspect = (camera.right - camera.left) / Math.max(camera.top - camera.bottom, 1e-6);
    camera.zoom = 1;
    camera.far = Math.max(camera.far, Math.max(r * 4, 12) + r * 2 + 10);
    setOrthoHeight?.((r / Math.min(1, aspect)) * 1.15 * 2);
    camera.position.copy(sphere.center).addScaledVector(dir, Math.max(r * 4, 12));
  } else {
    const fov = (camera.fov * Math.PI) / 180;
    const dist = (r / Math.sin(Math.min(fov, fov * camera.aspect) / 2)) * 1.15;
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
  }
  controls.update();
}
