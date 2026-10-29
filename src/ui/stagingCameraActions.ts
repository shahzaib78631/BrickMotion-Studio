/** Update the saved scene camera and its live viewport in the same action.
 * React's sceneSetup effect normally syncs the viewport, but Auto-fit during
 * playback must not spend a render frame on the previous wide camera while
 * "Lock camera to view" is allowed to write back OrbitControls changes. */
import type { Timeline } from '../anim/timeline';
import { frameStagingScene } from '../render/stagingCamera';
import { useStudio } from '../state/store';
import { viewportApi } from './viewportApi';

export function fitAndApplyStagingCamera(timeline: Timeline, aspect: number): void {
  const scene = frameStagingScene(timeline, useStudio.getState().plan.sceneSetup, aspect);
  useStudio.getState().apply((p) => ({ ...p, sceneSetup: scene }));
  // Directly sync, even while playing and even with Lock camera to view on.
  // The scene controller guards its OrbitControls change listener during sync.
  viewportApi.scene?.sync(scene);
}
