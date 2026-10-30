/**
 * Mobility of an assembly of rigid bodies joined by screw joints.
 *
 * 1. Loops. The body graph splits into blocks (biconnected components).
 *    A joint outside every loop moves freely with its own DOF. Inside a block
 *    a spanning tree gives every body a pose as a product of exponentials of
 *    the joint twists (spatial POE, Murray, Li & Sastry ch. 3); each joint not
 *    in the tree closes one loop: pose(a) * joint(e) = pose(b), 12 equations.
 * 2. First order. The Jacobian of the closures at the assembly pose has
 *    corank c: an upper bound on mobility (it also counts infinitesimal,
 *    "shaky" freedoms).
 * 3. Exact. Lyapunov-Schmidt reduction: solve the independent closure rows
 *    for the pivot joint coordinates as power series of the c free ones
 *    (implicit function theorem, exact to the series order), substitute into
 *    the remaining rows, and run the local dimension test of Wampler,
 *    Hauenstein & Sommese (2011) on that small system. The reduction keeps
 *    the solution germ (an analytic change of coordinates), so the result is
 *    the mechanism's local dimension at the assembly pose.
 * 4. Drivers. A set of k joint coordinates drives the block when fixing them
 *    leaves the pose isolated (the same Macaulay test with coordinate slices).
 * 5. Real motion. The test works over complex numbers; at a regular point
 *    real and complex dimension agree, at a singular one we also step the
 *    drivers a little each way and re-close the loops numerically.
 */
import { orderedNullSpace } from './linalg';
import { corankSequence, localDimension } from './localDimension';
import { Series, SeriesSpace } from './series';
import { UNIT, type ScrewJoint, type V3 } from './screw';

/** Twist in mobility units: w unitless, v in studs per unit coordinate. */
type Tw = { w: V3; v: V3 };
export type BodyJoint = { a: number; b: number; joint: ScrewJoint };
export type MobilityOptions = {
  /** Higher = better driver. Called per joint coordinate. */
  driverPriority?: (joint: number, coordinate: number) => number;
  /** Depth bound for the local dimension test (and series order). */
  depth?: number;
  /** Largest first-order freedom per block that gets the exact test. */
  maxExact?: number;
  /** Rank tolerance for the closure Jacobian (stud units). */
  tolerance?: number;
  seed?: number;
};
export type BlockMobility = {
  joints: number[];
  bodies: number[];
  loops: number;
  coordinates: number;
  /** First-order bound (corank of the closure Jacobian). */
  firstOrder: number;
  /** Local dimension: real finite DOF of the block (null when not established). */
  dimension: number | null;
  multiplicity: number | null;
  /** True when the exact test ran and stabilised; false = only the first-order bound. */
  exact: boolean;
  /** Freedoms that exist only to first order (loose / shaky). */
  infinitesimal: number;
  drivers: { joint: number; coordinate: number }[];
  /** Joint coordinates that cannot move even to first order. */
  locked: { joint: number; coordinate: number }[];
  /** Real stepping along each driver re-closed the loops. */
  realMotion: boolean | null;
  sequences?: { k: number; coranks: number[]; stabilised: boolean }[];
};
export type Mobility = {
  /** Total finite DOF (free joints + block dimensions); upper bound where a block is not exact. */
  mobility: number;
  exact: boolean;
  freeJoints: number[];
  blocks: BlockMobility[];
};

