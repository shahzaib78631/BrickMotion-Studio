import type { PartMetrics } from '../ldraw/metrics';
import { collisionWorld, type Solid } from '../plan/collision';
import { connectorsMate, jointConnectors, partConnectors, worldConnectors } from '../plan/connectors';

type Part = { part: string; matrix: number[]; new: boolean };
/** Validate assembled transforms only. Exploded illustration offsets are never assembly poses. */
export function auditBookletAssembly(parts: readonly Part[], metrics: (part: string) => PartMetrics) {
  const missing: number[] = [];
  const solids: Solid[] = [];
  const connectors = parts.map((p, i) => {
    const m = metrics(p.part);
    if (m.placeholder || !m.mesh?.length) { missing.push(i); return []; }
    else solids.push({ id: String(i), world: p.matrix, body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh, joints: jointConnectors(m) });
    return worldConnectors(partConnectors(m), p.matrix);
  });
  const world = collisionWorld(solids);
  const pairs = new Map<string, { a: number; b: number; rule: string }>();
  for (const solid of solids) world.hits([solid], undefined, true, (id, rule) => {
    const a = Math.min(Number(solid.id), Number(id)), b = Math.max(Number(solid.id), Number(id));
    pairs.set(`${a}:${b}`, { a, b, rule });
  });
  const contacts = parts.flatMap((p, i) => !p.new ? [] : [{ index: i, part: p.part,
    mates: parts.flatMap((_q, j) => j === i ? [] : connectors[i].some((a) => connectors[j].some((b) => connectorsMate(a, b))) ? [j] : []),
    hasConnectors: connectors[i].length > 0,
  }]);
  return { scope: 'assembled part matrices; illustration offsets excluded', method: 'editor sampled mesh collision world and connector mating',
    missingGeometry: missing, collisions: [...pairs.values()], newPartContacts: contacts };
}
