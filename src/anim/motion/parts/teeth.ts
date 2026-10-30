/**
 * Toothed features of one part, measured from its LDraw geometry.
 *
 * LEGO gears share one tooth size: pitch radius 1.25 LDU per tooth, tips about
 * 2 LDU beyond it. On each of the part's axes we peel the outermost band of
 * vertices (4.5 LDU deep, a tooth and a bit), split it where it has gaps (over 12 LDU: a spur's teeth are drawn only on its two faces) along
 * the axis, and test each piece for rotational symmetry. A piece is a gear
 * when its order n fits the tooth size (tip − 1.25·n between 0.5 and 3.5 LDU)
 * and it has depth (tips and roots), which rules out hubs, bushes and rims
 * drawn as polygons.
 *
 * Bevels: LDraw draws bevel teeth as a flat-topped band with a taper at the
 * end that faces the cone's tip. The side with the taper is the facing; the
 * pitch circle sits mid-way along the full-height crest, and on a 45° cone
 * the tip is one pitch radius beyond it. A taper on both sides is a double
 * bevel (it also meshes side by side, as a spur). Checked against our
 * measured table (5590) and Kinebrick's corrections.ldr: all tips within
 * 1.5 LDU.
 */
import type { FlatPart } from '../../../ldraw/flatten';
import { PointGrid, rotationalOrder, rotationShare, type P3 } from './meshSymmetry';

export type V3 = [number, number, number];
export type ToothedFeature = {
  kind: 'spur' | 'bevel' | 'double-bevel' | 'crown' | 'clutch' | 'worm' | 'rack';
  teeth: number;
  /** Unit axis in part space (for a rack: its length). */
  axis: V3;
  /** Pitch circle centre (rack: middle of its pitch line), part space. */
  centre: V3;
  pitchRadius: number;
  /** Tooth width along the axis, LDU. */
  width: number;
  /** Bevel: the side its teeth face (towards the cone tip). */
  facing?: V3;
  /** Bevel: pitch cone tip. */
  tip?: V3;
  /** Double bevel: the cone tip on each side. */
  tips?: [V3, V3];
  /** Worm: advance per turn, LDU. */
  lead?: number;
  /** Rack: pitch line length and the side its teeth face. */
  length?: number;
  face?: V3;
};

export const TOOTH_RADIUS = 1.25;
const BAND = 4.5, CREST = 1.5, GAP = 12;

export function partVertices(flat: FlatPart): P3[] {
  const seen = new Set<string>(), out: P3[] = [];
  for (const m of [flat.tris, flat.doubleSided]) for (const t of m.values()) for (let k = 0; k < t.length; k += 3) {
    const key = `${Math.round(t[k] * 100)},${Math.round(t[k + 1] * 100)},${Math.round(t[k + 2] * 100)}`;
    if (!seen.has(key)) { seen.add(key); out.push([t[k], t[k + 1], t[k + 2]]); }
  }
  return out;
}

const AXES: { axis: V3; to: (p: P3) => P3; from: (u: number, v: number, w: number) => V3 }[] = [
  { axis: [1, 0, 0], to: p => [p[1], p[2], p[0]], from: (u, v, w) => [w, u, v] },
  { axis: [0, 1, 0], to: p => [p[2], p[0], p[1]], from: (u, v, w) => [v, w, u] },
  { axis: [0, 0, 1], to: p => [p[0], p[1], p[2]], from: (u, v, w) => [u, v, w] },
];
const radius = (p: P3) => Math.hypot(p[0], p[1]);
/** Vertices grouped into rings by position along the axis (0.25 LDU). */
function rows(ps: readonly P3[]): Map<number, P3[]> {
  const out = new Map<number, P3[]>();
  for (const p of ps) { const k = Math.round(p[2] * 4); (out.get(k) ?? out.set(k, []).get(k)!).push(p); }
  return out;
}
const spread = (ps: readonly P3[]) => ps.length ? Math.max(...ps.map(radius)) - Math.min(...ps.map(radius)) : 0;

export function measureTeeth(flat: FlatPart): ToothedFeature[] {
  const verts = partVertices(flat), out: ToothedFeature[] = [];
  for (const { axis, to, from } of AXES) {
    let rest = verts.map(to).filter(p => radius(p) > 4);
    for (let round = 0; round < 8 && rest.length; round++) {
      const top = Math.max(...rest.map(radius));
      if (top < 6) break;
      const band = rest.filter(p => radius(p) > top - BAND);
      rest = rest.filter(p => radius(p) <= top - BAND);
      for (const piece of splitAlong(band)) {
        const f = gearOf(piece, axis, from);
        if (f) out.push(f);
      }
    }
  }
  return out;
}

/** Split a band where it has a gap of more than 12 LDU along the axis. */
function splitAlong(band: P3[]): P3[][] {
  const sorted = [...band].sort((a, b) => a[2] - b[2]), out: P3[][] = [];
  for (const p of sorted) {
    const last = out.at(-1);
    if (last && p[2] - last[last.length - 1][2] <= GAP) last.push(p); else out.push([p]);
  }
  return out;
}

function gearOf(piece: P3[], axis: V3, from: (u: number, v: number, w: number) => V3): ToothedFeature | null {
  const top = Math.max(...piece.map(radius));
  const n = rotationalOrder(piece);
  if (n < 6 || top - TOOTH_RADIUS * n < 0.5 || top - TOOTH_RADIUS * n > 3.5 || spread(piece) < 1.5) return null;
  const R = TOOTH_RADIUS * n;
  const crest = piece.filter(p => radius(p) > top - CREST), zs = crest.map(p => p[2]);
  const lo = Math.min(...zs), hi = Math.max(...zs), mid = (lo + hi) / 2;
  // A taper: past the crest each tooth's ridge carries on at a smaller radius,
  // drawn as a ring of one or two vertices per tooth with the gear's own
  // symmetry (a hub circle on the same face has more, at even spacing). A ring
  // at the root radius is the root cylinder carrying on as a collar (10928).
  const root = Math.min(...piece.filter(p => p[2] >= lo - 0.1 && p[2] <= hi + 0.1).map(radius));
  const tapered = (side: P3[]) => [...rows(side).values()].some(row => row.length >= 0.8 * n && row.length <= 2 * n + 2 &&
    row.every(p => radius(p) < top - 1 && Math.abs(radius(p) - root) > 0.3) && rotationShare(row, new PointGrid(row, 0.05), n) >= 0.85);
  const below = tapered(piece.filter(p => p[2] < lo - 0.75)), above = tapered(piece.filter(p => p[2] > hi + 0.75));
  const zAll = piece.map(p => p[2]), width = Math.max(...zAll) - Math.min(...zAll);
  const at = (w: number): V3 => from(0, 0, w);
  const base = { teeth: n, axis, centre: at(mid), pitchRadius: R, width };
  if (below && above) return { ...base, kind: 'double-bevel', tips: [at((mid + hi) / 2 + R), at((mid + lo) / 2 - R)] };
  if (below || above) {
    const s = above ? 1 : -1;
    return { ...base, kind: 'bevel', facing: from(0, 0, s), tip: at(mid + s * R) };
  }
  return { ...base, kind: 'spur' };
}