const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const sc = (a: readonly number[], s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

/** A coordinate basis of the joint's motion, idealised from its classified kind. */
export function jointTwists(j: ScrewJoint): Tw[] {
  const p = j.point ? sc(j.point, 1 / UNIT) : ([0, 0, 0] as V3);
  const rot = (w: V3): Tw => ({ w, v: cross(p, w) });
  const raw = () => j.twists.map(t => ({ w: t.w, v: sc(t.v, 1 / UNIT) }));
  switch (j.kind) {
    case 'fixed': return [];
    case 'revolute': return [rot(j.axis!)];
    case 'prismatic': return [{ w: [0, 0, 0], v: j.axis! }];
    case 'cylindrical': return [rot(j.axis!), { w: [0, 0, 0], v: j.axis! }];
    case 'spherical': return [rot([1, 0, 0]), rot([0, 1, 0]), rot([0, 0, 1])];
    case 'planar': {
      const n = j.axis!, seed: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const a = sc(cross(n, seed), 1 / norm(cross(n, seed))), b = cross(n, a);
      return [{ w: n, v: [0, 0, 0] }, { w: [0, 0, 0], v: a }, { w: [0, 0, 0], v: b }];
    }
    default: return raw().map(t => { const s = norm(t.w) || norm(t.v) || 1; return { w: sc(t.w, 1 / s), v: sc(t.v, 1 / s) }; });
  }
}

// ---- Rigid transforms over a ring (numbers or power series) ----

interface Ring<T> { c(x: number): T; add(a: T, b: T): T; mul(a: T, b: T): T; scale(a: T, s: number): T; }
/** Rotation (row-major 3x3) and translation (studs). */
type Pose<T> = { r: T[]; p: T[] };

/** I + K1 q + K2 f2(q) + K3 f3(q), where Kn = (twist hat)^n; exact because hat^4 = -|w|^2 hat^2. */
type Exp<T> = (t: Tw, q: T) => Pose<T>;
function hatPowers(t: Tw) {
  // 4x4 hat as 3x4 [W v]; powers keep the bottom row zero.
  const W = [0, -t.w[2], t.w[1], t.w[2], 0, -t.w[0], -t.w[1], t.w[0], 0];
  const mul = (a: number[], b: number[]) => { // (3x4) * (3x4 with implicit zero bottom row)
    const o = Array(12).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 3; k++) o[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
    return o;
  };
  const K1 = [W[0], W[1], W[2], t.v[0], W[3], W[4], W[5], t.v[1], W[6], W[7], W[8], t.v[2]];
  const K2 = mul(K1, K1), K3 = mul(K2, K1);
  return [K1, K2, K3];
}
function expWith<T>(ring: Ring<T>, f2: (t: Tw, q: T) => T, f3: (t: Tw, q: T) => T): Exp<T> {
  return (t, q) => {
    const [K1, K2, K3] = hatPowers(t), a = f2(t, q), b = f3(t, q);
    const entry = (n: number, identity: number) => ring.add(ring.add(ring.c(identity), ring.scale(q, K1[n])), ring.add(ring.scale(a, K2[n]), ring.scale(b, K3[n])));
    const r: T[] = [], p: T[] = [];
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) r.push(entry(i * 4 + j, i === j ? 1 : 0)); p.push(entry(i * 4 + 3, 0)); }
    return { r, p };
  };
}
function compose<T>(ring: Ring<T>, A: Pose<T>, B: Pose<T>): Pose<T> {
  const r: T[] = [], p: T[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r.push(ring.add(ring.add(ring.mul(A.r[i * 3], B.r[j]), ring.mul(A.r[i * 3 + 1], B.r[3 + j])), ring.mul(A.r[i * 3 + 2], B.r[6 + j])));
    p.push(ring.add(ring.add(ring.add(ring.mul(A.r[i * 3], B.p[0]), ring.mul(A.r[i * 3 + 1], B.p[1])), ring.mul(A.r[i * 3 + 2], B.p[2])), A.p[i]));
  }
  return { r, p };
}
function inverse<T>(ring: Ring<T>, A: Pose<T>): Pose<T> {
  const r = [0, 3, 6, 1, 4, 7, 2, 5, 8].map(k => A.r[k]);
  const p = [0, 1, 2].map(i => ring.scale(ring.add(ring.add(ring.mul(r[i * 3], A.p[0]), ring.mul(r[i * 3 + 1], A.p[1])), ring.mul(r[i * 3 + 2], A.p[2])), -1));
  return { r, p };
}

