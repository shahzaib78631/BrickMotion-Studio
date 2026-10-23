import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FlatPart } from './flatten';

export type PartGeometry = {
  main: THREE.BufferGeometry | null;
  mainDoubleSided: THREE.BufferGeometry | null;
  fixed: { color: number; geometry: THREE.BufferGeometry; doubleSided: boolean }[];
  /** outline edges as line-segment positions (LDU), or null when the part has none */
  edges: THREE.BufferGeometry | null;
};

const CREASE = Math.PI / 6;

function toGeometry(pts: number[] | undefined): THREE.BufferGeometry | null {
  if (!pts || pts.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const creased = toCreasedNormals(g, CREASE);
  g.dispose();
  creased.computeBoundingSphere();
  creased.computeBoundingBox();
  return creased;
}

/** Builds three.js geometry in LDraw part space (LDU, -Y up). */
export function buildPartGeometry(flat: FlatPart): PartGeometry {
  const fixed: PartGeometry['fixed'] = [];
  for (const [color, pts] of flat.tris) {
    if (color === 16) continue;
    const geometry = toGeometry(pts);
    if (geometry) fixed.push({ color, geometry, doubleSided: false });
  }
  for (const [color, pts] of flat.doubleSided) {
    if (color === 16) continue;
    const geometry = toGeometry(pts);
    if (geometry) fixed.push({ color, geometry, doubleSided: true });
  }
  return {
    main: toGeometry(flat.tris.get(16)),
    mainDoubleSided: toGeometry(flat.doubleSided.get(16)),
    fixed,
    edges: flat.edges?.length ? new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(flat.edges, 3)) : null,
  };
}
