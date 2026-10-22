import type { Box } from '../ldraw/flatten';
import type { Mat3, Vec3 } from '../ldraw/parse';
import type { Grid, Rot } from './types';

export type { Rot } from './types';
/** LDraw transform: part space → parent model space. */
export type Placement = { pos: Vec3; m: Mat3 };

const z0 = (n: number) => (Object.is(n, -0) ? 0 : n);

export function rotMatrix(rot: Rot): Mat3 {
  const r = (rot * Math.PI) / 180;
  const c = Math.round(Math.cos(r));
  const s = Math.round(Math.sin(r));
  return [c, 0, s, 0, 1, 0, -s, 0, c].map(z0) as Mat3;
}

export function rotatedBox(body: Box, m: Mat3): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [body.min[0], body.max[0]])
    for (const y of [body.min[1], body.max[1]])
      for (const z of [body.min[2], body.max[2]]) {
        const p = [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
        for (let i = 0; i < 3; i++) {
          min[i] = Math.min(min[i], p[i]);
          max[i] = Math.max(max[i], p[i]);
        }
      }
  return { min: min.map(z0) as Vec3, max: max.map(z0) as Vec3 };
}

function footprint(rb: Box) {
  return {
    fw: Math.max(1, Math.round((rb.max[0] - rb.min[0]) / 20)),
    fd: Math.max(1, Math.round((rb.max[2] - rb.min[2]) / 20)),
  };
}

export function gridToPlacement(g: Grid, body: Box): Placement {
  const m = rotMatrix(g.rot);
  const rb = rotatedBox(body, m);
  const { fw, fd } = footprint(rb);
  return {
    pos: [
      z0((g.x + fw / 2) * 20 - (rb.min[0] + rb.max[0]) / 2),
      z0(-g.y * 8 - rb.max[1]),
      z0((g.z + fd / 2) * 20 - (rb.min[2] + rb.max[2]) / 2),
    ],
    m,
  };
}

const ROTS: Rot[] = [0, 90, 180, 270];

export function placementToGrid(p: Placement, body: Box): Grid | null {
  const rot = ROTS.find((r) => rotMatrix(r).every((v, i) => Math.abs(v - p.m[i]) < 1e-6));
  if (rot === undefined) return null;
  const rb = rotatedBox(body, p.m);
  const { fw, fd } = footprint(rb);
  const x = (p.pos[0] + (rb.min[0] + rb.max[0]) / 2) / 20 - fw / 2;
  const y = -(p.pos[1] + rb.max[1]) / 8;
  const z = (p.pos[2] + (rb.min[2] + rb.max[2]) / 2) / 20 - fd / 2;
  const near = (v: number, unit: number) => Math.abs(v - Math.round(v)) * unit <= 0.5;
  if (!near(x, 20) || !near(y, 8) || !near(z, 20)) return null;
  return { x: z0(Math.round(x)), y: z0(Math.round(y)), z: z0(Math.round(z)), rot };
}
