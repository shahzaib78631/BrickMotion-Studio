import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ViewControls } from './viewControls';
import type { Studio } from '../render/studio';
import type { SceneController } from './sceneControls';
import type { ReferenceController } from './referenceImageControls';

/** Shared handle to the live viewport so the preview player can drive the same canvas. */
export const viewportApi: {
  studio: Studio | null; controls: OrbitControls | null; views: ViewControls | null; scene: SceneController | null; refs: ReferenceController | null; frameAspect: (() => number) | null; fit(): void;
  /** the mouse is over the 3D view (paste then follows it) */
  pointerInside: boolean;
  /** moves a placing gesture to where the mouse last was */
  placeAtPointer: (() => void) | null;
} = {
  studio: null,
  controls: null,
  views: null,
  scene: null,
  refs: null,
  frameAspect: null,
  fit: () => {},
  pointerInside: false,
  placeAtPointer: null,
};
