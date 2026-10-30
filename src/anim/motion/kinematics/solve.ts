/**
 * The unified solver: drives a KinematicSystem to new driver values.
 *
 * - Corrector: Levenberg-Marquardt on the analytic Jacobian, in weighted
 *   coordinates (UNIT LDU per radian). From an accepted pose its first step
 *   is the minimum-norm Gauss-Newton step, i.e. the null-space tangent
 *   predictor, so free coordinates change as little as possible
 *   (Nocedal & Wright, "Numerical Optimization", 10.3; Nielsen 1999 damping).
 * - Continuation: the driver move is bisected whenever a substep fails, moves
 *   too far (0.5 rad / 10 LDU weighted) or loses conditioning fast, so loops
 *   stay on their branch without clamping steps (Allgower & Georg,
 *   "Introduction to Numerical Continuation Methods", ch. 2).
 * - Singularities: conditioning is the r0-th singular value of the driven
 *   Jacobian, r0 its rank at the start pose (redundant LEGO constraints are
 *   rank deficient from the start and never trip this). A pose the drivers
 *   cannot pass is reported as a dead point at the last good substep.
 * - Inequalities (stops, ratchets, backlash) use an active set: the worst
 *   violated one becomes an equality on its bound and the substep is solved
 *   again from its start.
 */
import { UNIT } from '../mobility/screw';
import { symmetricEigen } from '../mobility/linalg';
import { evaluateLaw, type Inequality, type Law } from './laws';
import type { Coord, KinematicSystem, State } from './system';

export type Drivers = ReadonlyMap<Coord, number>;
export type SolveOptions = {
  /** Largest residual (LDU) still accepted when the corrector stalls. Default 1e-6. */
  tolerance?: number;
  /** Bisection depth of the driver move. Default 6 (64 substeps). */
  maxSubdivisions?: number;
  /** Corrector iterations per substep. Default 40. */
  maxIterations?: number;
  laws?: readonly Law[];
  inequalities?: readonly Inequality[];
};
export type SolveResult = {
  status: 'converged' | 'singular' | 'failed';
  /** The solved pose, or the last good substep when not converged. */
  state: State;
  iterations: number;
  maxResidual: number;
  /** Residual norm per constraint id (cut joint, equation, law, `drive:c`). */
  residuals: Map<string, number>;
  /** Relative r0-th singular value of the driven Jacobian (1 = well conditioned). */
  conditioning: number;
  /** Coordinates the drivers and constraints leave free. */
  freeDof: number;
  /** Inequalities resting on a bound. */
  active: string[];
  reason?: string;
};

const MAX_STEP = 10; // weighted: 10 LDU or 0.5 rad per substep
/** Weight of rows with their own tolerance (authored gaps): minimised inside the exact rows, never against them. */
const SOFT = 1e-4;
const SINGULAR = 1e-4;

type Active = { ineq: Inequality; bound: number };
/** r and J are weighted; w is each row's weight, tol its allowance (unweighted). */
type Built = { ids: string[]; r: Float64Array; J: Float64Array[]; tol: Float64Array; w: Float64Array };

