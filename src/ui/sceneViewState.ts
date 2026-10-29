import { create } from 'zustand';

/** UI-only viewport state. Persistent camera/light data lives in Plan.sceneSetup. */
export type SceneViewState = {
  panelOpen: boolean;
  cameraView: boolean;
  lockCamera: boolean;
  regionTool: boolean;
  showHelpers: boolean;
  showGuides: boolean;
  showSafe: boolean;
  selectedId: string | null;
  width: number;
  height: number;
};
export const useSceneView = create<SceneViewState>(() => ({
  panelOpen: false, cameraView: false, lockCamera: false, regionTool: false,
  showHelpers: true, showGuides: true, showSafe: false,
  selectedId: null, width: 1, height: 1,
}));

/** A camera-view always follows explicit edits to the saved scene camera.
 * `lockCamera` only enables viewport navigation to write back to that camera;
 * it does not freeze it against Fit/Auto-fit, lens changes or external edits. */
export function shouldFollowSceneCamera(view: Pick<SceneViewState, 'cameraView' | 'lockCamera'>): boolean {
  return view.cameraView;
}
