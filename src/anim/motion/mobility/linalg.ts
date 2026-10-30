/**
 * Small dense linear algebra for mobility analysis: a symmetric eigen solver
 * (cyclic Jacobi, exact enough for the 6x6 problems of one joint) and a
 * rank-revealing null space with a chosen column order (for loop equations,
 * where the order decides which joints become the free "drivers").
 * No dependencies; matrices are arrays of rows.
 */
export type Matrix = number[][];

/** Eigenvalues (ascending) and unit eigenvectors (as columns, matching order) of a symmetric matrix. */
export function symmetricEigen(input: readonly (readonly number[])[]): { values: number[]; vectors: Matrix } {
  const n = input.length;
  const a = input.map(r => [...r]);
  const v: Matrix = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-26) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const order = [...Array(n).keys()].sort((i, j) => a[i][i] - a[j][j]);
  return { values: order.map(i => a[i][i]), vectors: v.map(row => order.map(i => row[i])) };
}

/** Null space of the rows of `w` (vectors x with w.x = 0) with singular value <= tol. */
export function nullSpace6(rows: readonly (readonly number[])[], tol: number): number[][] {
  const n = 6, g: Matrix = Array.from({ length: n }, () => Array(n).fill(0));
  for (const r of rows) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) g[i][j] += r[i] * r[j];
  const { values, vectors } = symmetricEigen(g);
  const out: number[][] = [];
  values.forEach((lambda, k) => { if (lambda <= tol * tol) out.push(vectors.map(row => row[k])); });
  return out;
}

/**
 * Reduced row echelon form of `m` processing columns in `order`. Columns that
 * get no pivot are free; listing preferred drivers LAST makes them free when
 * the equations allow. Returns rank, pivot and free columns, and a null-space
 * basis with one vector per free column (that column = 1, other free = 0).
 */
export function orderedNullSpace(m: readonly (readonly number[])[], cols: number, order: readonly number[], tol = 1e-9) {
  const a = m.map(r => [...r]);
  const pivots: number[] = [], pivotRow = new Map<number, number>();
  let row = 0;
  for (const col of order) {
    if (row >= a.length) break;
    let best = row;
    for (let r = row + 1; r < a.length; r++) if (Math.abs(a[r][col]) > Math.abs(a[best][col])) best = r;
    if (Math.abs(a[best][col]) <= tol) continue;
    [a[row], a[best]] = [a[best], a[row]];
    const p = a[row][col];
    for (let j = 0; j < cols; j++) a[row][j] /= p;
    for (let r = 0; r < a.length; r++) if (r !== row && a[r][col] !== 0) {
      const f = a[r][col];
      for (let j = 0; j < cols; j++) a[r][j] -= f * a[row][j];
    }
    pivots.push(col); pivotRow.set(col, row); row++;
  }
  const free = [...Array(cols).keys()].filter(c => !pivotRow.has(c));
  const basis = free.map(f => {
    const x = Array(cols).fill(0);
    x[f] = 1;
    for (const [col, r] of pivotRow) x[col] = -a[r][f];
    return x;
  });
  return { rank: pivots.length, pivots, free, basis };
}
