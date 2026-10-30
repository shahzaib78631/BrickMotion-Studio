/**
 * Symmetry tests on a part's vertices, the basis of measuring toothed parts
 * from their LDraw geometry: n teeth = the largest n whose rotation by 2π/n
 * maps the tooth band onto itself.
 */
export type P3 = [number, number, number];

/** A hash grid over points for "is there a point near here" queries. */
export class PointGrid {
  private readonly cells = new Map<string, P3[]>();
  constructor(points: readonly P3[], private readonly tol: number) {
    for (const p of points) {
      const k = this.key(p[0], p[1], p[2]);
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(p);
    }
  }
  private key(x: number, y: number, z: number) { const t = this.tol; return `${Math.floor(x / t)},${Math.floor(y / t)},${Math.floor(z / t)}`; }
  has(x: number, y: number, z: number): boolean {
    const t = this.tol, cx = Math.floor(x / t), cy = Math.floor(y / t), cz = Math.floor(z / t);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      for (const p of this.cells.get(`${cx + i},${cy + j},${cz + k}`) ?? [])
        if (Math.abs(p[0] - x) <= t && Math.abs(p[1] - y) <= t && Math.abs(p[2] - z) <= t) return true;
    }
    return false;
  }
}

/** Share of points that `map` sends onto another point of the set, stopping early once `need` is out of reach. */
export function mappedShare(points: readonly P3[], grid: PointGrid, map: (p: P3) => P3, need = 0) {
  const allowed = Math.floor(points.length * (1 - need));
  let bad = 0;
  for (const p of points) {
    const q = map(p);
    if (!grid.has(q[0], q[1], q[2]) && ++bad > allowed) return 1 - bad / points.length;
  }
  return 1 - bad / points.length;
}

/**
 * Largest order n ≤ maxN (z is the axis) whose rotation by 2π/n maps at least
 * `need` of the points onto the set; 0 when none from 2 up does. The tolerance
 * is tight (0.05 LDU): looser, a 48-sided circle passes as 53-fold.
 */
export function rotationalOrder(points: readonly P3[], maxN = 80, tol = 0.05, need = 0.97): number {
  if (points.length < 3) return 0;
  const grid = new PointGrid(points, tol);
  // m points cannot be more than m-fold symmetric (tolerance aside).
  for (let n = Math.min(maxN, points.length); n >= 2; n--) if (rotationShare(points, grid, n, need) >= need) return n;
  return 0;
}

/** Share of points that a rotation by 2π/n about z maps onto the set. */
export function rotationShare(points: readonly P3[], grid: PointGrid, n: number, need = 0) {
  const c = Math.cos(2 * Math.PI / n), s = Math.sin(2 * Math.PI / n);
  return mappedShare(points, grid, p => [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]], need);
}
