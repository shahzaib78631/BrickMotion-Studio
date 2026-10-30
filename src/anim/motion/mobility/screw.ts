/**
 * Joints from constraint wrenches (screw theory).
 *
 * Each connector between two parts blocks some motions; we write those as
 * constraint wrenches (forces along lines and couples). The motions two bodies
 * still have are the twists reciprocal to every wrench between them:
 * for a wrench (f, m) and a twist (w, v), m.w + f.v = 0. The dimension of that
 * twist space is the joint's degrees of freedom and its shape is the joint
 * type. Combining connectors this way is exact: two coaxial pins leave a
 * hinge, two parallel pins on different lines leave nothing.
 *
 * Method: Xiong, Chen, Ding, Wu & Hou, "Recognition of Kinematic Joints of 3D
 * Assembly Models Based on Reciprocal Screw Theory", Math. Probl. Eng. 2016:
 * same conventions (twist [w; v at origin], wrench [f; m about origin],
 * reciprocal product w.m + v.f = 0), wrenches of all constraints between two
 * parts stacked, the twist space is their reciprocal complement, and the
 * joint is read from its shape (their section 2.2 twist forms). Two changes:
 *  - their position constraint is written (a; 0), a force through the global
 *    origin; we put each force on its real line (moment p x f), otherwise an
 *    off-origin hinge comes out wrong;
 *  - rank uses a symmetric eigen solver with a geometric tolerance instead of
 *    Gram-Schmidt, so placement slop does not lock a joint.
 * Whole-assembly mobility is NOT done by their twist union/intersection
 * (first order only, no coupled loops); see mobility.ts.
 */
import { nullSpace6, symmetricEigen } from './linalg';

export type V3 = [number, number, number];
/** Angular velocity w and the velocity v of the point at the world origin. */
export type Twist = { w: V3; v: V3 };
export type JointKind = 'fixed' | 'revolute' | 'prismatic' | 'helical' | 'cylindrical' | 'spherical' | 'planar' | 'other';
export type ScrewJoint = {
  kind: JointKind;
  dof: number;
  /** Rotation axis (revolute, cylindrical) or slide direction (prismatic), unit. */
  axis?: V3;
  /** A point on the rotation axis, or the ball centre. */
  point?: V3;
  /** World twist basis of the allowed motion of the second body relative to the first. */
  twists: Twist[];
};

/** What one connector leaves free about its own axis line. */
export type ConnectorFreedom = {
  centre: V3; axis: V3;
  /** 'ball': only the centre is held. 'face': flat contact with `axis` as the
   * normal (Xiong's coplanar constraint). Otherwise turn/slide along the axis. */
  ball?: boolean; face?: boolean; turns: boolean; slides: boolean;
};

/** Lengths are compared in this unit: one stud. A lever arm or axis offset
 * below TOLERANCE studs (about 2 LDU, the connector matching slop) or a
 * direction difference below ~6 degrees does not lock a joint. */
export const UNIT = 20;
const TOLERANCE = 0.1;

const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: readonly number[], s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: readonly number[]): V3 => scale(a, 1 / (len(a) || 1));
/** Two unit vectors perpendicular to u. */
const perpendiculars = (u: V3): [V3, V3] => {
  const seed: V3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const a = unit(cross(u, seed));
  return [a, cross(u, a)];
};

/** Constraint wrench rows [m, f] (moment about `ref`, lengths in studs). */
export function connectorWrenches(c: ConnectorFreedom, ref: V3): number[][] {
  const p = scale(sub(c.centre, ref), 1 / UNIT);
  const force = (f: V3) => [...cross(p, f), ...f];
  const couple = (m: V3) => [...m, 0, 0, 0];
  if (c.ball) return [force([1, 0, 0]), force([0, 1, 0]), force([0, 0, 1])];
  const u = unit(c.axis), [a, b] = perpendiculars(u);
  if (c.face) return [force(u), couple(a), couple(b)];
  return [force(a), force(b), couple(a), couple(b),
    ...(c.slides ? [] : [force(u)]), ...(c.turns ? [] : [couple(u)])];
}

/** The joint left between two bodies by all their connectors. */
export function screwJoint(connectors: readonly ConnectorFreedom[]): ScrewJoint {
  if (!connectors.length) throw Error('screwJoint needs at least one connector');
  const ref = scale(connectors.reduce<V3>((s, c) => [s[0] + c.centre[0], s[1] + c.centre[1], s[2] + c.centre[2]], [0, 0, 0]), 1 / connectors.length);
  const rows = connectors.flatMap(c => connectorWrenches(c, ref));
  const local = nullSpace6(rows, TOLERANCE);
  // Back to world twists: v at ref (studs -> LDU), then moved to the origin.
  const twists = local.map(t => {
    const w: V3 = [t[0], t[1], t[2]], vRef = scale([t[3], t[4], t[5]], UNIT);
    return { w, v: sub(vRef, cross(w, ref)) };
  });
  return { ...classify(twists, ref), dof: twists.length, twists };
}

/** Velocity at point p of twist t. */
const at = (t: Twist, p: readonly number[]): V3 => { const c = cross(t.w, p); return [t.v[0] + c[0], t.v[1] + c[1], t.v[2] + c[2]]; };

