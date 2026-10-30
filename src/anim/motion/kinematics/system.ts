/**
 * A mechanism in joint coordinates (the unified solver's model).
 *
 * Bodies move by world deltas D_b = pose_b * rest_b^-1, so a body at rest has
 * D = I and every joint is described once, in the assembled (rest) world.
 * A spanning tree from ground gives D_child = D_parent * M_j(q_j), where M_j
 * is a product of exponentials of rest-world twists (Murray, Li & Sastry,
 * ch. 3). Every joint off the tree is a cut joint: it keeps its own
 * coordinates and adds six closure equations D_b = D_a * M_c(q_c), the
 * cut-joint form of Mueller (Mech. Sci. 2015) already used by mobility/.
 *
 * The Jacobian is analytic: a coordinate's column is its current world twist
 * (the adjoint of its rest twist), and the rotation rows use the inverse left
 * Jacobian of SO(3), so it is exact off the closure too, not only at it.
 * Rotation rows are scaled by UNIT (20 LDU per radian), as in mobility/.
 */
import { UNIT } from '../mobility/screw';
import {
  adjoint, apply, compose, cross, dot, expSO3, identity, invert, invLeftJacobianSO3, logSO3, mulMM, mulMtV, mulMV,
  orthonormalize, rotationAbout, scale, sub, transpose, unit, add, type Frame, type M3, type V3,
} from './rigid';

export type JointKind = 'revolute' | 'prismatic' | 'cylindrical' | 'universal' | 'spherical' | 'planar' | 'fixed';
export type JointSpec = {
  id: string;
  /** null = ground. */
  parent: string | null;
  child: string;
  kind: JointKind;
  /** Rest-world point on the joint axis (centre for spherical and universal). */
  point: V3;
  /** Rest-world axis; planar: the plane normal. */
  axis: V3;
  /** Universal: the second (child) axis, perpendicular to axis. Planar: first in-plane direction (optional). */
  axis2?: V3;
};
/** Equations that never form part of the tree (closures between bodies). */
export type Equation =
  | { kind: 'point'; id: string; a: string | null; b: string | null; point: V3 }
  | { kind: 'distance'; id: string; a: string | null; pa: V3; b: string | null; pb: V3; length: number }
  /**
   * A point fixed on `carrier` (rest-world `point`), seen from `frame`'s own
   * rest frame, moves by -along . offset = ratio * coord (a rack rolling on
   * a pinion whose rack can also swing).
   */
  | { kind: 'rolling'; id: string; carrier: string | null; frame: string; point: V3; along: V3; coord: Coord; ratio: number };
/** A scalar coordinate: 'joint' (its first) or 'joint:k'. */
export type Coord = string;
export type Row = { id: string; value: number; grad: Float64Array };
export type State = { readonly q: Float64Array; readonly rot: ReadonlyMap<string, M3> };

const DOF: Record<JointKind, number> = { revolute: 1, prismatic: 1, cylindrical: 2, universal: 2, spherical: 3, planar: 3, fixed: 0 };
const ANGULAR: Record<JointKind, boolean[]> = {
  revolute: [true], prismatic: [false], cylindrical: [true, false], universal: [true, true],
  spherical: [true, true, true], planar: [false, false, true], fixed: [],
};
type Twist = { w: V3; v: V3 };
type Contribution = { k: number; w: V3; v: V3 };
type Prepared = JointSpec & { offset: number; dof: number; e1: V3; e2: V3 };

const velocity = (c: Contribution, y: V3): V3 => add(cross(c.w, y), c.v);
const NONE: Contribution[] = [];

export class KinematicSystem {
  readonly coords: Coord[] = [];
  readonly angular: boolean[] = [];
  readonly bodies: readonly string[];
  readonly joints: readonly Prepared[];
  /** Tree joints in evaluation order, and the direction each is walked. */
  readonly tree: string[] = [];
  readonly cuts: string[] = [];
  readonly equations: readonly Equation[];
  private readonly walk: { joint: Prepared; forward: boolean; from: string | null; to: string }[] = [];
  private readonly index = new Map<Coord, number>();
  private readonly byId = new Map<string, Prepared>();

