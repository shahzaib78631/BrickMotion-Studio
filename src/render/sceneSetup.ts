/** Project-local camera and lighting objects. Coordinates use BrickMotion world units
 * (studs, Y up). This document is independent of generated assembly motion. */
import * as THREE from 'three';

export type XYZ = [number, number, number];
export type Region = { x: number; y: number; width: number; height: number };
export type SceneCamera = {
  kind: 'camera'; id: string; name: string; position: XYZ; target: XYZ;
  fov: number; near: number; far: number;
};
export type LightType = 'sun' | 'point' | 'spot' | 'ambient';
export type SceneLight = {
  kind: 'light'; id: string; name: string; type: LightType;
  position: XYZ; target: XYZ; color: string; intensity: number;
  angle: number; distance: number; castShadow: boolean; enabled: boolean;
};
export type SceneObject = SceneCamera | SceneLight;
export type SceneSetup = {
  cameras: SceneCamera[];
  lights: SceneLight[];
  activeCameraId: string | null;
  /** A saved scene camera overrides procedural video cameraAt in Preview and MP4. */
  useCameraForVideo: boolean;
  /** With no custom lights the standard studio setup is always retained. */
  useLightsForVideo: boolean;
  includeStudioLights: boolean;
  /** Normalized 0..1 camera-frame render border. */
  region: Region | null;
  /** Optional zoom/crop of Preview and MP4 to the render border. */
  cropToRegion: boolean;
  exposure: number;
};
export const EMPTY_SCENE_SETUP: SceneSetup = {
  cameras: [], lights: [], activeCameraId: null, useCameraForVideo: true,
  useLightsForVideo: true, includeStudioLights: true, region: null,
  cropToRegion: false, exposure: 1,
};
export const sceneSetupOf = (value?: SceneSetup): SceneSetup => value ?? EMPTY_SCENE_SETUP;
export const activeSceneCamera = (setup?: SceneSetup): SceneCamera | null => {
  if (!setup) return null;
  return setup.cameras.find((c) => c.id === setup.activeCameraId) ?? null;
};
export const sceneObject = (setup: SceneSetup, id: string | null): SceneObject | null =>
  setup.cameras.find((o) => o.id === id) ?? setup.lights.find((o) => o.id === id) ?? null;
