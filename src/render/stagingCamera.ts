/** Camera-framed tabletop staging: fit the *actual visible part footprints*, not
 * the reserved work bays. This keeps 9:16 shots legible for small builds even
 * when all pieces are shown at once. The fitted scene camera also drives MP4. */
import * as THREE from 'three';
import type { Box } from '../ldraw/flatten';
import type { Timeline } from '../anim/timeline';
import { fitDistanceAtTarget, worldBox3 } from '../anim/camera';
import { activeSceneCamera, createCamera, sceneSetupOf, type SceneCamera, type SceneSetup, type XYZ } from './sceneSetup';

const merge = (a: Box, b: Box): Box => ({
  min: [0, 1, 2].map((i) => Math.min(a.min[i], b.min[i])) as Box['min'],
  max: [0, 1, 2].map((i) => Math.max(a.max[i], b.max[i])) as Box['max'],
});

/** Pieces staged at t=0, plus the completed build's footprint. Later recycled
 * floor windows and submodel work bays should not force the camera miles away. */
export function initialStagingBounds(tl: Timeline): Box {
  let bounds = tl.modelBox;
  for (const tr of tl.tracks.values()) {
    if (tr.appear > 0) continue;
    const first = tr.moves[0];
    if (first && tl.units[first.unit]?.start <= 0) continue;
    bounds = merge(bounds, tr.floorBox);
  }
  return bounds;
}

/** Retains the artist's direction and lens but finds a shot that fits every
 * initial waiting piece and the finished model into the chosen output ratio. */
export function fitStagingCamera(tl: Timeline, camera: SceneCamera, aspect: number, margin = 1.14): SceneCamera {
  const bounds = worldBox3(initialStagingBounds(tl));
  const target = bounds.getCenter(new THREE.Vector3());
  const direction = new THREE.Vector3(...camera.position).sub(new THREE.Vector3(...camera.target));
  if (direction.lengthSq() < 1e-9) direction.set(0.35, 0.85, 0.4);
  direction.normalize();
  const az = THREE.MathUtils.radToDeg(Math.atan2(direction.x, direction.z));
  const elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)));
  const d = fitDistanceAtTarget(bounds, target, camera.fov, Math.max(0.2, aspect), az, elevation);
  const position = target.clone().addScaledVector(direction, d * Math.max(1.04, margin));
  return { ...camera, position: position.toArray() as XYZ, target: target.toArray() as XYZ };
}

/** Frames an existing camera or adds one, and opts into using it in Preview & MP4.
 * No camera/framing changes occur until this function is explicitly requested
 * (via Fit camera, or the Camera frame layout's Auto-fit on Play switch). */
export function frameStagingScene(tl: Timeline, scene: SceneSetup | undefined, aspect: number): SceneSetup {
  const setup = sceneSetupOf(scene);
  const active = activeSceneCamera(setup);
  const source = active ?? createCamera(new THREE.Vector3(12, 22, 17), new THREE.Vector3(0, 0, 0), 42, setup.cameras.length + 1);
  const fitted = fitStagingCamera(tl, source, aspect);
  return {
    ...setup,
    cameras: active ? setup.cameras.map((c) => c.id === active.id ? fitted : c) : [...setup.cameras, fitted],
    activeCameraId: fitted.id,
    useCameraForVideo: true,
  };
}