  constructor(spec: { bodies: readonly string[]; joints: readonly JointSpec[]; equations?: readonly Equation[] }) {
    this.bodies = [...spec.bodies];
    const known = new Set(this.bodies);
    const has = (b: string | null) => b === null || known.has(b);
    let offset = 0;
    this.joints = spec.joints.map(j => {
      if (this.byId.has(j.id)) throw Error(`Duplicate joint ${j.id}`);
      if (!has(j.parent) || !known.has(j.child) || j.parent === j.child) throw Error(`Joint ${j.id}: unknown or identical bodies`);
      const axis = unit(j.axis);
      let e1: V3, e2: V3;
      if (j.kind === 'universal') {
        if (!j.axis2) throw Error(`Joint ${j.id}: a universal joint needs axis2`);
        e1 = unit(j.axis2); if (Math.abs(dot(e1, axis)) > 1e-3) throw Error(`Joint ${j.id}: universal axes must be perpendicular`);
        e2 = cross(axis, e1);
      } else {
        const ref = j.axis2 && Math.abs(dot(unit(j.axis2), axis)) < 0.999 ? unit(j.axis2) : Math.abs(axis[0]) < 0.7 ? [1, 0, 0] as V3 : [0, 1, 0] as V3;
        e1 = unit(sub(ref, scale(axis, dot(ref, axis)))); e2 = cross(axis, e1);
      }
      const p: Prepared = { ...j, axis, offset, dof: DOF[j.kind], e1, e2 };
      for (let k = 0; k < p.dof; k++) {
        const name = p.dof === 1 ? j.id : `${j.id}:${k}`;
        this.index.set(name, offset + k); this.coords.push(name); this.angular.push(ANGULAR[j.kind][k]);
      }
      if (p.dof > 1) this.index.set(j.id, offset);
      offset += p.dof;
      this.byId.set(j.id, p);
      return p;
    });
    this.equations = [...(spec.equations ?? [])];
    for (const e of this.equations) {
      const ends = e.kind === 'rolling' ? [e.carrier, e.frame] : [e.a, e.b];
      if (!ends.every(has)) throw Error(`Equation ${e.id}: unknown body`);
      if (e.kind === 'rolling') this.coordIndex(e.coord);
    }
    // Spanning tree by breadth-first search from ground: welds first, then
    // joints with fewer coordinates (a cut then carries the most freedom).
    const order = [...this.joints].sort((a, b) => (a.kind === 'fixed' ? 0 : 1) - (b.kind === 'fixed' ? 0 : 1) || a.dof - b.dof);
    const reached = new Set<string | null>([null]);
    const queue: (string | null)[] = [null];
    const used = new Set<string>();
    const grow = () => {
      for (let i = 0; i < queue.length; i++) {
        const u = queue[i];
        for (const j of order) {
          if (used.has(j.id)) continue;
          const forward = j.parent === u, backward = j.child === u;
          if (!forward && !backward) continue;
          const to = forward ? j.child : j.parent;
          if (reached.has(to)) continue;
          used.add(j.id); reached.add(to); queue.push(to);
          this.walk.push({ joint: j, forward, from: u, to: to as string });
          this.tree.push(j.id);
        }
      }
    };
    grow();
    // Components without ground are held where they were assembled.
    for (const b of this.bodies) if (!reached.has(b)) { reached.add(b); queue.push(b); grow(); }
    for (const j of this.joints) if (!used.has(j.id)) this.cuts.push(j.id);
  }

  coordIndex(c: Coord): number {
    const i = this.index.get(c);
    if (i === undefined) throw Error(`Unknown coordinate ${c}`);
    return i;
  }
  jointOf(id: string): Prepared | undefined { return this.byId.get(id); }

  zeroState(): State {
    return { q: new Float64Array(this.coords.length), rot: new Map(this.joints.filter(j => j.kind === 'spherical').map(j => [j.id, [1, 0, 0, 0, 1, 0, 0, 0, 1]])) };
  }