const numberRing: Ring<number> = { c: x => x, add: (a, b) => a + b, mul: (a, b) => a * b, scale: (a, s) => a * s };
const numberExp = expWith<number>(numberRing,
  (t, q) => { const w = norm(t.w); return w < 1e-12 ? q * q / 2 : (1 - Math.cos(w * q)) / (w * w); },
  (t, q) => { const w = norm(t.w); return w < 1e-12 ? q ** 3 / 6 : (w * q - Math.sin(w * q)) / w ** 3; });
function seriesRing(space: SeriesSpace): Ring<Series> {
  return { c: x => space.constant(x), add: (a, b) => a.plus(b), mul: (a, b) => a.mul(b), scale: (a, s) => a.times(s) };
}
function seriesExp(space: SeriesSpace): Exp<Series> {
  const coeffs = (w2: number, start: number) => {
    const c = Array(space.order + 1).fill(0);
    let f = 1;
    for (let n = 1; n <= space.order; n++) {
      f *= n;
      if (n >= start && (n - start) % 2 === 0) c[n] = ((n - start) / 2 % 2 === 0 ? 1 : -1) * w2 ** ((n - start) / 2) / f;
    }
    return c;
  };
  const w2 = (t: Tw) => t.w[0] ** 2 + t.w[1] ** 2 + t.w[2] ** 2;
  return expWith(seriesRing(space), (t, q) => space.power(q, coeffs(w2(t), 2)), (t, q) => space.power(q, coeffs(w2(t), 3)));
}

// ---- Loop structure ----

type Block = { joints: number[]; bodies: number[] };

/** Edge-biconnected blocks (Tarjan on joints); bridges are loop-free joints. */
function blocks(bodyCount: number, joints: readonly { a: number; b: number }[]) {
  const adj: { to: number; e: number }[][] = Array.from({ length: bodyCount }, () => []);
  joints.forEach((j, e) => { adj[j.a].push({ to: j.b, e }); adj[j.b].push({ to: j.a, e }); });
  const disc = Array(bodyCount).fill(-1), low = Array(bodyCount).fill(0);
  const stack: number[] = [], out: Block[] = [], bridges: number[] = [];
  let time = 0;
  // Iterative DFS over vertex-biconnected components (edge stack).
  for (let s = 0; s < bodyCount; s++) {
    if (disc[s] >= 0) continue;
    disc[s] = low[s] = time++;
    const frames: { v: number; parentEdge: number; i: number }[] = [{ v: s, parentEdge: -1, i: 0 }];
    while (frames.length) {
      const f = frames[frames.length - 1];
      if (f.i < adj[f.v].length) {
        const { to, e } = adj[f.v][f.i++];
        if (e === f.parentEdge) continue;
        if (disc[to] < 0) {
          stack.push(e);
          disc[to] = low[to] = time++;
          frames.push({ v: to, parentEdge: e, i: 0 });
        } else if (disc[to] < disc[f.v]) {
          stack.push(e);
          low[f.v] = Math.min(low[f.v], disc[to]);
        }
      } else {
        frames.pop();
        const parent = frames[frames.length - 1];
        if (!parent) continue;
        low[parent.v] = Math.min(low[parent.v], low[f.v]);
        if (low[f.v] >= disc[parent.v]) {
          const comp: number[] = [];
          for (;;) { const e = stack.pop()!; comp.push(e); if (e === f.parentEdge) break; }
          if (comp.length === 1) bridges.push(comp[0]);
          else out.push({ joints: comp.sort((x, y) => x - y), bodies: [...new Set(comp.flatMap(e => [joints[e].a, joints[e].b]))].sort((x, y) => x - y) });
        }
      }
    }
  }
  return { blocks: out, bridges: bridges.sort((x, y) => x - y) };
}

