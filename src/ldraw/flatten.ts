import type { LDrawFile, Mat3, Vec3 } from './parse';

export type Box = { min: Vec3; max: Vec3 };

export type FlatPart = {
  id: string;
  /** color code (16 = main color) → flat xyz triangle list in part space (LDU), CCW front faces */
  tris: Map<number, number[]>;
  /** triangles from files that are not BFC certified (render double sided) */
  doubleSided: Map<number, number[]>;
  /** bounds without stud geometry; null when the part has no non-stud geometry */
  bodyBox: Box | null;
  fullBox: Box | null;
};

const MAX_DEPTH = 32;
const STUD_RE = /^stud.*\.dat$/;

export type FileLookup = (name: string) => LDrawFile | null;

function det(m: Mat3): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

function mulMat(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

function apply(m: Mat3, t: Vec3, x: number, y: number, z: number): Vec3 {
  return [m[0] * x + m[1] * y + m[2] * z + t[0], m[3] * x + m[4] * y + m[5] * z + t[1], m[6] * x + m[7] * y + m[8] * z + t[2]];
}

function grow(box: Box | null, p: Vec3): Box {
  if (!box) return { min: [...p] as Vec3, max: [...p] as Vec3 };
  for (let i = 0; i < 3; i++) {
    if (p[i] < box.min[i]) box.min[i] = p[i];
    if (p[i] > box.max[i]) box.max[i] = p[i];
  }
  return box;
}

export function baseName(file: string): string {
  return file.split('/').pop()!;
}

/**
 * Flattens a part into triangles grouped by color. All sub-files must already be
 * available through `lookup`; missing ones are skipped (reported via `onMissing`).
 */
export function flattenPart(id: string, root: LDrawFile, lookup: FileLookup, onMissing?: (name: string) => void): FlatPart {
  const out: FlatPart = { id, tris: new Map(), doubleSided: new Map(), bodyBox: null, fullBox: null };
  const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  const push = (map: Map<number, number[]>, color: number, pts: number[]) => {
    let arr = map.get(color);
    if (!arr) map.set(color, (arr = []));
    arr.push(...pts);
  };

  const walk = (file: LDrawFile, m: Mat3, t: Vec3, color: number, invert: boolean, certifiedChain: boolean, inStud: boolean, depth: number) => {
    if (depth > MAX_DEPTH) return;
    const certified = certifiedChain && file.cmds.some((c) => c.t === 'bfc' && (c.cert === 'CCW' || c.cert === 'CW'));
    let winding: 'CCW' | 'CW' = 'CCW';
    for (const c of file.cmds) {
      if (c.t === 'bfc') {
        if (c.cert === 'CW') winding = 'CW';
        if (c.winding) winding = c.winding;
        continue;
      }
      if (c.t === 'ref') {
        const child = lookup(c.file);
        if (!child) {
          onMissing?.(c.file);
          continue;
        }
        const cm = mulMat(m, c.m);
        const ct = apply(m, t, c.pos[0], c.pos[1], c.pos[2]);
        const cc = c.color === 16 ? color : c.color;
        const childInvert = invert !== c.invert; // matrix mirroring is handled via det(m) below
        walk(child, cm, ct, cc, childInvert, certified, inStud || STUD_RE.test(baseName(c.file)), depth + 1);
        continue;
      }
      if (c.t !== 'tri' && c.t !== 'quad') continue;
      const col = c.color === 16 ? color : c.color;
      const v: Vec3[] = [];
      for (let i = 0; i < c.pts.length; i += 3) v.push(apply(m, t, c.pts[i], c.pts[i + 1], c.pts[i + 2]));
      for (const p of v) {
        out.fullBox = grow(out.fullBox, p);
        if (!inStud) out.bodyBox = grow(out.bodyBox, p);
      }
      const reverse = (winding === 'CW') !== invert !== det(m) < 0;
      const faces = c.t === 'tri' ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]];
      for (const f of faces) {
        const idx = reverse ? [f[0], f[2], f[1]] : f;
        const pts = idx.flatMap((i) => v[i]);
        push(certified ? out.tris : out.doubleSided, col, pts);
      }
    }
  };

  walk(root, I, [0, 0, 0], 16, false, true, false, 0);
  return out;
}