function classify(twists: Twist[], ref: V3): Omit<ScrewJoint, 'dof' | 'twists'> {
  if (!twists.length) return { kind: 'fixed' };
  // Measure translation at the joint (ref), in studs, against rotation.
  const local = twists.map(t => ({ w: t.w, v: scale(at(t, ref), 1 / UNIT) }));
  if (local.length === 1) {
    const { w, v } = local[0];
    if (len(w) < TOLERANCE * len(v)) return { kind: 'prismatic', axis: unit(v) };
    const pitch = dot(w, v) / dot(w, w);
    const axis = unit(w), point = [0, 1, 2].map(k => ref[k] + cross(w, v)[k] / dot(w, w) * UNIT) as V3;
    if (Math.abs(pitch) > TOLERANCE) return { kind: 'helical', axis, point };
    // Point on the axis: ref + (w x v)/|w|^2, back in LDU.
    return { kind: 'revolute', axis: unit(w), point: [0, 1, 2].map(k => ref[k] + cross(w, v)[k] / dot(w, w) * UNIT) as V3 };
  }
  if (local.length === 2) {
    // A pure translation in the span, and a rotation about the same direction?
    const [p, q] = local;
    const g = [[dot(p.w, p.w), dot(p.w, q.w)], [dot(p.w, q.w), dot(q.w, q.w)]];
    // Smallest-eigenvector of the 2x2 Gram of the rotations.
    const tr = g[0][0] + g[1][1], det = g[0][0] * g[1][1] - g[0][1] * g[1][0];
    const small = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const coef: [number, number] = Math.abs(g[0][1]) > 1e-12 ? [g[0][1], small - g[0][0]] : g[0][0] <= g[1][1] ? [1, 0] : [0, 1];
    const n = Math.hypot(...coef), [x, y] = [coef[0] / n, coef[1] / n];
    const tw: V3 = [0, 1, 2].map(k => x * p.w[k] + y * q.w[k]) as V3, tv: V3 = [0, 1, 2].map(k => x * p.v[k] + y * q.v[k]) as V3;
    const rw: V3 = [0, 1, 2].map(k => -y * p.w[k] + x * q.w[k]) as V3, rv: V3 = [0, 1, 2].map(k => -y * p.v[k] + x * q.v[k]) as V3;
    if (len(tw) < TOLERANCE * Math.max(len(tv), 1e-12) && len(rw) > TOLERANCE && Math.abs(dot(unit(tv), unit(rw))) > 1 - TOLERANCE * TOLERANCE) {
      // Remove the slide from the rotating twist to find the axis line.
      const axis = unit(rw), along = dot(rv, axis);
      const pure: V3 = [0, 1, 2].map(k => rv[k] - axis[k] * along) as V3;
      return { kind: 'cylindrical', axis, point: [0, 1, 2].map(k => ref[k] + cross(rw, pure)[k] / dot(rw, rw) * UNIT) as V3 };
    }
    return { kind: 'other' };
  }
  if (local.length === 3) {
    // Planar: one rotation direction n, the other two motions pure translations across n.
    const gram = local.map(a => local.map(b => dot(a.w, b.w)));
    const { values, vectors } = symmetricEigen(gram);
    const flat = values.filter(x => x <= TOLERANCE * TOLERANCE).length;
    if (flat === 2) {
      const combo = (k: number) => {
        const c = vectors.map(row => row[k]);
        return { w: [0, 1, 2].map(i => local.reduce((s, t, j) => s + c[j] * t.w[i], 0)) as V3,
          v: [0, 1, 2].map(i => local.reduce((s, t, j) => s + c[j] * t.v[i], 0)) as V3 };
      };
      const n = unit(combo(2).w), slides = [combo(0), combo(1)];
      if (slides.every(t => Math.abs(dot(unit(t.v), n)) < TOLERANCE)) return { kind: 'planar', axis: n };
    }
    // Spherical: three rotations whose velocities vanish at one point c: v_i = c x w_i.
    // Solve for c (in studs from ref) by least squares on 9 equations.
    const rows: number[][] = [], rhs: number[] = [];
    for (const { w, v } of local) {
      // c x w = -[w]x c  ->  rows of -[w]x
      rows.push([0, w[2], -w[1]], [-w[2], 0, w[0]], [w[1], -w[0], 0]); rhs.push(v[0], v[1], v[2]);
    }
    const ata = [0, 1, 2].map(i => [0, 1, 2].map(j => rows.reduce((s, r) => s + r[i] * r[j], 0)));
    const atb = [0, 1, 2].map(i => rows.reduce((s, r, k) => s + r[i] * rhs[k], 0));
    const c = solve3(ata, atb);
    if (c) {
      const residual = Math.sqrt(rows.reduce((s, r, k) => s + (dot(r, c) - rhs[k]) ** 2, 0));
      if (residual < TOLERANCE) return { kind: 'spherical', point: [0, 1, 2].map(k => ref[k] + c[k] * UNIT) as V3 };
    }
  }
  return { kind: 'other' };
}

function solve3(a: number[][], b: number[]): V3 | null {
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(a);
  if (Math.abs(d) < 1e-12) return null;
  return [0, 1, 2].map(k => det(a.map((row, i) => row.map((x, j) => (j === k ? b[i] : x)))) / d) as V3;
}
