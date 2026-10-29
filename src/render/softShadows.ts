import * as THREE from 'three';

/**
 * Smooth wide soft shadows for the studio scenes.
 *
 * three's VSM shadows keep depth in half floats: wide blurs show contour "stairs" around
 * parts and streaks across the floor. Its PCF filter takes only 5 samples, so a wide
 * radius turns grainy. This widens PCF to 16 samples (64 hardware-filtered taps), which
 * stays smooth at the radii the render scenes use. It patches the shared shader chunk
 * once, before any material compiles.
 */
const TAPS = 16;
let patched = false;

export function useSmoothSoftShadows(): void {
  if (patched) return;
  patched = true;
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const start = chunk.indexOf('shadow = (\n\t\t\t\t\ttexture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi )');
  const end = start < 0 ? -1 : chunk.indexOf(') * 0.2;', start);
  // a future three version changed the filter: leave it alone rather than break shaders
  if (start < 0 || end < 0) return;
  const loop = `shadow = 0.0;
					for ( int i = 0; i < ${TAPS}; i ++ ) {
						shadow += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( i, ${TAPS}, phi ) * radius, shadowCoord.z ) );
					}
					shadow /= ${TAPS}.0;`;
  THREE.ShaderChunk.shadowmap_pars_fragment = chunk.slice(0, start) + loop + chunk.slice(end + ') * 0.2;'.length);
}