/** One block's closure equations, generic over the ring. */
function closure(block: Block, joints: readonly BodyJoint[], twists: Tw[][]) {
  const root = block.bodies[0];
  const inBlock = new Set(block.joints), adj = new Map<number, { to: number; e: number }[]>();
  for (const e of block.joints) {
    const { a, b } = joints[e];
    (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, e });
    (adj.get(b) ?? adj.set(b, []).get(b)!).push({ to: a, e });
  }
  const order: { body: number; via: number; forward: boolean }[] = [{ body: root, via: -1, forward: true }];
  const seen = new Set([root]), tree = new Set<number>();
  for (let i = 0; i < order.length; i++) for (const { to, e } of adj.get(order[i].body) ?? []) {
    if (seen.has(to) || !inBlock.has(e)) continue;
    seen.add(to); tree.add(e);
    order.push({ body: to, via: e, forward: joints[e].b === to });
  }
  const cuts = block.joints.filter(e => !tree.has(e));
  // Variables: every coordinate of every block joint.
  const variable = new Map<number, number>(), vars: { joint: number; coordinate: number }[] = [];
  for (const e of block.joints) { variable.set(e, vars.length); twists[e].forEach((_, k) => vars.push({ joint: e, coordinate: k })); }
  function evaluate<T>(ring: Ring<T>, exp: Exp<T>, q: readonly T[]): T[] {
    const jointPose = (e: number) => twists[e].reduce<Pose<T> | null>((acc, t, k) => {
      const x = exp(t, q[variable.get(e)! + k]);
      return acc ? compose(ring, acc, x) : x;
    }, null)!;
    const identity: Pose<T> = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1].map(x => ring.c(x)), p: [0, 0, 0].map(x => ring.c(x)) };
    const pose = new Map<number, Pose<T>>([[root, identity]]);
    for (const { body, via, forward } of order.slice(1)) {
      const parent = forward ? joints[via].a : joints[via].b, J = jointPose(via);
      pose.set(body, compose(ring, pose.get(parent)!, forward ? J : inverse(ring, J)));
    }
    const out: T[] = [];
    for (const e of cuts) {
      const lhs = compose(ring, pose.get(joints[e].a)!, jointPose(e)), rhs = pose.get(joints[e].b)!;
      for (let k = 0; k < 9; k++) out.push(ring.add(lhs.r[k], ring.scale(rhs.r[k], -1)));
      for (let k = 0; k < 3; k++) out.push(ring.add(lhs.p[k], ring.scale(rhs.p[k], -1)));
    }
    return out;
  }
  /** d(closures)/dq at the assembly pose: every pose is the identity there,
   * so each loop row block is the signed sum of hat(twist) around the loop. */
  function jacobian(): number[][] {
    const via = new Map(order.slice(1).map(o => [o.body, o]));
    const path = (body: number) => {
      const steps: { e: number; sign: number }[] = [];
      for (let b = body; b !== root;) { const o = via.get(b)!; steps.push({ e: o.via, sign: o.forward ? 1 : -1 }); b = o.forward ? joints[o.via].a : joints[o.via].b; }
      return steps;
    };
    const rows: number[][] = [];
    for (const e of cuts) {
      const block = Array.from({ length: 12 }, () => Array(vars.length).fill(0));
      const add = (j: number, sign: number) => twists[j].forEach((t, k) => {
        const col = variable.get(j)! + k, h = hatPowers(t)[0];
        for (let i = 0; i < 3; i++) { for (let m = 0; m < 3; m++) block[i * 3 + m][col] += sign * h[i * 4 + m]; block[9 + i][col] += sign * h[i * 4 + 3]; }
      });
      for (const s of path(joints[e].a)) add(s.e, s.sign);
      add(e, 1);
      for (const s of path(joints[e].b)) add(s.e, -s.sign);
      rows.push(...block);
    }
    return rows;
  }
  return { vars, cuts, evaluate, jacobian };
}

