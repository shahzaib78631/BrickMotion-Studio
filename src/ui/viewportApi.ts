import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Studio } from '../render/studio';

/** Shared handle to the live viewport so the preview player can drive the same canvas. */
export const viewportApi: { studio: Studio | null; controls: OrbitControls | null } = { studio: null, controls: null };
