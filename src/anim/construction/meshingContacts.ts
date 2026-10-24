/** Semantic recognition of completed gear-tooth contacts.
 *
 * Gear tooth surfaces in LDraw render meshes deliberately interpenetrate at
 * their engaged final pose. Their interface is NOT a free-space route: this
 * certificate is *static-only*, requires an actually separable shallow contact
 * on two gear/rack parts, and can never relax any moving triangle collision.
 * The solver must still find and continuously validate a route around it.
 */
import type { MeshOracle } from './collision';
import { norm, pos, sub } from './math';
import type { ConstructionModel, ConstructionNode, Connection } from './types';

const gear = (s: string) => /\b(gear|cog|pinion)\b/i.test(s);
const rack = (s: string) => /\bgear\s*rack\b|\brack\s*gear\b/i.test(s);
const desc = (m: ConstructionModel, n: ConstructionNode) => m.metrics(n.part!).description ?? '';

export function recognizedGearMesh(model: ConstructionModel, a: ConstructionNode, b: ConstructionNode, oracle: MeshOracle): Connection | undefined {
  if (!a.part || !b.part) return;
  const da = desc(model, a), db = desc(model, b);
  if (!(gear(da) && gear(db))) return;
  if (!([da, db].some(d => !rack(d)) || ([da, db].every(rack)))) return;
  // Coincident gears are intersecting solids, not a gear mesh. Require distinct
  // engagement centres, then independently prove the overlap can be separated
  // by a small displacement in the finished model.
  if (norm(sub(pos(a.matrix), pos(b.matrix))) < 8) return;
  const first = oracle.staticContact(a.id, b.id, undefined, 0);
  if (first.kind !== 'unresolved') return;
  const observed = oracle.staticContact(a.id, b.id, undefined, 8.05);
  if (observed.kind !== 'surface' || !observed.separation || norm(observed.separation) > 8.05) return;
  return {
    id: 'gear-mesh:' + JSON.stringify([a.id, b.id]),
    parent: a.id, child: b.id, kind: 'mechanical', confidence: 'inferred',
    surfaceTolerance: norm(observed.separation), staticOnly: true,
  };
}
