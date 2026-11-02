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

/**
 * A nudge asked for in a piece's own axes, expressed in the model's. The delta is in the
 * plan's units (studs across, plates up, studs deep) and the basis is the piece's LDraw
 * transform, so a part turned 45° moves out along its own 45° axes — Blender's local
 * orientation, for the editor whose pieces are usually turned in quarter steps.
 */
export function localDelta(basis: Mat3, d: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  // the basis is LDraw (y down), the delta is plan units (y up)
  const vx = d.x * 20, vy = -d.y * 8, vz = d.z * 20;
  const mx = basis[0] * vx + basis[1] * vy + basis[2] * vz;
  const my = basis[3] * vx + basis[4] * vy + basis[5] * vz;
  const mz = basis[6] * vx + basis[7] * vy + basis[8] * vz;
  const clean = (n: number) => (Math.abs(n) < 1e-9 ? 0 : Math.round(n * 1e6) / 1e6);
  return { x: clean(mx / 20), y: clean(-my / 8), z: clean(mz / 20) };
}

/**
 * A translation asked for in a piece's own axes, snapped to that piece's own grid: a whole
 * stud across, a plate up. A piece off the world stud grid dragged with local axes still has
 * a grid — its own — so it moves in tidy increments instead of sliding freely. `delta` is a
 * view-space translation (studs, y up); the basis is the piece's LDraw transform.
 */
export function snapLocal(basis: Mat3, delta: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const v = [delta.x * 20, -delta.y * 20, -delta.z * 20];                  // LDU, y down
  const local = [0, 1, 2].map((c) => basis[0 * 3 + c] * v[0] + basis[1 * 3 + c] * v[1] + basis[2 * 3 + c] * v[2]);
  const step = [20, 8, 20];                                                // stud, plate, stud
  const snapped = local.map((n, i) => (Math.abs(n) < step[i] / 2 ? 0 : Math.round(n / step[i]) * step[i]));
  const out = [0, 1, 2].map((r) => basis[r * 3] * snapped[0] + basis[r * 3 + 1] * snapped[1] + basis[r * 3 + 2] * snapped[2]);
  const clean = (n: number) => (Object.is(n, -0) ? 0 : n);
  return { x: clean(out[0] / 20), y: clean(-out[1] / 20), z: clean(-out[2] / 20) };
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

/** `a` then `b`: the pose of something placed by `b` inside a frame placed by `a`. */
export function composePlacement(a: Placement, b: Placement): Placement {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a.m;
  const [b0, b1, b2, b3, b4, b5, b6, b7, b8] = b.m;
  const p = b.pos;
  return {
    pos: [
      z0(a0 * p[0] + a1 * p[1] + a2 * p[2] + a.pos[0]),
      z0(a3 * p[0] + a4 * p[1] + a5 * p[2] + a.pos[1]),
      z0(a6 * p[0] + a7 * p[1] + a8 * p[2] + a.pos[2]),
    ],
    m: [
      a0 * b0 + a1 * b3 + a2 * b6, a0 * b1 + a1 * b4 + a2 * b7, a0 * b2 + a1 * b5 + a2 * b8,
      a3 * b0 + a4 * b3 + a5 * b6, a3 * b1 + a4 * b4 + a5 * b7, a3 * b2 + a4 * b5 + a5 * b8,
      a6 * b0 + a7 * b3 + a8 * b6, a6 * b1 + a7 * b4 + a8 * b7, a6 * b2 + a7 * b5 + a8 * b8,
    ].map(z0) as Mat3,
  };
}

/**
 * The inverse frame. LDraw placements are orthonormal (a rotation, possibly
 * mirrored), so the transpose is the inverse; anything with a real shear is
 * already an invalid model (`factorAffine` rejects it), so report null rather
 * than invert something meaningless.
 */
export function invertPlacement(p: Placement): Placement | null {
  const m = p.m;
  for (let c = 0; c < 3; c++)
    for (let d = 0; d < 3; d++) {
      const dot = m[c] * m[d] + m[c + 3] * m[d + 3] + m[c + 6] * m[d + 6];
      if (Math.abs(dot - (c === d ? 1 : 0)) > 1e-6) return null;
    }
  const t = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]] as Mat3;
  const pos = p.pos;
  return {
    pos: [
      z0(-(t[0] * pos[0] + t[1] * pos[1] + t[2] * pos[2])),
      z0(-(t[3] * pos[0] + t[4] * pos[1] + t[5] * pos[2])),
      z0(-(t[6] * pos[0] + t[7] * pos[1] + t[8] * pos[2])),
    ],
    m: t,
  };
}

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

/** a rotation entry this close to 0 or ±1 is rounding noise from the authoring tool */
const ROT_NOISE = 2e-3;
/** a position this close to a half-LDU value on a squared-up part is noise too */
const POS_NOISE = 0.01;

/**
 * Exported models often carry tiny float noise (a 0.0003 tilt, 43.9948 for 44).
 * Invisible, but it throws off exact checks such as sliding along an axle, so a
 * placement that is square to within the noise is snapped to exact values.
 * Deliberate angles (hoses, hinges) are well outside the noise and kept as they are.
 */
export function tidyPlacement(p: Placement): Placement {
  const near = (v: number) => Math.round(v);
  if (!p.m.every((v) => Math.abs(v - near(v)) <= ROT_NOISE && Math.abs(near(v)) <= 1)) return p;
  const m = p.m.map((v) => near(v) || 0) as Placement['m'];
  // must be a signed permutation (a 90° rotation, possibly mirrored)
  for (let r = 0; r < 3; r++) if (Math.abs(m[r * 3]) + Math.abs(m[r * 3 + 1]) + Math.abs(m[r * 3 + 2]) !== 1) return p;
  for (let c = 0; c < 3; c++) if (Math.abs(m[c]) + Math.abs(m[c + 3]) + Math.abs(m[c + 6]) !== 1) return p;
  const pos = p.pos.map((v) => {
    const half = Math.round(v * 2) / 2;
    return Math.abs(v - half) <= POS_NOISE ? half || 0 : v;
  }) as Placement['pos'];
  return { pos, m };
}
