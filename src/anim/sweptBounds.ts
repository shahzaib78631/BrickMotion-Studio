import type { Box } from '../ldraw/flatten';

/** Open-volume overlap: touching faces are not penetration. Units are LDraw units. */
export function intersects(a: Box, b: Box, tolerance = 0.3): boolean {
  return [0, 1, 2].every((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) > tolerance);
}

/**
 * Continuous collision test for two linearly translating AABBs over the same
 * interval. Unlike fixed-rate samples, this cannot miss a thin wall or two
 * fast pieces exchanging sides between frames. Faces may touch, not penetrate.
 * Sizes must remain fixed; rotating phases must use conservative envelopes.
 */
export function sweptIntersects(a0: Box, a1: Box, b0: Box, b1: Box = b0, tolerance = 0.3): boolean {
  let enter = 0, leave = 1;
  for (let k = 0; k < 3; k++) {
    const velocity = (a1.min[k] - a0.min[k]) - (b1.min[k] - b0.min[k]);
    const left = b0.min[k] - a0.max[k] + tolerance;
    const right = b0.max[k] - a0.min[k] - tolerance;
    if (Math.abs(velocity) < 1e-12) {
      if (left >= 0 || right <= 0) return false;
      continue;
    }
    const t0 = left / velocity, t1 = right / velocity;
    enter = Math.max(enter, Math.min(t0, t1));
    leave = Math.min(leave, Math.max(t0, t1));
    if (enter >= leave - 1e-12) return false;
  }
  return leave > 0 && enter < 1;
}

/** Bound the arc of a rotating point about its origin, not just its endpoints. */
export function rotationPadding(radius: number, radians: number): number {
  return 2 * Math.max(0, radius) * Math.sin(Math.min(Math.PI, Math.abs(radians)) / 2);
}