/** Solve a small dense square system (Gaussian elimination, partial pivoting); returns the inverse. */
function invert(m: number[][]): number[][] {
  const n = m.length, a = m.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) if (r !== c && a[r][c]) { const f = a[r][c]; for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j]; }
  }
  return a.map(r => r.slice(n));
}

function combinations<T>(items: readonly T[], k: number, limit: number): T[][] {
  const out: T[][] = [];
  const go = (start: number, pick: T[]) => {
    if (out.length >= limit) return;
    if (pick.length === k) { out.push(pick); return; }
    for (let i = start; i < items.length; i++) go(i + 1, [...pick, items[i]]);
  };
  go(0, []);
  return out;
}

function analyseBlock(block: Block, joints: readonly BodyJoint[], twists: Tw[][], o: Required<Omit<MobilityOptions, 'driverPriority'>> & Pick<MobilityOptions, 'driverPriority'>): BlockMobility {
  const { vars, cuts, evaluate, jacobian } = closure(block, joints, twists);
  const N = vars.length;
  const base: BlockMobility = { joints: block.joints, bodies: block.bodies, loops: cuts.length, coordinates: N, firstOrder: 0, dimension: null, multiplicity: null, exact: false, infinitesimal: 0, drivers: [], locked: [], realMotion: null };
  if (!N) return { ...base, dimension: 0, multiplicity: 1, exact: true, realMotion: false };
  const J = jacobian();
  const rowsR = orderedNullSpace(vars.map((_, k) => J.map(r => r[k])), J.length, J.map((_, i) => i), o.tolerance).pivots.sort((x, y) => x - y);
  const priority = (k: number) => o.driverPriority?.(vars[k].joint, vars[k].coordinate) ?? 0;
  // Preferred drivers last so they stay free; stable by index otherwise.
  const colOrder = vars.map((_, k) => k).sort((x, y) => priority(x) - priority(y) || y - x);
  const JR = rowsR.map(i => J[i]);
  const ns = orderedNullSpace(JR, N, colOrder, o.tolerance);
  const free = [...ns.free].sort((x, y) => priority(y) - priority(x) || x - y), pivots = ns.pivots;
  const c = free.length;
  const basis = free.map(f => ns.basis[ns.free.indexOf(f)]);
  const locked = vars.map((v, k) => ({ ...v, k })).filter(({ k }) => basis.every(b => Math.abs(b[k]) < 1e-9)).map(({ joint, coordinate }) => ({ joint, coordinate }));
  const result: BlockMobility = { ...base, firstOrder: c, locked };
  if (c === 0) return { ...result, dimension: 0, multiplicity: 1, exact: true, realMotion: false };
  if (c > o.maxExact) return { ...result, dimension: c };

  // Lyapunov-Schmidt: pivots as series in the free coordinates.
  const D = o.depth, space = new SeriesSpace(c, D), ring = seriesRing(space), exp = seriesExp(space);
  const q: Series[] = vars.map(() => space.zero());
  free.forEach((f, i) => { q[f] = space.variable(i); });
  for (const p of pivots) q[p] = space.linear(basis.map(b => b[p]));
  const inv = invert(rowsR.map(i => pivots.map(p => J[i][p])));
  for (let it = 0; it < D; it++) {
    const F = evaluate(ring, exp, q), r = rowsR.map(i => F[i]);
    pivots.forEach((p, a) => { let d = space.zero(); r.forEach((x, b) => { if (inv[a][b]) d = d.plus(x.times(inv[a][b])); }); q[p] = q[p].minus(d); });
  }
  const F = evaluate(ring, exp, q), Rset = new Set(rowsR);
  // The solved rows must vanish to the series order; otherwise only the bound stands.
  if (rowsR.some(i => F[i].size() > 1e-6)) return { ...result, dimension: c };
  // Still to first order is not locked: a coordinate with higher-order terms
  // moves along the motion (a shock cylinder's pivot when the rocker arm is
  // square to the shock turns with the square of the rocker's angle).
  result.locked = vars.map((v, k) => ({ ...v, k }))
    .filter(({ joint, coordinate, k }) => locked.some(l => l.joint === joint && l.coordinate === coordinate) && q[k].size(2) < 1e-9)
    .map(({ joint, coordinate }) => ({ joint, coordinate }));
  const g = F.filter((_, i) => !Rset.has(i)).filter(s => s.size(1) > 1e-10);
  const system = g.length ? g : [space.zero()];
  const dim = localDimension(system, 0, c, D, o.seed);
  if (dim.dimension === null) return { ...result, dimension: c, sequences: dim.sequences };
  const k = dim.dimension;
  // Drivers: k free coordinates whose fixing isolates the pose.
  let drivers: number[] = [];
  if (k > 0) {
    for (const pick of combinations(free.map((_, i) => i), k, 64)) {
      const sliced = [...system, ...pick.map(i => space.variable(i))];
      if (corankSequence(sliced, D).stabilised) { drivers = pick.map(i => free[i]); break; }
    }
  }
  const realMotion = k > 0 && drivers.length ? stepsReally(evaluate, N, drivers) : k > 0 ? null : false;
  return { ...result, dimension: k, multiplicity: dim.multiplicity, exact: true, infinitesimal: c - k, drivers: drivers.map(d => vars[d]), sequences: dim.sequences, realMotion };
}

