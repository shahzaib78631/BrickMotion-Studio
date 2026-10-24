import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ViewControls } from './viewControls';
import type { Studio } from '../render/studio';

/** Shared handle to the live viewport so the preview player can drive the same canvas. */
export const viewportApi: { studio: Studio | null; controls: OrbitControls | null; views: ViewControls | null; fit(): void } = {
  studio: null,
  controls: null,
  views: null,
  fit: () => {},
};