export function freshSceneId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `scene-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
export function createCamera(position: THREE.Vector3, target: THREE.Vector3, fov = 42, number = 1): SceneCamera {
  return { kind: 'camera', id: freshSceneId(), name: `Camera ${number}`, position: position.toArray() as XYZ,
    target: target.toArray() as XYZ, fov: THREE.MathUtils.clamp(fov, 8, 130), near: 0.05, far: 5000 };
}
export function createLight(type: LightType, from: THREE.Vector3, target: THREE.Vector3, number = 1): SceneLight {
  const pos = from.clone();
  if (type === 'point' || type === 'spot') pos.lerp(target, 0.45);
  return { kind: 'light', id: freshSceneId(), name: `${type[0].toUpperCase()}${type.slice(1)} ${number}`,
    type, position: pos.toArray() as XYZ, target: target.toArray() as XYZ,
    color: '#ffffff', intensity: type === 'sun' ? 2.4 : type === 'ambient' ? 0.5 : 180,
    angle: 40, distance: 0, castShadow: type === 'sun' || type === 'spot', enabled: true };
}
/** Draw region, using frame-local pixels, normalized and clipped against camera frame. */
export function regionFromDrag(start: [number, number], end: [number, number]): Region | null {
  // Canonical 1e-6 normalized values: raw IEEE subtraction yields values such as
  // 0.49999999999999994 for 0.7 - 0.2, which are persisted into the project and
  // compared for equality. A UI selection never needs more precision than this.
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const x = Math.max(0, Math.min(1, Math.min(start[0], end[0])));
  const y = Math.max(0, Math.min(1, Math.min(start[1], end[1])));
  const x2 = Math.max(0, Math.min(1, Math.max(start[0], end[0])));
  const y2 = Math.max(0, Math.min(1, Math.max(start[1], end[1])));
  return x2 - x < 0.025 || y2 - y < 0.025 ? null
    : { x: round(x), y: round(y), width: round(x2 - x), height: round(y2 - y) };
}
/** For an unchanged output aspect ratio, expand an arbitrary selection into an
 * aspect-preserving normalized square, shifting inward at the frame edges. */
export function cameraCrop(region: Region | null): Region | null {
  if (!region) return null;
  const size = Math.min(1, Math.max(region.width, region.height));
  return {
    x: THREE.MathUtils.clamp(region.x + region.width / 2 - size / 2, 0, 1 - size),
    y: THREE.MathUtils.clamp(region.y + region.height / 2 - size / 2, 0, 1 - size),
    width: size, height: size,
  };
}
/** Reproducible camera crop shared by live preview and offline export. */
export function applyCameraCrop(camera: THREE.PerspectiveCamera, setup?: SceneSetup): void {
  camera.clearViewOffset();
  const crop = setup?.cropToRegion ? cameraCrop(setup.region) : null;
  if (crop) {
    // Three.js sets camera.aspect = fullWidth / fullHeight in setViewOffset.
    // Using two equal dimensions here would squash 9:16 and 16:9 exports.
    const fullHeight = 10_000;
    const fullWidth = fullHeight * camera.aspect;
    camera.setViewOffset(fullWidth, fullHeight, crop.x * fullWidth, crop.y * fullHeight,
      crop.width * fullWidth, crop.height * fullHeight);
  }
}
/** The scene camera's pose when it is in charge of the video, else null. */
export function sceneCameraPose(setup?: SceneSetup): { position: THREE.Vector3; target: THREE.Vector3; fov: number; near: number; far: number } | null {
  const active = setup?.useCameraForVideo ? activeSceneCamera(setup) : null;
  if (!active) return null;
  const position = new THREE.Vector3(...active.position), target = new THREE.Vector3(...active.target);
  if (target.distanceToSquared(position) < 1e-8) return null;
  return { position, target, fov: active.fov, near: active.near, far: active.far };
}
/** Scene camera applies a fixed pose; the procedural camera is used otherwise. */
export function applySceneCamera(camera: THREE.PerspectiveCamera, setup?: SceneSetup): boolean {
  const active = setup?.useCameraForVideo ? activeSceneCamera(setup) : null;
  if (!active) return false;
  const target = new THREE.Vector3(...active.target);
  if (target.distanceToSquared(new THREE.Vector3(...active.position)) < 1e-8) return false;
  camera.position.fromArray(active.position);
  camera.lookAt(target);
  camera.fov = active.fov;
  camera.near = active.near;
  camera.far = active.far;
  camera.updateProjectionMatrix();
  applyCameraCrop(camera, setup);
  return true;
}
export function cameraFrame(viewWidth: number, viewHeight: number, aspect: number, inset = 0.88) {
  const width = Math.min(viewWidth * inset, viewHeight * inset * aspect);
  const height = width / aspect;
  return { x: (viewWidth - width) / 2, y: (viewHeight - height) / 2, width, height };
}
export function updateObject<T extends SceneObject>(setup: SceneSetup, id: string, fn: (value: T) => T): SceneSetup {
  return { ...setup,
    cameras: setup.cameras.map((c) => c.id === id ? fn(c as T) as SceneCamera : c),
    lights: setup.lights.map((l) => l.id === id ? fn(l as T) as SceneLight : l),
  };
}
export function removeObject(setup: SceneSetup, id: string): SceneSetup {
  const cameras = setup.cameras.filter((c) => c.id !== id);
  return { ...setup, cameras, lights: setup.lights.filter((l) => l.id !== id),
    activeCameraId: setup.activeCameraId === id ? cameras[0]?.id ?? null : setup.activeCameraId };
}
