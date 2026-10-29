/** Manual staging snapshot: selecting the Camera frame tile does not plan or move a camera. */
import type { FloorMatch, FloorSides, FloorSort } from '../anim/pacing';
import type { VideoFormat } from '../export/formats';
import { formatAspect } from '../export/formats';
import { activeSceneCamera, cameraCrop, type AppliedFrameStaging, type SceneSetup } from '../render/sceneSetup';

type FrameDraft = { format: VideoFormat; floorSort: FloorSort; floorSides: FloorSides; floorMatch: FloorMatch };

/** Capture a self-contained, immutable-by-convention copy of the ACTIVE camera.
 * No planner runs and neither the camera nor the scene is changed here. */
export function captureFrameStaging(draft: FrameDraft, scene?: SceneSetup): AppliedFrameStaging | null {
  const active = activeSceneCamera(scene);
  if (!active) return null;
  const crop = scene?.cropToRegion ? cameraCrop(scene.region) : null;
  return {
    version: 1,
    cameraId: active.id, cameraName: active.name,
    format: draft.format,
    floorSort: draft.floorSort, floorSides: draft.floorSides, floorMatch: draft.floorMatch,
    camera: {
      position: [...active.position], target: [...active.target],
      fov: active.fov, aspect: formatAspect(draft.format), near: active.near, far: active.far,
      ...(crop ? { crop: { ...crop } } : {}),
    },
  };
}

/** Used only for a UI 'camera edited since last arrangement' hint.
 * Never use this comparison to trigger planning automatically. */
export function isFrameStagingCurrent(applied: AppliedFrameStaging | undefined, draft: FrameDraft, scene?: SceneSetup): boolean {
  if (!applied) return false;
  const next = captureFrameStaging(draft, scene);
  return next !== null && JSON.stringify(next) === JSON.stringify(applied);
}
