/**
 * Rounded edges for render geometry, without moving a single vertex.
 *
 * Real bricks have slightly rounded corners that catch a thin highlight; LDraw parts are
 * perfectly sharp. Along every sharp OUTSIDE edge, each triangle gives up a thin strip
 * (`width` LDU wide) whose edge-side corners get the normal halfway between the two faces.
 * Shading then turns smoothly across the strip like a small fillet, in the viewport and in
 * the path tracer alike. The silhouette is unchanged and no cracks can open.
 *
 * Neighbours are found by the LINE an edge lies on, not by shared vertices, so the many
 * T-junctions in LDraw meshes (a face split differently on each side) still count.
 *
 * Written with flat typed arrays: a 2x4 brick at high detail has ~35k triangles.
 */

export type BevelResult = {
  /** flat xyz triangle list, CCW */
  positions: Float32Array;
  /** per-corner normal to use instead of the smooth one; NaN where none */
  normals: Float32Array;
};

const hashInts = (k: Int32Array, o: number) => {
  let h = 2166136261;
  for (let i = 0; i < 6; i++) h = Math.imul(h ^ k[o + i], 16777619);
  return h >>> 0;
};
const sameInts = (k: Int32Array, a: number, b: number) =>
  k[a] === k[b] && k[a + 1] === k[b + 1] && k[a + 2] === k[b + 2] && k[a + 3] === k[b + 3] && k[a + 4] === k[b + 4] && k[a + 5] === k[b + 5];

/**
 * `pts`: flat triangle list (LDU). `width`: strip width in LDU. `crease`: smallest angle
 * between faces (radians) that counts as a sharp edge.
 */
