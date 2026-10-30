/**
 * Local dimension test: how many independent ways a mechanism can really move
 * at its assembled pose, not just to first order.
 *
 * Wampler, Hauenstein & Sommese, "Mechanism Mobility and a Local Dimension
 * Test", Mechanism and Machine Theory 46 (2011):
 *  - The Macaulay matrix at z of depth d has entries D^a((x-z)^b f_j)(z) for
 *    columns |a| <= d and rows (j, |b| <= d-1). Its column corank c_d counts
 *    the local "dual space" up to order d. If c_d = c_(d+1) the point is
 *    isolated and c_d is its multiplicity (their Prop. 5.1, Thm. 5.2).
 *  - Cutting with k random hyperplanes through z lowers the local dimension
 *    by k (down to 0), so the local dimension is the smallest k for which the
 *    sliced system's corank sequence stabilises (their LocalDimFinder, sec. 8).
 *  - With a depth bound the answer is an upper bound ("d-bounded local
 *    dimension") that only tightens with more depth; a non-stabilised
 *    sequence is reported as such rather than guessed.
 *
 * Here the system is a set of truncated power series around z = 0, so the
 * Macaulay entry for column a and row (j, b) is the coefficient of x^(a-b) in
 * f_j (columns scaled by 1/a!, which does not change rank).
 */
import { Series, SeriesSpace } from './series';

export type DimensionResult = {
  /** The (depth-bounded) local dimension, or null when no k in range stabilised. */
  dimension: number | null;
  /** Multiplicity of the sliced isolated point at that dimension. */
  multiplicity: number | null;
  /** Corank sequences c_(k,d) for every k tried. */
  sequences: { k: number; coranks: number[]; stabilised: boolean }[];
};

/** Deterministic PRNG so recognitions are reproducible. */
export function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Column corank of the depth-d Macaulay matrix of `system` at 0. */
export function macaulayCorank(system: readonly Series[], d: number, tol = 1e-8): number {
  if (!system.length) throw Error('empty system');
  const space = system[0].space;
  if (d > space.order) throw Error(`depth ${d} exceeds series order ${space.order}`);
  let cols = 0;
  while (cols < space.size && space.degree[cols] <= d) cols++;
  if (d === 0) return cols;
  const shifts: number[] = [];
  for (let i = 0; i < space.size && space.degree[i] <= d - 1; i++) shifts.push(i);
  const rows: Float64Array[] = [];
  for (const f of system) for (const b of shifts) {
    const beta = space.monomials[b], row = new Float64Array(cols);
    let any = false;
    for (let a = 0; a < cols; a++) {
      const alpha = space.monomials[a];
      if (alpha.some((e, k) => e < beta[k])) continue;
      const g = space.indexOf(alpha.map((e, k) => e - beta[k]))!;
      const x = f.c[g];
      if (x !== 0) { row[a] = x; any = true; }
    }
    if (any) rows.push(row);
  }
  return cols - numericalRank(rows, cols, tol);
}

/**
 * Rank by Householder QR with column pivoting (rank-revealing): a pivot
 * below tol * max(largest pivot, 1) ends the count (the floor keeps
 * round-off residue in an otherwise empty matrix from counting as rank).
 */
export function numericalRank(rows: readonly Float64Array[], cols: number, tol: number): number {
  const m = rows.length;
  if (!m) return 0;
  // Column-major copy.
  const a = Array.from({ length: cols }, (_, j) => Float64Array.from(rows, r => r[j]));
  const norms = a.map(col => col.reduce((s, x) => s + x * x, 0));
  let first = 0, rank = 0;
  for (let k = 0; k < Math.min(m, cols); k++) {
    let p = k;
    for (let j = k + 1; j < cols; j++) if (norms[j] > norms[p]) p = j;
    [a[k], a[p]] = [a[p], a[k]]; [norms[k], norms[p]] = [norms[p], norms[k]];
    const col = a[k];
    let s = 0;
    for (let i = k; i < m; i++) s += col[i] * col[i];
    const alpha = Math.sqrt(s);
    if (k === 0) first = alpha;
    if (alpha <= tol * Math.max(first, 1)) break;
    rank++;
    const v0 = col[k] + (col[k] >= 0 ? alpha : -alpha);
    const v = new Float64Array(m - k);
    v[0] = v0;
    for (let i = k + 1; i < m; i++) v[i - k] = col[i];
    const vv = v.reduce((t, x) => t + x * x, 0);
    for (let j = k; j < cols; j++) {
      const c = a[j];
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i - k] * c[i];
      const f = 2 * dot / vv;
      for (let i = k; i < m; i++) c[i] -= f * v[i - k];
    }
    for (let j = k + 1; j < cols; j++) norms[j] -= a[j][k] * a[j][k];
    // Recompute drifting norms exactly (cheap at these sizes).
    for (let j = k + 1; j < cols; j++) { let t = 0; for (let i = k + 1; i < m; i++) t += a[j][i] * a[j][i]; norms[j] = t; }
  }
  return rank;
}

/** Random linear forms through 0 (hyperplane slices). */
export function slices(space: SeriesSpace, k: number, seed: number): Series[] {
  const rnd = random(seed);
  return Array.from({ length: k }, () => space.linear(Array.from({ length: space.vars }, () => rnd() * 2 - 1)));
}

/** Does the corank sequence of `system` stabilise within `depth`? */
export function corankSequence(system: readonly Series[], depth: number, tol?: number) {
  const coranks = [1];
  for (let d = 1; d <= depth; d++) {
    const c = macaulayCorank(system, d, tol);
    coranks.push(c);
    if (c === coranks[d - 1]) return { coranks, stabilised: true };
  }
  return { coranks, stabilised: false };
}

/**
 * LocalDimFinder (Wampler et al., sec. 8) over dimensions [lo, hi] with
 * depth bound `depth` (<= the series order).
 */
export function localDimension(system: readonly Series[], lo: number, hi: number, depth: number, seed = 1, tol?: number): DimensionResult {
  const space = system[0]?.space;
  if (!space) throw Error('empty system');
  const sequences: DimensionResult['sequences'] = [];
  for (let k = lo; k <= hi; k++) {
    const sliced = [...system, ...slices(space, k, seed + k)];
    const { coranks, stabilised } = corankSequence(sliced, depth, tol);
    sequences.push({ k, coranks, stabilised });
    if (stabilised) return { dimension: k, multiplicity: coranks[coranks.length - 1], sequences };
  }
  return { dimension: null, multiplicity: null, sequences };
}