  value(s: State, c: Coord): number {
    const i = this.coordIndex(c);
    const j = this.joints.find(x => i >= x.offset && i < x.offset + x.dof)!;
    if (j.kind === 'spherical') throw Error(`Coordinate ${c} of a ball joint has no value`);
    return s.q[i];
  }

  /** Coordinates plus delta; a ball joint turns by exp(delta) on the left. */
  step(s: State, delta: ArrayLike<number>): State {
    const q = Float64Array.from(s.q, (x, i) => x + delta[i]);
    const rot = new Map(s.rot);
    for (const j of this.joints) if (j.kind === 'spherical') {
      const o = j.offset;
      q[o] = q[o + 1] = q[o + 2] = 0;
      rot.set(j.id, orthonormalize(mulMM(expSO3([delta[o], delta[o + 1], delta[o + 2]]), s.rot.get(j.id)!)));
    }
    return { q, rot };
  }

  /** Joint motion in the rest world and the rest-world twist of each coordinate. */
  private motion(j: Prepared, s: State): { M: Frame; twists: Twist[] } {
    const q = s.q, o = j.offset, c = j.point, a = j.axis;
    const turn = (w: V3): Twist => ({ w, v: cross(c, w) });
    switch (j.kind) {
      case 'fixed': return { M: identity(), twists: [] };
      case 'revolute': return { M: rotationAbout(a, c, q[o]), twists: [turn(a)] };
      case 'prismatic': return { M: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], p: scale(a, q[o]) }, twists: [{ w: [0, 0, 0], v: a }] };
      case 'cylindrical': {
        const M = rotationAbout(a, c, q[o]);
        return { M: { R: M.R, p: add(M.p, scale(a, q[o + 1])) }, twists: [turn(a), { w: [0, 0, 0], v: a }] };
      }
      case 'universal': {
        const M1 = rotationAbout(a, c, q[o]), b = mulMV(M1.R, j.e1);
        return { M: compose(M1, rotationAbout(j.e1, c, q[o + 1])), twists: [turn(a), turn(b)] };
      }
      case 'spherical': {
        const R = s.rot.get(j.id)!;
        return { M: { R, p: sub(c, mulMV(R, c)) }, twists: [turn([1, 0, 0]), turn([0, 1, 0]), turn([0, 0, 1])] };
      }
      case 'planar': {
        const t = add(scale(j.e1, q[o]), scale(j.e2, q[o + 1])), M = rotationAbout(a, c, q[o + 2]);
        return { M: { R: M.R, p: add(M.p, t) }, twists: [{ w: [0, 0, 0], v: j.e1 }, { w: [0, 0, 0], v: j.e2 }, { w: a, v: cross(add(c, t), a) }] };
      }
    }
  }

  /** Every body's delta and the world twists of the coordinates it depends on. */
  private evaluate(s: State) {
    const D = new Map<string | null, Frame>([[null, identity()]]);
    const anc = new Map<string | null, Contribution[]>([[null, NONE]]);
    for (const b of this.bodies) { D.set(b, identity()); anc.set(b, NONE); }
    for (const { joint, forward, from, to } of this.walk) {
      const { M, twists } = this.motion(joint, s);
      const Df = D.get(from)!;
      // Forward: D_to = D_from M. Backward: D_to = D_from M^-1.
      const Dt = forward ? compose(Df, M) : compose(Df, invert(M));
      D.set(to, Dt);
      // A coordinate's world twist is Ad(D of the joint's parent body) of its rest twist; walking backward negates it.
      const Dp = forward ? Df : Dt, sign = forward ? 1 : -1;
      const own = twists.map((t, k) => { const x = adjoint(Dp, t.w, t.v); return { k: joint.offset + k, w: scale(x.w, sign), v: scale(x.v, sign) }; });
      anc.set(to, [...anc.get(from)!, ...own]);
    }
    return { D, anc };
  }

  deltas(s: State): Map<string, Frame> {
    const { D } = this.evaluate(s);
    D.delete(null);
    return D as Map<string, Frame>;
  }

  /** Closure rows of every cut joint and equation, with analytic gradients. */
  constraints(s: State): { rows: Row[]; deltas: Map<string, Frame> } {
    const n = this.coords.length, { D, anc } = this.evaluate(s), rows: Row[] = [];
    const g = () => new Float64Array(n);
    for (const id of this.cuts) {
      const j = this.byId.get(id)!;
      const Da = D.get(j.parent)!, Db = D.get(j.child)!;
      const { M, twists } = this.motion(j, s);
      const T = compose(Da, M);
      const own = twists.map((t, k) => { const x = adjoint(Da, t.w, t.v); return { k: j.offset + k, w: x.w, v: x.v }; });
      const yb = apply(Db, j.point), yt = apply(T, j.point);
      const ep = sub(yb, yt);
      const E = mulMM(Db.R, transpose(T.R)), er = logSO3(E), Jinv = invLeftJacobianSO3(er);
      const pos = [g(), g(), g()], rot = [g(), g(), g()];
      const phi = (k: number, w: V3) => { const x = mulMV(Jinv, w); for (let i = 0; i < 3; i++) rot[i][k] += UNIT * x[i]; };
      for (const c of anc.get(j.child)!) { const u = velocity(c, yb); for (let i = 0; i < 3; i++) pos[i][c.k] += u[i]; phi(c.k, c.w); }
      for (const c of [...anc.get(j.parent)!, ...own]) {
        const u = velocity(c, yt); for (let i = 0; i < 3; i++) pos[i][c.k] -= u[i];
        phi(c.k, scale(mulMV(E, c.w), -1));
      }
      for (let i = 0; i < 3; i++) rows.push({ id, value: ep[i], grad: pos[i] });
      for (let i = 0; i < 3; i++) rows.push({ id, value: UNIT * er[i], grad: rot[i] });
    }
    for (const e of this.equations) {
      if (e.kind === 'point') {
        const ya = apply(D.get(e.a)!, e.point), yb = apply(D.get(e.b)!, e.point), d = sub(yb, ya);
        const grads = [g(), g(), g()];
        for (const c of anc.get(e.b)!) { const u = velocity(c, yb); for (let i = 0; i < 3; i++) grads[i][c.k] += u[i]; }
        for (const c of anc.get(e.a)!) { const u = velocity(c, ya); for (let i = 0; i < 3; i++) grads[i][c.k] -= u[i]; }
        for (let i = 0; i < 3; i++) rows.push({ id: e.id, value: d[i], grad: grads[i] });
      } else if (e.kind === 'distance') {
        const ya = apply(D.get(e.a)!, e.pa), yb = apply(D.get(e.b)!, e.pb), d = sub(ya, yb), L = Math.hypot(...d);
        const u = L > 1e-12 ? scale(d, 1 / L) : [0, 0, 0] as V3, grad = g();
        for (const c of anc.get(e.a)!) grad[c.k] += dot(u, velocity(c, ya));
        for (const c of anc.get(e.b)!) grad[c.k] -= dot(u, velocity(c, yb));
        rows.push({ id: e.id, value: L - e.length, grad });
      } else {
        const Df = D.get(e.frame)!, y = apply(D.get(e.carrier)!, e.point), z = apply(invert(Df), y);
        const along = unit(e.along), grad = g(), ci = this.coordIndex(e.coord);
        // d z = R_f^T (v_carrier(y) - v_frame(y)).
        for (const c of anc.get(e.carrier)!) grad[c.k] -= dot(along, mulMtV(Df.R, velocity(c, y)));
        for (const c of anc.get(e.frame)!) grad[c.k] += dot(along, mulMtV(Df.R, velocity(c, y)));
        grad[ci] -= e.ratio;
        rows.push({ id: e.id, value: -dot(along, sub(z, e.point)) - e.ratio * s.q[ci], grad });
      }
    }
    D.delete(null);
    return { rows, deltas: D as Map<string, Frame> };
  }
}