export function bevelSharpEdges(pts: ArrayLike<number>, width = 0.45, crease = Math.PI / 6): BevelResult {
  const T = Math.floor(pts.length / 9);
  const P = new Float64Array(T * 9);
  for (let i = 0; i < T * 9; i++) P[i] = pts[i];

  // face normals, three's convention: (c - b) × (a - b)
  const FN = new Float64Array(T * 3);
  for (let t = 0; t < T; t++) {
    const o = t * 9;
    const ux = P[o + 6] - P[o + 3], uy = P[o + 7] - P[o + 4], uz = P[o + 8] - P[o + 5];
    const vx = P[o] - P[o + 3], vy = P[o + 1] - P[o + 4], vz = P[o + 2] - P[o + 5];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    FN[t * 3] = nx / l; FN[t * 3 + 1] = ny / l; FN[t * 3 + 2] = nz / l;
  }

  // every triangle edge (e = t*3 + k, from corner k to k+1), grouped by the line it lies on:
  // canonical direction ×500 and the line's point nearest the origin ×20, rounded
  const E = T * 3;
  const key = new Int32Array(E * 6);
  const hash = new Uint32Array(E);
  const t0 = new Float64Array(E);
  const t1 = new Float64Array(E);
  const valid = new Uint8Array(E);
  const next = new Int32Array(E).fill(-1);
  const head = new Map<number, number>();
  for (let e = 0; e < E; e++) {
    const t = (e / 3) | 0, k = e % 3;
    const a = t * 9 + k * 3, b = t * 9 + ((k + 1) % 3) * 3;
    let dx = P[b] - P[a], dy = P[b + 1] - P[a + 1], dz = P[b + 2] - P[a + 2];
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) continue;
    dx /= l; dy /= l; dz /= l;
    const lead = Math.abs(dx) > 1e-6 ? dx : Math.abs(dy) > 1e-6 ? dy : dz;
    if (lead < 0) { dx = -dx; dy = -dy; dz = -dz; }
    const sa = P[a] * dx + P[a + 1] * dy + P[a + 2] * dz;
    const sb = P[b] * dx + P[b + 1] * dy + P[b + 2] * dz;
    const o = e * 6;
    key[o] = Math.round(dx * 500); key[o + 1] = Math.round(dy * 500); key[o + 2] = Math.round(dz * 500);
    key[o + 3] = Math.round((P[a] - dx * sa) * 20);
    key[o + 4] = Math.round((P[a + 1] - dy * sa) * 20);
    key[o + 5] = Math.round((P[a + 2] - dz * sa) * 20);
    t0[e] = Math.min(sa, sb); t1[e] = Math.max(sa, sb);
    const h = hashInts(key, o);
    hash[e] = h;
    valid[e] = 1;
    next[e] = head.get(h) ?? -1;
    head.set(h, e);
  }

  // per edge: the bent normal when it is a sharp outside edge
  const sharpDot = Math.cos(crease);
  const bent = new Float64Array(E * 3);
  const sharp = new Uint8Array(E);
  for (let e = 0; e < E; e++) {
    if (!valid[e]) continue;
    const t = (e / 3) | 0, k = e % 3;
    const a = t * 9 + k * 3;
    const farA = t * 9 + ((k + 2) % 3) * 3;
    const ax = FN[t * 3], ay = FN[t * 3 + 1], az = FN[t * 3 + 2];
    let overlapBest = 0.05;
    for (let o = head.get(hash[e]) ?? -1; o !== -1; o = next[o]) {
      const to = (o / 3) | 0;
      if (to === t || !sameInts(key, e * 6, o * 6)) continue;
      const overlap = Math.min(t1[e], t1[o]) - Math.max(t0[e], t0[o]);
      if (overlap <= overlapBest) continue;
      const bx = FN[to * 3], by = FN[to * 3 + 1], bz = FN[to * 3 + 2];
      if (ax * bx + ay * by + az * bz > sharpDot) continue;
      // outside (convex) edge: the other face falls away behind this one, and vice versa
      const farB = to * 9 + (((o % 3) + 2) % 3) * 3;
      const fbA = ax * (P[farB] - P[a]) + ay * (P[farB + 1] - P[a + 1]) + az * (P[farB + 2] - P[a + 2]);
      const faB = bx * (P[farA] - P[a]) + by * (P[farA + 1] - P[a + 1]) + bz * (P[farA + 2] - P[a + 2]);
      if (fbA > -1e-3 || faB > -1e-3) continue;
      const nx = ax + bx, ny = ay + by, nz = az + bz;
      const l = Math.hypot(nx, ny, nz) || 1;
      bent[e * 3] = nx / l; bent[e * 3 + 1] = ny / l; bent[e * 3 + 2] = nz / l;
      sharp[e] = 1;
      overlapBest = overlap;
    }
  }

  // output, grown as needed
  let outP = new Float32Array(Math.max(9, T * 9 * 2));
  let outN = new Float32Array(outP.length);
  let n = 0;
  const INNER = new Float64Array(9);
  const corner = (s: Float64Array, o: number, nrm: number) => {
    outP[n] = s[o]; outP[n + 1] = s[o + 1]; outP[n + 2] = s[o + 2];
    if (nrm < 0) outN[n] = outN[n + 1] = outN[n + 2] = NaN;
    else { outN[n] = bent[nrm]; outN[n + 1] = bent[nrm + 1]; outN[n + 2] = bent[nrm + 2]; }
    n += 3;
  };
  /** a corner is (source array, offset); a normal is an offset into `bent` or -1 for none */
  const emit = (sa: Float64Array, oa: number, sb: Float64Array, ob: number, sc: Float64Array, oc: number, na: number, nb: number, nc: number) => {
    const ux = sb[ob] - sa[oa], uy = sb[ob + 1] - sa[oa + 1], uz = sb[ob + 2] - sa[oa + 2];
    const vx = sc[oc] - sa[oa], vy = sc[oc + 1] - sa[oa + 1], vz = sc[oc + 2] - sa[oa + 2];
    // drop zero-area slivers (a smooth edge whose ends did not both move)
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-8) return;
    if (n + 9 > outP.length) {
      const p2 = new Float32Array(outP.length * 2); p2.set(outP); outP = p2;
      const n2 = new Float32Array(outN.length * 2); n2.set(outN); outN = n2;
    }
    corner(sa, oa, na); corner(sb, ob, nb); corner(sc, oc, nc);
  };

  // inner corner i: `w(edge i-1)` along edge i (towards i+1) and `w(edge i)` along edge i-1
  const inset = (t: number, w: number): boolean => {
    const base = t * 9;
    for (let i = 0; i < 3; i++) {
      const p = base + i * 3, nx = base + ((i + 1) % 3) * 3, pv = base + ((i + 2) % 3) * 3;
      let u1x = P[nx] - P[p], u1y = P[nx + 1] - P[p + 1], u1z = P[nx + 2] - P[p + 2];
      let u2x = P[pv] - P[p], u2y = P[pv + 1] - P[p + 1], u2z = P[pv + 2] - P[p + 2];
      const l1 = Math.hypot(u1x, u1y, u1z) || 1, l2 = Math.hypot(u2x, u2y, u2z) || 1;
      u1x /= l1; u1y /= l1; u1z /= l1; u2x /= l2; u2y /= l2; u2z /= l2;
      const sin = Math.hypot(u1y * u2z - u1z * u2y, u1z * u2x - u1x * u2z, u1x * u2y - u1y * u2x);
      if (sin < 1e-4) return false;
      const wNext = sharp[t * 3 + i] ? w / sin : 0;           // edge p → next
      const wPrev = sharp[t * 3 + ((i + 2) % 3)] ? w / sin : 0; // edge prev → p
      INNER[i * 3] = P[p] + u1x * wPrev + u2x * wNext;
      INNER[i * 3 + 1] = P[p + 1] + u1y * wPrev + u2y * wNext;
      INNER[i * 3 + 2] = P[p + 2] + u1z * wPrev + u2z * wNext;
    }
    // still a proper triangle facing the same way, inside the original one
    const ux = INNER[6] - INNER[3], uy = INNER[7] - INNER[4], uz = INNER[8] - INNER[5];
    const vx = INNER[0] - INNER[3], vy = INNER[1] - INNER[4], vz = INNER[2] - INNER[5];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * FN[t * 3] + cy * FN[t * 3 + 1] + cz * FN[t * 3 + 2] <= 1e-9) return false;
    for (let q = 0; q < 3; q++) for (let i = 0; i < 3; i++) {
      const a = base + i * 3, b = base + ((i + 1) % 3) * 3, c = base + ((i + 2) % 3) * 3;
      const ex = P[b] - P[a], ey = P[b + 1] - P[a + 1], ez = P[b + 2] - P[a + 2];
      const qx = INNER[q * 3] - P[a], qy = INNER[q * 3 + 1] - P[a + 1], qz = INNER[q * 3 + 2] - P[a + 2];
      const rx = P[c] - P[a], ry = P[c + 1] - P[a + 1], rz = P[c + 2] - P[a + 2];
      const s1x = ey * qz - ez * qy, s1y = ez * qx - ex * qz, s1z = ex * qy - ey * qx;
      const s2x = ey * rz - ez * ry, s2y = ez * rx - ex * rz, s2z = ex * ry - ey * rx;
      if (s1x * s2x + s1y * s2y + s1z * s2z < -1e-9) return false;
    }
    return true;
  };

  for (let t = 0; t < T; t++) {
    const base = t * 9;
    const any = sharp[t * 3] || sharp[t * 3 + 1] || sharp[t * 3 + 2];
    let ok = false;
    if (any) for (let w = width, k = 0; k < 4 && !ok; k++, w /= 2) ok = inset(t, w);
    if (!ok) {
      emit(P, base, P, base + 3, P, base + 6, -1, -1, -1);
      continue;
    }
    emit(INNER, 0, INNER, 3, INNER, 6, -1, -1, -1);
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const vi = base + i * 3, vj = base + j * 3;
      if (!sharp[t * 3 + i]) {
        // a smooth edge: the strip along it is flat; it only exists where corners moved in
        const di = Math.hypot(INNER[i * 3] - P[vi], INNER[i * 3 + 1] - P[vi + 1], INNER[i * 3 + 2] - P[vi + 2]);
        const dj = Math.hypot(INNER[j * 3] - P[vj], INNER[j * 3 + 1] - P[vj + 1], INNER[j * 3 + 2] - P[vj + 2]);
        if (di < 1e-6 && dj < 1e-6) continue;
        emit(P, vi, P, vj, INNER, j * 3, -1, -1, -1);
        emit(P, vi, INNER, j * 3, INNER, i * 3, -1, -1, -1);
        continue;
      }
      const nb = (t * 3 + i) * 3;
      emit(P, vi, P, vj, INNER, j * 3, nb, nb, -1);
      emit(P, vi, INNER, j * 3, INNER, i * 3, nb, -1, -1);
    }
  }
  return { positions: outP.slice(0, n), normals: outN.slice(0, n) };
}
