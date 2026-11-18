import * as THREE from 'three';
import { MeshBVH, CENTER } from 'three-mesh-bvh';
import { GLASS_FALLBACK_WALL_LDU } from './glassOptics';

export type GlassThicknessStats = { triangles: number; measured: number; fallback: number; minLdu: number; maxLdu: number };
const cache = new WeakMap<THREE.BufferGeometry, { positions: THREE.BufferAttribute | THREE.InterleavedBufferAttribute; version: number; index: THREE.BufferAttribute | null; indexVersion: number; stats: GlassThicknessStats }>();
const versionOf = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => a instanceof THREE.InterleavedBufferAttribute ? a.data.version : a.version;

/** A local wall estimate for the live volume shader, once per part geometry.
 * Rays start just inside each triangle and stop at its first outward boundary.
 * Cavities are therefore measured as walls, rather than as a part's whole AABB.
 * This is not a replacement for multiple-bounce geometry transport. */
export function ensureGlassThickness(geometry: THREE.BufferGeometry): GlassThicknessStats {
  const positions = geometry.getAttribute('position');
  const index = geometry.index;
  const previous = cache.get(geometry);
  if (previous && previous.positions === positions && previous.version === versionOf(positions) && previous.index === index && previous.indexVersion === (index?.version ?? 0)) return previous.stats;
  const probe = new THREE.BufferGeometry();
  probe.setAttribute('position', positions);
  if (index) probe.setIndex(index.clone());
  const bvh = new MeshBVH(probe, { indirect: true, strategy: CENTER });
  const count = index?.count ?? positions.count;
  const thickness = new Float32Array(positions.count), weights = new Float32Array(positions.count);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const edge = new THREE.Vector3(), normal = new THREE.Vector3(), center = new THREE.Vector3(), ray = new THREE.Ray();
  const stats: GlassThicknessStats = { triangles: 0, measured: 0, fallback: 0, minLdu: Infinity, maxLdu: 0 };
  const epsilon = .01; // 0.004 mm; excludes the source surface without consuming a wall.
  for (let offset = 0; offset + 2 < count; offset += 3) {
    const ids = [0, 1, 2].map(k => index ? index.getX(offset + k) : offset + k);
    a.fromBufferAttribute(positions, ids[0]); b.fromBufferAttribute(positions, ids[1]); c.fromBufferAttribute(positions, ids[2]);
    normal.subVectors(b, a).cross(edge.subVectors(c, a));
    const area2 = normal.length();
    if (area2 < 1e-10) continue;
    normal.divideScalar(area2);
    center.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    ray.direction.copy(normal).negate();
    ray.origin.copy(center).addScaledVector(ray.direction, epsilon);
    const hit = bvh.raycastFirst(ray, THREE.BackSide, epsilon, Infinity);
    const value = hit ? hit.distance + epsilon : GLASS_FALLBACK_WALL_LDU;
    stats.triangles++; if (hit) stats.measured++; else stats.fallback++;
    stats.minLdu = Math.min(stats.minLdu, value); stats.maxLdu = Math.max(stats.maxLdu, value);
    for (const id of ids) { thickness[id] += value * area2; weights[id] += area2; }
  }
  for (let i = 0; i < thickness.length; i++) thickness[i] = weights[i] ? thickness[i] / weights[i] : GLASS_FALLBACK_WALL_LDU;
  geometry.setAttribute('bmGlassThickness', new THREE.BufferAttribute(thickness, 1));
  if (!Number.isFinite(stats.minLdu)) stats.minLdu = GLASS_FALLBACK_WALL_LDU;
  probe.dispose();
  geometry.userData.bmGlassThickness = stats;
  cache.set(geometry, { positions, version: versionOf(positions), index, indexVersion: index?.version ?? 0, stats });
  return stats;
}