/** Step each driver by +-h and re-close the loops with Gauss-Newton on the other coordinates. */
function stepsReally(evaluate: <T>(ring: Ring<T>, exp: Exp<T>, q: readonly T[]) => T[], N: number, drivers: number[], h = 0.02): boolean {
  const F = (q: number[]) => evaluate(numberRing, numberExp, q);
  const others = [...Array(N).keys()].filter(k => !drivers.includes(k));
  for (const d of drivers) for (const s of [h, -h]) {
    const q = Array(N).fill(0); q[d] = s;
    let ok = false;
    for (let it = 0; it < 30; it++) {
      const f = F(q), err = Math.hypot(...f);
      if (err < 1e-10) { ok = true; break; }
      // Finite-difference Jacobian over the other coordinates, then a least-squares step.
      const cols = others.map(k => { const qq = [...q]; qq[k] += 1e-7; return F(qq).map((x, i) => (x - f[i]) / 1e-7); });
      if (!others.length) break;
      const A = cols.map((ci, a) => cols.map((cj, b) => ci.reduce((t, x, i) => t + x * cj[i], 0) + (a === b ? 1e-12 : 0)));
      const b = cols.map(ci => -ci.reduce((t, x, i) => t + x * f[i], 0)), inv = invert(A);
      const dx = inv.map(row => row.reduce((t, x, j) => t + x * b[j], 0));
      if (dx.some(x => !Number.isFinite(x))) break;
      others.forEach((k, i) => { q[k] += dx[i]; });
    }
    if (!ok) return false;
  }
  return true;
}

/** Mobility of the whole assembly at its assembled pose. */
export function mobility(bodyCount: number, joints: readonly BodyJoint[], options: MobilityOptions = {}): Mobility {
  const o = { depth: 5, maxExact: 4, tolerance: 1e-6, seed: 1, ...options };
  const twists = joints.map(j => jointTwists(j.joint));
  const { blocks: bs, bridges } = blocks(bodyCount, joints);
  const results = bs.map(b => analyseBlock(b, joints, twists, o));
  return {
    mobility: bridges.reduce((s, e) => s + twists[e].length, 0) + results.reduce((s, b) => s + (b.dimension ?? b.firstOrder), 0),
    exact: results.every(b => b.exact),
    freeJoints: bridges.filter(e => twists[e].length > 0),
    blocks: results,
  };
}
