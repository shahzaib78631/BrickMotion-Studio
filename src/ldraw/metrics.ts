import type { Box, FlatPart } from './flatten';

export type PartMetrics = {
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
};

/** very detailed parts are thinned to this many triangles for planning */
const MAX_MESH_TRIS = 40000;

function meshOf(flat: FlatPart): { mesh: Float32Array; twoSidedFrom: number } | undefined {
  const one = [...flat.tris.values()];
  const two = [...flat.doubleSided.values()];
  const total = [...one, ...two].reduce((n, l) => n + l.length / 9, 0);
  if (!total) return undefined;
  const stride = Math.max(1, total / MAX_MESH_TRIS);
  const out = new Float32Array(Math.min(total, MAX_MESH_TRIS) * 9);
  let j = 0, i = 0, twoSidedFrom = 0;
  const take = (lists: number[][]) => {
    for (const l of lists)
      for (let t = 0; t < l.length; t += 9, i++) {
        if (Math.floor(j * stride) !== i || j * 9 >= out.length) continue;
        out.set(l.slice(t, t + 9), j * 9);
        j++;
      }
  };
  take(one);
  twoSidedFrom = j;
  take(two);
  return { mesh: out.subarray(0, j * 9), twoSidedFrom };
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
    ...(() => {
      const m = meshOf(flat);
      return m ? { mesh: m.mesh, meshTwoSidedFrom: m.twoSidedFrom } : {};
    })(),
  };
}
