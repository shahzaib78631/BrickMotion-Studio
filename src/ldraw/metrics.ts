import type { Box, FlatPart } from './flatten';
import { bottomSocketFace, type ConnectionGeometry } from './connectors';
import type { Snap } from './shadow';

export type PartMetrics = ConnectionGeometry & {
  id: string;
  body: Box;
  full: Box;
  footprint: { w: number; d: number };
  heightPlates: number;
  placeholder: boolean;
  /**
   * The part's surface as a flat xyz triangle list (part space, LDU), so the planner
   * can tell how a piece really goes on (a hand into a wrist, a ring over a neck).
   * Missing for placeholders.
   */
  mesh?: Float32Array;
  /** triangles from this index on (in `mesh`) have no known front face */
  meshTwoSidedFrom?: number;
  /** LDCad shadow-library connectors in part space; absent when the shadow pack is not installed */
  snaps?: Snap[];
};

/** Collision geometry must retain every surface; dropping triangles creates holes. */
function meshOf(flat: FlatPart): { mesh: Float32Array; twoSidedFrom: number } | undefined {
  const one = [...flat.tris.values()], two = [...flat.doubleSided.values()];
  const floats = [...one, ...two].reduce((n, list) => n + list.length, 0);
  if (!floats) return undefined;
  const mesh = new Float32Array(floats);
  let offset = 0;
  for (const list of one) { mesh.set(list, offset); offset += list.length; }
  const twoSidedFrom = offset / 9;
  for (const list of two) { mesh.set(list, offset); offset += list.length; }
  return { mesh, twoSidedFrom };
}

const PLACEHOLDER_BOX: Box = { min: [0, 0, 0], max: [20, 24, 20] };

export function measurePart(flat: FlatPart | null, id: string): PartMetrics {
  const body = flat?.bodyBox ?? flat?.fullBox ?? null;
  if (!flat || !body) {
    const b = { min: [...PLACEHOLDER_BOX.min], max: [...PLACEHOLDER_BOX.max] } as Box;
    return { id, body: b, full: { min: [...b.min], max: [...b.max] } as Box, footprint: { w: 1, d: 1 }, heightPlates: 3, placeholder: true };
  }
  return {
    id,
    body,
    full: flat.fullBox ?? body,
    footprint: {
      w: Math.max(1, Math.round((body.max[0] - body.min[0]) / 20)),
      d: Math.max(1, Math.round((body.max[2] - body.min[2]) / 20)),
    },
    heightPlates: Math.max(1, Math.round((body.max[1] - body.min[1]) / 8)),
    placeholder: false,
    studs: flat.studs,
    ...(flat.snaps ? { snaps: flat.snaps } : {}),
    socketFace: bottomSocketFace(body, flat.description ?? ''),
    ...(() => {
      const m = meshOf(flat);
      return m ? { mesh: m.mesh, meshTwoSidedFrom: m.twoSidedFrom } : {};
    })(),
  };
}
