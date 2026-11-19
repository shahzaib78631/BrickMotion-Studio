import { Matrix4, Vector3 } from 'three';
import type { Mat3, Vec3 } from '../../src/ldraw/parse';

/** Inheritance policy from the source format, evaluated in the connector's
 * local axes. Source-local placement is kept separate from inherited scaling. */
export function referenceFramePolicy(world: Matrix4, local: { m: Mat3; pos: Vec3 }, policy: { scale?: string; mirror?: string }) {
  const m = local.m, p = local.pos;
  const own = new Matrix4().set(m[0], m[1], m[2], p[0], m[3], m[4], m[5], p[1], m[6], m[7], m[8], p[2], 0, 0, 0, 1);
  const linear = world.clone().setPosition(0, 0, 0);
  const basis = [new Vector3(m[0], m[3], m[6]), new Vector3(m[1], m[4], m[7]), new Vector3(m[2], m[5], m[8])];
  if (basis.some(v => v.length() < 1e-9)) return { reason: 'Degenerate source frame' };
  const transformed = basis.map(v => v.clone().normalize().applyMatrix4(linear));
  const lengths = transformed.map(v => v.length());
  if (lengths.some(v => v < 1e-9 || !Number.isFinite(v))) return { reason: 'Degenerate inherited frame' };
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]]) {
    if (Math.abs(transformed[a].dot(transformed[b]) / lengths[a] / lengths[b]) > 1e-4) return { reason: 'Sheared inherited frame' };
  }
  const [x, y, z] = lengths, near = (a: number, b: number) => Math.abs(a - b) <= 1e-4 * Math.max(1, a, b);
  const scale = (policy.scale ?? 'none').toLowerCase();
  if (!['none', 'yonly', 'ronly', 'yandr'].includes(scale)) return { reason: `Unsupported scaling policy: ${scale}` };
  const allowed = scale === 'none' ? near(x, 1) && near(y, 1) && near(z, 1)
    : scale === 'yonly' ? near(x, 1) && near(z, 1)
    : scale === 'ronly' ? near(y, 1) && near(x, z) : near(x, z);
  if (!allowed) return { reason: `Scaling rejected by ${scale}` };
  const out = world.clone().multiply(own);
  const mirror = (policy.mirror ?? 'cor').toLowerCase();
  if (!['none', 'cor', 'corx', 'corz'].includes(mirror)) return { reason: `Unsupported mirror policy: ${mirror}` };
  if (world.determinant() < 0) {
    if (mirror === 'none') return { reason: 'Mirroring rejected by none' };
    // A radial-axis correction preserves the axial profile direction.
    out.multiply(new Matrix4().makeScale(mirror === 'corx' ? -1 : 1, 1, mirror === 'corx' ? 1 : -1));
  }
  return { matrix: out };
}