export function solve(sys: KinematicSystem, from: State, drivers: Drivers, opts: SolveOptions = {}): SolveResult {
  const n = sys.coords.length;
  const W = Float64Array.from(sys.angular, a => (a ? UNIT : 1));
  const tolerance = opts.tolerance ?? 1e-6, maxSub = opts.maxSubdivisions ?? 6, maxIter = opts.maxIterations ?? 40;
  const laws = (opts.laws ?? []).map(l => ({ law: l, idx: l.coords.map(c => sys.coordIndex(c)) }));
  const ineqs = (opts.inequalities ?? []).map(q => ({ q, idx: q.coords.map(c => sys.coordIndex(c)) }));
  const driven = [...drivers].map(([c, v]) => {
    const i = sys.coordIndex(c);
    if (!Number.isFinite(v)) throw Error(`Nonfinite driver ${c}`);
    sys.value(from, c); // throws for a ball joint
    return { c, i, target: v, start: from.q[i], scale: W[i] };
  });
  let iterations = 0;

  const ineqValue = (s: State, x: (typeof ineqs)[number]) => x.idx.reduce((t, i, k) => t + x.q.a[k] * s.q[i], 0);

  function build(s: State, t: number, active: readonly Active[]): Built {
    const ids: string[] = [], r: number[] = [], J: Float64Array[] = [], tol: number[] = [], w: number[] = [];
    for (const row of sys.constraints(s).rows) {
      const k = row.tolerance === undefined ? 1 : SOFT;
      ids.push(row.id); r.push(k * row.value); J.push(k === 1 ? row.grad : row.grad.map(v => v * k)); tol[r.length - 1] = row.tolerance ?? tolerance; w[r.length - 1] = k;
    }
    for (const { law, idx } of laws) {
      const { values, grad } = evaluateLaw(law, idx.map(i => s.q[i]));
      values.forEach((v, k) => { const g = new Float64Array(n); idx.forEach((i, j) => { g[i] += grad[k][j]; }); ids.push(law.id); r.push(v); J.push(g); });
    }
    for (const d of driven) {
      const g = new Float64Array(n); g[d.i] = d.scale;
      ids.push(`drive:${d.c}`); r.push(d.scale * (s.q[d.i] - (d.start + t * (d.target - d.start)))); J.push(g);
    }
    for (const a of active) {
      const x = ineqs.find(e => e.q === a.ineq)!, g = new Float64Array(n);
      x.idx.forEach((i, k) => { g[i] += a.ineq.scale * a.ineq.a[k]; });
      ids.push(a.ineq.id); r.push(a.ineq.scale * (ineqValue(s, x) - a.bound)); J.push(g);
    }
    return { ids, r: Float64Array.from(r), J, tol: Float64Array.from(r, (_, i) => tol[i] ?? tolerance), w: Float64Array.from(r, (_, i) => w[i] ?? 1) };
  }
  const weighted = (J: readonly Float64Array[]) => J.map(row => Float64Array.from(row, (v, k) => v / W[k]));
  const normal = (Jz: readonly Float64Array[]) => {
    const A = Array.from({ length: n }, () => new Float64Array(n));
    for (const row of Jz) for (let i = 0; i < n; i++) { const ri = row[i]; if (ri === 0) continue; for (let j = 0; j < n; j++) A[i][j] += ri * row[j]; }
    return A;
  };
  /** Each constraint's residual norm (all its rows) within its own allowance. */
  const withinTolerance = (b: Built) => {
    const norms = new Map<string, { v: number; tol: number }>();
    b.ids.forEach((id, i) => { const e = norms.get(id) ?? { v: 0, tol: b.tol[i] }; e.v = Math.hypot(e.v, b.r[i] / b.w[i]); norms.set(id, e); });
    return [...norms.values()].every(e => e.v <= e.tol);
  };
  const maxAbs = (r: Float64Array) => r.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const sq = (r: Float64Array) => r.reduce((m, v) => m + v * v, 0);

  /** Singular values (descending) of the weighted Jacobian. */
  function singular(b: Built): number[] {
    if (!n) return [];
    // Unweighted rows: a soft row is still a constraint for rank and conditioning.
    const rows = b.J.map((row, i) => (b.w[i] === 1 ? row : row.map(v => v / b.w[i])));
    return symmetricEigen(normal(weighted(rows)).map(r => [...r])).values.map(v => Math.sqrt(Math.max(0, v))).reverse();
  }
  const rankOf = (sv: number[]) => sv.filter(v => v > 1e-7 * Math.max(sv[0] ?? 0, 1e-12)).length;
  const r0 = rankOf(singular(build(from, 0, [])));
  const conditioning = (b: Built) => {
    const sv = singular(b);
    if (!r0 || !sv.length || !(sv[0] > 0)) return 1;
    return (sv[r0 - 1] ?? 0) / sv[0];
  };

  /** Levenberg-Marquardt from `start` to the substep target. */
  function correct(start: State, t: number, active: readonly Active[]) {
    let s = start, b = build(s, t, active), cost = sq(b.r), mu = -1;
    for (let it = 0; it < maxIter; it++) {
      if (maxAbs(b.r) < 1e-10 * SOFT) return { ok: true, s, b };
      iterations++;
      const Jz = weighted(b.J), A = normal(Jz), g = new Float64Array(n);
      Jz.forEach((row, i) => { for (let k = 0; k < n; k++) g[k] += row[k] * b.r[i]; });
      if (mu < 0) mu = 1e-12 * Math.max(1e-12, ...A.map((row, i) => row[i]));
      let accepted = false;
      for (let tries = 0; tries < 12 && !accepted; tries++) {
        const z = cholesky(A, g, mu);
        if (z) {
          const next = sys.step(s, Float64Array.from(z, (v, k) => v / W[k])), nb = build(next, t, active), nc = sq(nb.r);
          if (Number.isFinite(nc) && nc < cost) { s = next; b = nb; cost = nc; mu = Math.max(mu / 3, 1e-15); accepted = true; break; }
        }
        mu = Math.max(mu * 4, 1e-12);
      }
      if (!accepted) break;
    }
    return { ok: withinTolerance(b), s, b };
  }

  /** One substep with the active set. */
  function substep(start: State, t: number) {
    const active: Active[] = [];
    for (let round = 0; round <= ineqs.length; round++) {
      const c = correct(start, t, active);
      if (!c.ok) return { ok: false as const, s: c.s, b: c.b, active, stop: active.length > 0 };
      let worst: { x: (typeof ineqs)[number]; bound: number; by: number } | null = null;
      for (const x of ineqs) {
        if (active.some(a => a.ineq === x.q)) continue;
        const v = ineqValue(c.s, x), bound = v < x.q.lo ? x.q.lo : v > x.q.hi ? x.q.hi : v, by = Math.abs(v - bound) * x.q.scale;
        if (by > 1e-9 && (!worst || by > worst.by)) worst = { x, bound, by };
      }
      if (!worst) return { ok: true as const, s: c.s, b: c.b, active, stop: false };
      active.push({ ineq: worst.x.q, bound: worst.bound });
    }
    return { ok: false as const, s: start, b: build(start, t, active), active, stop: true };
  }

  const change = (a: State, b: State) => {
    let m = 0;
    for (let k = 0; k < n; k++) m = Math.max(m, Math.abs(b.q[k] - a.q[k]) * W[k]);
    for (const [id, R] of b.rot) {
      const P = a.rot.get(id)!, tr = R[0] * P[0] + R[1] * P[1] + R[2] * P[2] + R[3] * P[3] + R[4] * P[4] + R[5] * P[5] + R[6] * P[6] + R[7] * P[7] + R[8] * P[8];
      m = Math.max(m, UNIT * Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))));
    }
    return m;
  };

  type Leg = { ok: boolean; s: State; b: Built; active: Active[]; cond: number; failure?: { stop: boolean; cond: number } };
  const startBuilt = build(from, 0, []);
  const cond0 = conditioning(startBuilt);
  function advance(s: State, cond: number, ta: number, tb: number, depth: number, last: Leg): Leg {
    const res = substep(s, tb);
    let bad = !res.ok;
    let c = cond;
    if (res.ok) {
      c = conditioning(res.b);
      if (change(s, res.s) > MAX_STEP || c < SINGULAR || (c < cond / 10 && depth < maxSub)) bad = true;
    }
    if (!bad) return { ok: true, s: res.s, b: res.b, active: res.active, cond: c };
    if (depth >= maxSub) return { ...last, ok: false, failure: { stop: res.stop, cond: res.ok ? c : 0 } };
    const mid = (ta + tb) / 2;
    const left = advance(s, cond, ta, mid, depth + 1, last);
    if (!left.ok) return left;
    return advance(left.s, left.cond, mid, tb, depth + 1, left);
  }
  const first: Leg = { ok: true, s: from, b: startBuilt, active: [], cond: cond0 };
  const leg = advance(from, cond0, 0, 1, 0, first);

  const final = leg.ok ? leg.b : build(leg.s, 0, []);
  const residuals = new Map<string, number>();
  final.ids.forEach((id, i) => residuals.set(id, Math.hypot(residuals.get(id) ?? 0, final.r[i] / final.w[i])));
  const geometry = [...residuals].filter(([id]) => !id.startsWith('drive:'));
  const sv = singular(final);
  const result: SolveResult = {
    status: 'converged', state: leg.s, iterations, maxResidual: Math.max(0, ...geometry.map(([, v]) => v)), residuals,
    conditioning: leg.cond, freeDof: n - rankOf(sv), active: leg.active.map(a => a.ineq.id),
  };
  if (leg.ok) return result;
  const f = leg.failure!;
  if (f.stop) return { ...result, status: 'failed', reason: 'The motion exceeds a physical joint stop' };
  if (f.cond < SINGULAR || leg.cond < cond0 / 2)
    return { ...result, status: 'singular', reason: 'The drivers reached a dead point (singular pose): the mechanism cannot be driven further this way' };
  return { ...result, status: 'failed', reason: 'The constraints cannot close at the requested driver values' };
}

/** Solve (A + mu I) z = -g by Cholesky; null if not positive definite. */
function cholesky(A: readonly Float64Array[], g: Float64Array, mu: number): Float64Array | null {
  const n = g.length, L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j] + (i === j ? mu : 0);
    for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
    if (i === j) { if (!(s > 0)) return null; L[i][i] = Math.sqrt(s); } else L[i][j] = s / L[j][j];
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = -g[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  const z = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * z[k]; z[i] = s / L[i][i]; }
  return z.every(Number.isFinite) ? z : null;
}
