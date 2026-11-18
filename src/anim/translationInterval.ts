import type { Box } from '../ldraw/flatten';

/** Configuration-space broad-phase interval for a straight world-axis sweep.
 * Bounds are centered at each part's matrix translation (world orientation and
 * scale retained). TWO LDU of empty space are retained at either end, exceeding
 * the existing 0.3-LDU ray-start/contact threshold, 1-LDU authoring slop and
 * 0.001-LDU box rounding. Only certificate identity is clipped; the first query
 * still runs the entire original sweep with every sample and tolerance intact.
 * This is deliberately not applied to diagonal or rotating trajectories. */
export function canonicalTranslationInterval(moving: Box, fixed: Box, axis: number, from: number, to: number): [number, number] {
  const lo = fixed.min[axis] - moving.max[axis] - 2;
  const hi = fixed.max[axis] - moving.min[axis] + 2;
  if (![lo,hi,from,to].every(Number.isFinite) || lo > hi) return [from,to];
  const clip = (value: number) => Math.max(lo, Math.min(hi, value));
  return [clip(from), clip(to)];
}
