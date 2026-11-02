import type { Mat3, Vec3 } from './parse';

/** A placement example embedded in official LDraw `0 !HELP` documentation.
 * A hint is NOT a physical connector, snap definition, collision certificate,
 * or proof that an arbitrary lookalike part fits. */
export type AttachmentHint = {
  part: string;
  pos: Vec3;
  m: Mat3;
  /** True for an LDraw reflected type-1 instance; a mirror is not a physical rotation. */
  mirrored: boolean;
  /** Human-readable !HELP heading preceding the example. */
  context: string;
  /** 1-based line in the original .dat, when available. */
  line: number;
};

/** Classify an orthogonal LDraw type-1 basis. Matrices with determinant -1
 * are legitimate *mirrored render placements*, not rigid body rotations.
 * Return 0 for shear, scaling or malformed numbers. Rounded coefficients
 * such as .99985/.01745 from the official 19141 part are accepted. */
export function orthogonalBasisParity(m: readonly number[], tolerance = .002): -1 | 0 | 1 {
  if (m.length !== 9 || !m.every(Number.isFinite)) return 0;
  const rows = [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];
  const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, n, i) => sum + n * b[i], 0);
  if (rows.some((r) => Math.abs(dot(r, r) - 1) > tolerance)) return 0;
  if (Math.abs(dot(rows[0], rows[1])) > tolerance ||
      Math.abs(dot(rows[0], rows[2])) > tolerance ||
      Math.abs(dot(rows[1], rows[2])) > tolerance) return 0;
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det - 1) <= tolerance * 3) return 1;
  if (Math.abs(det + 1) <= tolerance * 3) return -1;
  return 0;
}

/** Reject reflections where a physically rigid *rotation* is required. */
export function properRigidBasis(m: readonly number[], tolerance = .002): boolean {
  return orthogonalBasisParity(m, tolerance) === 1;
}

/** Parse only the exact `!HELP 1 colour x y z a..i filename` form.
 * Never execute other HELP text, infer an inserted part from prose, or turn
 * arbitrary comments into placement candidates. */
export function attachmentHintsFromLDraw(text: string): AttachmentHint[] {
  const out: AttachmentHint[] = [];
  let context = '';
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /^\s*0\s+!HELP\s+(.+?)\s*$/i.exec(line);
    if (!match) return;
    const body = match[1];
    const parts = body.split(/\s+/);
    if (parts[0] !== '1') { context = body; return; }
    if (parts.length !== 15 || !/^\d+$/.test(parts[1])) return;
    const numbers = parts.slice(2, 14).map(Number);
    if (numbers.length !== 12 || !numbers.every(Number.isFinite)) return;
    const part = parts[14].toLowerCase().replace(/\\/g, '/');
    // Restrict to a simple part name; paths, subfiles and URLs are not a
    // compatible attachment target unless curated separately.
    if (!/^[a-z0-9][a-z0-9_-]*\.dat$/.test(part)) return;
    const m = numbers.slice(3) as Mat3;
    const parity = orthogonalBasisParity(m);
    if (!parity) return;
    out.push({ part, pos: numbers.slice(0, 3) as Vec3, m,
      mirrored: parity === -1, context, line: index + 1 });
  });
  return out;
}
