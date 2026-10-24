/**
 * Reviewed *final-pose* render-surface contacts.
 *
 * These are NOT joints, do not generate dependencies and NEVER authorize a
 * moving collision. Each review is tied to one pair of instance IDs, part
 * identifiers and a measured relative affine transform (obstacle^-1 * moving).
 * Common translation/rotation of the whole model preserves that relative pose.
 * Any change to the relationship between the two parts invalidates the review.
 */
import { type M4, type V3, invert, multiply, vector, unit, mul, norm } from './math';
import type { ConstructionModel, ConstructionNode, Connection } from './types';
import type { MeshOracle } from './collision';

export type ReviewedSurfaceContact = {
  id: string;
  moving: string;
  obstacle: string;
  movingPart: string;
  obstaclePart: string;
  /** Obstacle-local rigid/affine transform of the moving piece. */
  relativePose: M4;
  /** Separating direction in the obstacle's local frame; NOT a joint axis. */
  outwardLocal: V3;
  /** Verified maximum resting-pose separation (LDU). Never a motion waiver. */
  surfaceTolerance: number;
  /** Independent clear-pose verification distance (LDU). */
  clearanceProbe: number;
};

const HELI_FACET = ':2:0/helicopter:10:0';
/**
 * Explicitly reviewed LEGO 5590 MPD instance poses. This list intentionally
 * does NOT match just a part-number pair and does NOT raise the default 2 LDU
 * surface probe. These references are revalidated against live LDraw meshes.
 */
export const REVIEWED_5590_SURFACES: readonly ReviewedSurfaceContact[] = [
  {
    id: '5590/helicopter/round-plate-facet',
    moving: ':2:0/helicopter:9:3', obstacle: HELI_FACET,
    movingPart: '4073', obstaclePart: '2462',
    relativePose: [0,-1,0,0,1,0,0,0,0,0,1,0,-18,10,-37.9533,1],
    outwardLocal: [0,0,-1], surfaceTolerance: 2.1, clearanceProbe: 2.5,
  },
  {
    id: '5590/helicopter/loudhailer-facet',
    moving: ':2:0/helicopter:9:4', obstacle: HELI_FACET,
    movingPart: '4349', obstaclePart: '2462',
    relativePose: [0,-1,0,0,0,0,1,0,-1,0,0,0,-40,10,-37.9533,1],
    outwardLocal: [0,0,-1], surfaceTolerance: 2.1, clearanceProbe: 2.5,
  },
];

const canonical = (part: string) => part.toLowerCase().replace(/\.dat$/, '');

/** Geometric guard, independent of instance/world placement. */
export function matchesReviewedSurface(
  moving: ConstructionNode,
  obstacle: ConstructionNode,
  review: ReviewedSurfaceContact,
  linearTolerance = 1e-5,
  positionTolerance = 1e-3,
): boolean {
  if (moving.id !== review.moving || obstacle.id !== review.obstacle ||
      !moving.part || !obstacle.part ||
      canonical(moving.part) !== canonical(review.movingPart) ||
      canonical(obstacle.part) !== canonical(review.obstaclePart)) return false;
  if (review.relativePose.length !== 16 || !review.relativePose.every(Number.isFinite)) return false;
  if (!Number.isFinite(review.surfaceTolerance) || review.surfaceTolerance <= 0 || review.surfaceTolerance > 2.1 ||
      !Number.isFinite(review.clearanceProbe) || review.clearanceProbe < review.surfaceTolerance || review.clearanceProbe > 3 ||
      review.outwardLocal.length !== 3 || !review.outwardLocal.every(Number.isFinite) || norm(review.outwardLocal) < 1e-8) return false;
  let actual: M4;
  try { actual = multiply(invert(obstacle.matrix), moving.matrix); } catch { return false; }
  return actual.every((x, i) => Math.abs(x - review.relativePose[i]) <= (i >= 12 && i <= 14 ? positionTolerance : linearTolerance));
}

/**
 * Re-measure a REVIEWED, exact-pose surface contact from live mesh geometry.
 * No policy is passed into the oracle: checks must pass ordinary unrelaxed mesh
 * tests, and the returned staticOnly connection cannot weaken moving sweeps.
 */
export function verifyReviewedSurface(
  model: ConstructionModel,
  review: ReviewedSurfaceContact,
  oracle: MeshOracle,
): Connection | undefined {
  const moving = model.parts.get(review.moving), obstacle = model.parts.get(review.obstacle);
  if (!moving || !obstacle || !matchesReviewedSurface(moving, obstacle, review)) return;
  const zero: V3 = [0, 0, 0];
  let outward: V3;
  try { outward = unit(vector(obstacle.matrix, review.outwardLocal)); } catch { return; }
  if (oracle.clear(moving.id, obstacle.id, zero, zero, zero)) return; // no actual contact to certify
  // The approved direction must clear *within* the tight bound, not merely
  // become clear at some arbitrary separation along other possible axes.
  const step = review.surfaceTolerance / 16;
  let firstClear: number | undefined;
  for (let i = 1; i <= 16; i++) {
    const distance = step * i;
    if (oracle.clear(moving.id, obstacle.id, mul(outward, distance), zero, zero)) {
      firstClear = distance;
      break;
    }
  }
  if (firstClear === undefined) return;
  // The provided clear-pose witness must also remain valid at 2.5 LDU; this
  // is an independent endpoint check, not a swept-path certificate.
  const clearOffset = mul(outward, review.clearanceProbe);
  if (!oracle.clear(moving.id, obstacle.id, clearOffset, zero, zero)) return;
  return {
    id: `reviewed-surface:${review.id}`,
    parent: obstacle.id, child: moving.id,
    kind: 'surface', confidence: 'declared',
    outward, surfaceTolerance: review.surfaceTolerance, staticOnly: true,
  };
}
