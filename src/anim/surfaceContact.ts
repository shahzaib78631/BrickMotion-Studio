/** Numeric, bounded contact certificates. No renderer or external runtime required. */
export type SurfaceTree = {
  min: [number, number, number]; max: [number, number, number];
  left?: SurfaceTree; right?: SurfaceTree; first: number; count: number;
};
type Surface = { tris: Float32Array; tree: SurfaceTree };
type Vec = readonly number[];
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec, b: Vec): number[] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function pointSegmentSquared(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a), ap = sub(p, a), length = dot(ab, ab);
  const t = length ? Math.max(0, Math.min(1, dot(ap, ab) / length)) : 0;
  return ap.reduce((sum, x, k) => sum + (x - t * ab[k]) ** 2, 0);
}

function segSq(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az, apx = px - ax, apy = py - ay, apz = pz - az;
  const length = abx * abx + aby * aby + abz * abz;
  const t = length ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / length)) : 0;
  const dx = apx - t * abx, dy = apy - t * aby, dz = apz - t * abz;
  return dx * dx + dy * dy + dz * dz;
}

/** pointTriangleSquared on plain numbers: the triangle is tr[i..i+8]. No allocation. */
function triSq(px: number, py: number, pz: number, tr: Float32Array, i: number): number {
  const ax = tr[i], ay = tr[i + 1], az = tr[i + 2], bx = tr[i + 3], by = tr[i + 4], bz = tr[i + 5], cx = tr[i + 6], cy = tr[i + 7], cz = tr[i + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
  const nn = nx * nx + ny * ny + nz * nz;
  if (nn < 1e-24) return Math.min(segSq(px, py, pz, ax, ay, az, bx, by, bz), segSq(px, py, pz, bx, by, bz, cx, cy, cz), segSq(px, py, pz, cx, cy, cz, ax, ay, az));
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return segSq(px, py, pz, ax, ay, az, bx, by, bz);
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return segSq(px, py, pz, ax, ay, az, cx, cy, cz);
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return segSq(px, py, pz, bx, by, bz, cx, cy, cz);
  const h = apx * nx + apy * ny + apz * nz;
  return Math.max(0, h * h / nn);
}

/** Squared distance to a closed triangle, including its edges and vertices. */
export function pointTriangleSquared(p: Vec, a: Vec, b: Vec, c: Vec): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  if (dot(normal, normal) < 1e-24) {
    return Math.min(pointSegmentSquared(p, a, b), pointSegmentSquared(p, b, c), pointSegmentSquared(p, c, a));
  }
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return pointSegmentSquared(p, a, b);
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return pointSegmentSquared(p, a, c);
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return pointSegmentSquared(p, b, c);
  const h = dot(ap, normal);
  return Math.max(0, h * h / dot(normal, normal));
}

/** An upper bound on the affine linear operator's scale, in column-major order. */
export function maximumLinearScale(e: readonly number[]): number {
  const one = Math.max(...[0, 4, 8].map((c) => Math.abs(e[c]) + Math.abs(e[c + 1]) + Math.abs(e[c + 2])));
  const inf = Math.max(...[0, 1, 2].map((r) => Math.abs(e[r]) + Math.abs(e[r + 4]) + Math.abs(e[r + 8])));
  return Math.sqrt(one * inf);
}

function boxDistanceSquared(p: Vec, node: SurfaceTree): number {
  let d = 0;
  for (let k = 0; k < 3; k++) d += Math.max(node.min[k] - p[k], 0, p[k] - node.max[k]) ** 2;
  return d;
}

/**
 * Certifies that EVERY point of a segment stays in a small tube around tangent
 * surface triangles. This is not a midpoint-only test and not a blanket waiver
 * for a touching part. The tube around a closed triangle is convex: if both
 * endpoints are in it, their whole segment is in it. Where tessellation changes,
 * split the segment and certify each half separately. Directions within 0.01 radians of tangency accommodate rounded imports;
 * both endpoints must STILL stay in the original bounded contact tube.
 * Normal crossings cannot certify contact, so a thin wall crossed normally is still an obstacle.
 * The bounded search fails closed, including on invalid input or exhausted work.
 */
export function segmentTouchesSurface(
  surface: Surface, o: Vec, d: Vec, fromT: number, toT: number, tolerance: number, normalRatio = 1e-4,
): boolean {
  if (![...o, ...d, fromT, toT, tolerance, normalRatio].every(Number.isFinite) || tolerance <= 0 || toT < fromT || normalRatio < 0 || normalRatio > 0.1) return false;
  const speed2 = dot(d, d);
  if (speed2 <= 1e-24 || !surface.tree.count) return false;
  const tol2 = tolerance * tolerance;
  const tr = surface.tris;
  const pending: [number, number, number][] = [[fromT, toT, 0]];
  let intervals = 0, visits = 0, triangles = 0;
  while (pending.length) {
    if (++intervals > 128) return false;
    const [lo, hi, depth] = pending.pop()!;
    const mid = (lo + hi) / 2;
    const px = o[0] + mid * d[0], py = o[1] + mid * d[1], pz = o[2] + mid * d[2];
    const sx = o[0] + lo * d[0], sy = o[1] + lo * d[1], sz = o[2] + lo * d[2];
    const ex = o[0] + hi * d[0], ey = o[1] + hi * d[1], ez = o[2] + hi * d[2];
    const p = [px, py, pz];
    const stack: SurfaceTree[] = [surface.tree];
    let certified = false, nearTangent = false;
    while (stack.length && !certified) {
      if (++visits > 8192) return false;
      const node = stack.pop()!;
      if (!node.count || boxDistanceSquared(p, node) > tol2) continue;
      if (node.left && node.right) { stack.push(node.left, node.right); continue; }
      for (let j = node.first; j < node.first + node.count; j++) {
        if (++triangles > 32768) return false;
        const i = j * 9;
        const abx = tr[i + 3] - tr[i], aby = tr[i + 4] - tr[i + 1], abz = tr[i + 5] - tr[i + 2];
        const acx = tr[i + 6] - tr[i], acy = tr[i + 7] - tr[i + 1], acz = tr[i + 8] - tr[i + 2];
        const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
        const normal2 = nx * nx + ny * ny + nz * nz, tangent = nx * d[0] + ny * d[1] + nz * d[2];
        if (normal2 < 1e-24 || tangent * tangent > normalRatio * normal2 * speed2) continue;
        if (triSq(px, py, pz, tr, i) > tol2) continue;
        nearTangent = true;
        if (triSq(sx, sy, sz, tr, i) <= tol2 && triSq(ex, ey, ez, tr, i) <= tol2) { certified = true; break; }
      }
    }
    if (certified) continue;
    if (!nearTangent || depth >= 12 || hi - lo < 1e-7) return false;
    pending.push([lo, mid, depth + 1], [mid, hi, depth + 1]);
  }
  return true;
}
