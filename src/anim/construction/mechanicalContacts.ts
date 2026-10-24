import { mateAxis, worldSnaps } from '../snapMates';
import type { MeshOracle } from './collision';
import type { Connection, ConstructionModel, ConstructionNode, ContactRegion } from './types';

const ZERO: [number, number, number] = [0, 0, 0];
/** Tight tolerance around a measured LDCad connector, not a whole-part collision waiver. */
const RADIAL_SKIN = 0.2;

/**
 * Explain an already observed completed-pose mesh contact only when actual
 * male/female LDCad cylinder connectors mate at that exact location AND the
 * collision oracle verifies that every contact is inside their short cylinders.
 *
 * The returned connection is deliberately staticOnly: the physical insertion
 * or withdrawal sweep must still pass normal continuous collision checks.
 * In particular, no pin or stud can pass through some unrelated piece because
 * its final resting pose contains a mating cylinder.
 */
export function certifiedMechanicalContact(
  model: ConstructionModel,
  moving: ConstructionNode,
  obstacle: ConstructionNode,
  oracle: MeshOracle,
): Connection | undefined {
  if (!moving.part || !obstacle.part) return undefined;
  const a = worldSnaps(model.metrics(moving.part).snaps, moving.matrix);
  const b = worldSnaps(model.metrics(obstacle.part).snaps, obstacle.matrix);
  if (!a.length || !b.length) return undefined;
  const regions: ContactRegion[] = [];
  for (const left of a) for (const right of b) {
    // mateAxis checks opposite gender, compatible profiles, parallel axes,
    // concentricity, and axial engagement. Do not substitute AABB proximity.
    if (!mateAxis(left, right)) continue;
    if (left.snap.kind !== 'cyl' || right.snap.kind !== 'cyl') continue;
    const female = left.snap.gender === 'F' ? left : right;
    const male = female === left ? right : left;
    if (female.snap.gender !== 'F' || male.snap.gender !== 'M') continue;
    if (!(female.snap.length > 0) || !(male.snap.length > 0)) continue;
    regions.push({
      origin: [...female.start], axis: [...female.axis],
      length: female.snap.length,
      radius: Math.max(female.snap.radius, male.snap.radius) + RADIAL_SKIN,
    });
  }
  if (!regions.length) return undefined;
  const certificate: Connection = {
    id: 'mechanical-contact:' + JSON.stringify([obstacle.id, moving.id]),
    parent: obstacle.id, child: moving.id,
    kind: 'mechanical', confidence: 'inferred', regions,
    staticOnly: true,
  };
  // Actual LDraw triangles and containment, not merely matched metadata,
  // must be fully explained by the short contact cylinders.
  return oracle.clear(moving.id, obstacle.id, ZERO, ZERO, ZERO, certificate) ? certificate : undefined;
}
