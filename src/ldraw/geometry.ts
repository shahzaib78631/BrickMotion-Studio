import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FlatPart } from './flatten';
import { bevelSharpEdges } from './bevel';

export type PartGeometry = {
  main: THREE.BufferGeometry | null;
  mainDoubleSided: THREE.BufferGeometry | null;
  fixed: { color: number; geometry: THREE.BufferGeometry; doubleSided: boolean }[];
  /** outline edges as line-segment positions (LDU), or null when the part has none */
  edges: THREE.BufferGeometry | null;
};

const CREASE = Math.PI / 6;
/** Fillet width of a rounded edge, LDU (a real brick's is about 0.2 mm, 0.5 LDU). */
const BEVEL_WIDTH = 0.45;

/** Render options for part geometry. */
export type GeometryOptions = {
  /** rounded sharp outside edges (see bevel.ts); single-sided, BFC-certified faces only */
  bevel?: boolean;
};

function toGeometry(pts: number[] | undefined, bevel = false): THREE.BufferGeometry | null {
  if (!pts || pts.length === 0) return null;
  const g = new THREE.BufferGeometry();
  const rounded = bevel ? bevelSharpEdges(pts, BEVEL_WIDTH, CREASE) : null;
  g.setAttribute('position', rounded ? new THREE.BufferAttribute(rounded.positions, 3) : new THREE.Float32BufferAttribute(pts, 3));
  const creased = toCreasedNormals(g, CREASE);
  g.dispose();
  if (rounded) {
    // toCreasedNormals keeps the triangle order: corner i here is corner i of the bevel
    const n = creased.getAttribute('normal') as THREE.BufferAttribute;
    const over = rounded.normals;
    for (let i = 0; i < n.count; i++) if (!Number.isNaN(over[i * 3])) n.setXYZ(i, over[i * 3], over[i * 3 + 1], over[i * 3 + 2]);
    n.needsUpdate = true;
  }
  creased.computeBoundingSphere();
  creased.computeBoundingBox();
  return creased;
}

/** Builds three.js geometry in LDraw part space (LDU, -Y up). */
export function buildPartGeometry(flat: FlatPart, options: GeometryOptions = {}): PartGeometry {
  const bevel = options.bevel === true;
  const fixed: PartGeometry['fixed'] = [];
  for (const [color, pts] of flat.tris) {
    if (color === 16) continue;
    const geometry = toGeometry(pts, bevel);
    if (geometry) fixed.push({ color, geometry, doubleSided: false });
  }
  for (const [color, pts] of flat.doubleSided) {
    if (color === 16) continue;
    const geometry = toGeometry(pts);
    if (geometry) fixed.push({ color, geometry, doubleSided: true });
  }
  return {
    main: toGeometry(flat.tris.get(16), bevel),
    mainDoubleSided: toGeometry(flat.doubleSided.get(16)),
    fixed,
    edges: flat.edges?.length ? new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(flat.edges, 3)) : null,
  };
}
