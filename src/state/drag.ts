import type { StudSnapper } from '../plan/studSnap';

/**
 * Turns a drag on the floor (world points, studs, +Y up) into a plan move; plan z is world −z.
 * Whole studs by default; a stud snapper may pick a half-stud spot that seats the part on a stud.
 */
export function dragDelta(from: { x: number; z: number }, to: { x: number; z: number }, snap?: StudSnapper): { x: number; y: number; z: number } {
  const raw = { x: to.x - from.x, z: -(to.z - from.z) };
  return snap ? snap(raw) : { x: Math.round(raw.x) || 0, y: 0, z: Math.round(raw.z) || 0 };
}
