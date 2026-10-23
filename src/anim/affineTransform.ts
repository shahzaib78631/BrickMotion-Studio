/** Numeric QR factorization A = R * H: R is a proper rotation, H is a fixed shape.
 * Imported LDraw transforms may contain scale, reflection and rounded shear.
 * Carry H with the part throughout its flight; never drop it and snap it back at
 * the destination. No rendering dependency is needed to test this calculation.
 */
export type AffineFactors = { position: [number, number, number]; rotation: number[]; shape: number[] };
export function factorAffine(e: readonly number[]): AffineFactors | null {
  if (e.length !== 16 || !e.every(Number.isFinite) || Math.abs(e[3]) > 1e-10 || Math.abs(e[7]) > 1e-10 || Math.abs(e[11]) > 1e-10 || Math.abs(e[15] - 1) > 1e-10) return null;
  const a = [e[0], e[1], e[2]], b = [e[4], e[5], e[6]], c = [e[8], e[9], e[10]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const lengths = [Math.hypot(...a), Math.hypot(...b), Math.hypot(...c)];
  const determinant = dot(a, cross(b, c));
  if (lengths.some((v) => v < 1e-8) || Math.abs(determinant) / (lengths[0] * lengths[1] * lengths[2]) < 1e-8) return null;
  // Reflections stay in H, not in the quaternion's proper rotation.
  const sx = lengths[0] * (determinant < 0 ? -1 : 1);
  const x = a.map((v) => v / sx);
  const h01 = dot(x, b);
  const by = b.map((v, i) => v - h01 * x[i]);
  const sy = Math.hypot(...by);
  if (sy < 1e-8) return null;
  const y = by.map((v) => v / sy);
  const z = cross(x, y);
  const h02 = dot(x, c), h12 = dot(y, c), sz = dot(z, c);
  return {
    position: [e[12], e[13], e[14]],
    rotation: [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1],
    shape: [sx, 0, 0, 0, h01, sy, 0, 0, h02, h12, sz, 0, 0, 0, 0, 1],
  };
}
