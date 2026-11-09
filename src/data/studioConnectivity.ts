import type { Vec3 } from '../ldraw/parse';

/**
 * BrickLink Studio's own per-part connectivity (`ldraw/connectivity/<part>.conn`), as far as this
 * project has verified it against parts whose connectors it already measures. Studio ships about
 * 9,200 such files beside its LDraw library; the app reads none of them today and derives the same
 * kind of data from the LDraw geometry and the LDCad shadow pack instead.
 *
 * A record is little-endian:
 *
 *   uint32  code          0x2 / 0x10002 an anti-stud (female), 0x170003 a stud (male). Every other
 *                         code Studio writes (pins, axles, clips, ball joints, and its outer-face
 *                         markers) is left alone: their shape is not verified here.
 *   9× f32  rotation      row-major, LDraw convention: the connection's frame in part space
 *   3× f32  position      the first cell's corner in that frame, so the point is
 *                         `position − rotationᵀ·(-10, 0, 10)`
 *   tail                  one entry per grid cell, the cell counts as int16 at +0 and +2 (twice the
 *                         counts, z first). Files also carry records whose tail is a different
 *                         shape, so the records are found by scanning rather than walked.
 *
 * The axis is the frame's −Y: a stud points along it, an anti-stud takes a stud coming along it.
 * That is the same convention as `Snap` in src/ldraw/shadow.ts, so the axis needs no flipping.
 * Both the point and the axis were checked against the connectors this project already measures
 * for 3005, 3024, 4070 (including the recessed headlight stud at (0, 10, −6) and the back
 * anti-stud at (0, 10, 10)), 87087 and 3001.
 */

/** The 1×1 cell corner Studio offsets every position by, in the connection's own frame. */
const CORNER: Vec3 = [-10, 0, 10];
/** Bytes before the tail: the code, the rotation and the position. */
const HEAD = 4 + 9 * 4 + 3 * 4;
/**
 * A record's tail, measured on 3005 (1×1), 3069b (1×2), 2431 (1×4), 3001 (2×4) and 0901 (1×8,
 * 28×1 and 9×4): `8 + 16·cells + 8·(nx+nz)`.
 */
const tailSize = (nx: number, nz: number) => 8 + 16 * nx * nz + 8 * (nx + nz);
/** A marker record (0xc0000 and the like) ends 8 bytes after its position. */
const MARKER_TAIL = 8;

/** Studio's connection codes this project has verified, and the gender they mean. */
const CODES: Readonly<Record<number, 'M' | 'F'>> = {
  0x2: 'F',      // underside / face anti-stud: 3005, 3024, 3069b, 4070, 87087, 3001, 32064
  0x10002: 'F',  // the same on plates and brackets: 2431, 3069b, 99780, 4081b
  0x170003: 'M', // top and side studs: 3005, 3024, 4070, 87087, 11211, 3001, 4081b
};

/** A connection Studio records that this project uses: a stud or an anti-stud. */
export type StudioConnection = { gender: 'M' | 'F'; pos: Vec3; axis: Vec3 };

/** One record found in a `.conn` file, whether or not this project uses its code. */
export type StudioRecord = {
  code: number;
  /** byte offset in the file */
  at: number;
  /** part space */
  pos: Vec3;
  axis: Vec3;
  /** grid cells the record covers: nx along the frame's x, nz along its z (1×1 when unknown) */
  grid: [number, number];
};

const f32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, true);
const i16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 2).getInt16(0, true);
const i32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset + o, 4).getInt32(0, true);
const near = (v: number, t: number) => Math.abs(v - t) < 1e-3;
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  // `|| 0` keeps a −0 out of the data (it would compare differently for no reason)
  return [v[0] / l || 0, v[1] / l || 0, v[2] / l || 0];
};

/** The three rows of a rotation, or null when the nine numbers are not one. */
function rotation(m: number[]): number[] | null {
  for (let r = 0; r < 3; r++) if (!near(Math.hypot(m[r * 3], m[r * 3 + 1], m[r * 3 + 2]), 1)) return null;
  for (const [a, b] of [[0, 1], [0, 2], [1, 2]])
    if (Math.abs(m[a * 3] * m[b * 3] + m[a * 3 + 1] * m[b * 3 + 1] + m[a * 3 + 2] * m[b * 3 + 2]) > 1e-3) return null;
  return m;
}

/** The records of one `.conn` file, and whether the walk understood the whole file. */
export type StudioFile = {
  records: StudioRecord[];
  /**
   * The walk reached the end of the file exactly, so every record's tail was one of the shapes
   * above. Files that do not parse cleanly are ignored whole: a tail this importer has not
   * identified would leave every record after it in doubt.
   */
  complete: boolean;
};

/**
 * Every record in one `.conn` file, in file order. The records are walked: a record's tail length
 * follows from its cell counts, so the next record starts right after it.
 */
export function parseStudioConnectivity(bytes: Uint8Array): StudioFile {
  const records: StudioRecord[] = [];
  const recordAt = (at: number) => {
    if (at + HEAD > bytes.length) return null;
    const code = i32(bytes, at);
    if (code === 0) return null;
    const m = rotation([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => f32(bytes, at + 4 + i * 4)));
    if (!m) return null;
    const p: Vec3 = [0, 1, 2].map((k) => f32(bytes, at + 40 + k * 4)) as Vec3;
    return p.every((v) => Number.isFinite(v) && Math.abs(v) < 1000) ? { code, m, p } : null;
  };
  let o = 0;
  while (o + HEAD <= bytes.length) {
    const hit = recordAt(o);
    if (!hit) return { records, complete: false };
    const { code, m, p } = hit;
    // the counts are twice the cell counts, z first (verified on 3005, 3069b, 2431, 3001, 0901)
    const nz = o + HEAD + 4 <= bytes.length ? i16(bytes, o + HEAD) / 2 : 0;
    const nx = o + HEAD + 4 <= bytes.length ? i16(bytes, o + HEAD + 2) / 2 : 0;
    const grid: [number, number] | null = Number.isInteger(nx) && Number.isInteger(nz) && nx >= 1 && nz >= 1 && nx * nz <= 4096
      ? [nx, nz] : null;
    // position − rotationᵀ·corner
    const t = [0, 1, 2].map((i) => m[i] * CORNER[0] + m[3 + i] * CORNER[1] + m[6 + i] * CORNER[2]);
    records.push({ code, at: o, pos: [p[0] - t[0] || 0, p[1] - t[1] || 0, p[2] - t[2] || 0], axis: unit([-m[3], -m[4], -m[5]] as Vec3), grid: grid ?? [1, 1] });
    // a grid record's tail is the formula above; Studio's markers end the record 8 bytes later
    o += HEAD + (grid ? tailSize(grid[0], grid[1]) : MARKER_TAIL);
  }
  return { records, complete: o === bytes.length };
}

/** The usable connections of one part: a stud or anti-stud, on an axis-aligned axis. */
export const studioConnections = (records: readonly StudioRecord[]): StudioConnection[] =>
  records.flatMap((r) => {
    const gender = CODES[r.code];
    if (!gender) return [];
    // a tilted frame is a hose or a clip, not the stud grid this project seats on
    const axis = r.axis.map((v) => Math.abs(Math.abs(v) - 1) < 1e-3 ? Math.sign(v) : 0);
    if (Math.abs(axis[0]) + Math.abs(axis[1]) + Math.abs(axis[2]) !== 1) return [];
    return [{ gender, pos: r.pos, axis: axis as Vec3 }];
  });
