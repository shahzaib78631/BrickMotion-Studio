import type { Snap } from '../ldraw/shadow';

/**
 * Connector matching from LDCad shadow-library snaps: which placed parts are
 * actually joined (a stud in a socket, a pin in a hole, an axle in a clip, two
 * hinge halves) and along which axis. This is connection knowledge, not a
 * collision waiver: the planner still sweeps the real meshes, it only gives a
 * joined pair the snap-fit allowance and tries the connector axis first.
 */

type V = readonly number[];
export type WorldSnap = { snap: Snap; start: [number, number, number]; axis: [number, number, number] };

/** how far (LDU) two connector axes may be apart and still join: hand-made files are often a unit off */
const AXIS_SLOP = 1.2;
/** axes within ~4° count as the same */
const PARALLEL = Math.cos((4 * Math.PI) / 180);
/** a male may be this much (LDU) thicker than the female it enters (clips and friction pins flex) */
const RADIUS_SLOP = 0.6;

const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Snaps moved by a column-major 4x4 (THREE.Matrix4.elements). */
export function worldSnaps(snaps: Snap[] | undefined, e: V): WorldSnap[] {
  if (!snaps?.length) return [];
  return snaps.map((snap) => {
    const p = snap.start, a = snap.axis;
    const start: [number, number, number] = [
      e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12],
      e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13],
      e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14],
    ];
    const d = [e[0] * a[0] + e[4] * a[1] + e[8] * a[2], e[1] * a[0] + e[5] * a[1] + e[9] * a[2], e[2] * a[0] + e[6] * a[1] + e[10] * a[2]];
    const n = Math.hypot(d[0], d[1], d[2]) || 1;
    return { snap, start, axis: [d[0] / n, d[1] / n, d[2] / n] };
  });
}

/** Whether a male of these shapes/radius fits a female of these. */
function fits(male: Snap, female: Snap): boolean {
  if (female.kind === 'clp') return male.kind === 'cyl' && male.shapes.some((s) => s === 'R' || s.includes('L'));
  // fingers mate only within the same group (or both ungrouped), as LDCad does
  if (male.kind === 'fgr' || female.kind === 'fgr') return male.kind === 'fgr' && female.kind === 'fgr' && (male.group ?? '').toLowerCase() === (female.group ?? '').toLowerCase() && Math.abs(male.radius - female.radius) <= RADIUS_SLOP;
  if (male.kind !== 'cyl' || female.kind !== 'cyl') return false;
  // square sockets only take square plugs; cross-shaped axle holes only take axles
  const fShapes = new Set(female.shapes), mShapes = new Set(male.shapes);
  if (fShapes.size === 1 && fShapes.has('S')) return mShapes.has('S');
  if (mShapes.size === 1 && mShapes.has('S')) return fShapes.has('S');
  if (fShapes.size === 1 && fShapes.has('A')) return mShapes.has('A');
  return male.radius <= female.radius + RADIUS_SLOP || [...mShapes].some((s) => s === 'A');
}

/** The connector axis if `a` and `b` (different parts, world space) are joined, else null. */
export function mateAxis(a: WorldSnap, b: WorldSnap): [number, number, number] | null {
  if (a.snap.kind === 'gen' || b.snap.kind === 'gen') return genericMate(a, b);
  // hinge fingers pair with fingers of the opposite gender offset; everything else male-female
  if (a.snap.gender === b.snap.gender) return null;
  const [male, female] = a.snap.gender === 'M' ? [a, b] : [b, a];
  if (!fits(male.snap, female.snap)) return null;
  const c = dot(male.axis, female.axis);
  if (Math.abs(c) < PARALLEL) return null;
  // distance between the two axis lines (they are parallel)
  const w = [female.start[0] - male.start[0], female.start[1] - male.start[1], female.start[2] - male.start[2]];
  const along = dot(w, male.axis);
  const off = Math.hypot(w[0] - along * male.axis[0], w[1] - along * male.axis[1], w[2] - along * male.axis[2]);
  if (off > AXIS_SLOP) return null;
  // the two segments must meet along the axis (engaged, or at least touching)
  const m0 = 0, m1 = male.snap.length;
  const f0 = along, f1 = along + c * female.snap.length;
  const overlap = Math.min(m1, Math.max(f0, f1)) - Math.max(m0, Math.min(f0, f1));
  if (overlap < -0.5) return null;
  return male.axis;
}

/**
 * SNAP_GEN pairs (a tyre on its rim, a ball in its socket): same group, opposite
 * gender, centred together; cylinders must also share their axis.
 */
function genericMate(a: WorldSnap, b: WorldSnap): [number, number, number] | null {
  if (a.snap.kind !== 'gen' || b.snap.kind !== 'gen' || a.snap.gender === b.snap.gender) return null;
  if (!a.snap.group || a.snap.group.toLowerCase() !== b.snap.group?.toLowerCase()) return null;
  const centre = (s: WorldSnap) => [0, 1, 2].map((k) => s.start[k] + s.axis[k] * s.snap.length / 2);
  const ca = centre(a), cb = centre(b);
  const w = [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]];
  if (a.snap.shapes[0] === 'GEN:cyl') {
    if (Math.abs(dot(a.axis, b.axis)) < PARALLEL) return null;
    const along = dot(w, a.axis);
    const off = Math.hypot(w[0] - along * a.axis[0], w[1] - along * a.axis[1], w[2] - along * a.axis[2]);
    if (off > AXIS_SLOP || Math.abs(along) > (a.snap.length + b.snap.length) / 2 + 0.5) return null;
  } else if (Math.hypot(w[0], w[1], w[2]) > AXIS_SLOP) return null;
  return a.axis;
}

/** Every distinct axis along which two placed parts are joined (empty when not connected). */
export function mateAxes(a: WorldSnap[], b: WorldSnap[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  if (!a.length || !b.length) return out;
  for (const x of a)
    for (const y of b) {
      const axis = mateAxis(x, y);
      if (axis && !out.some((o) => Math.abs(dot(o, axis)) > PARALLEL)) out.push(axis);
    }
  return out;
}

/**
 * For a part the shadow library does not cover (no snaps of its own): it is
 * joined to `other` along any connector of `other` whose whole length lies inside
 * the part's body box, e.g. an exhaust pipe's bar filling a headlight brick's
 * front socket, a stud buried in an uncovered plate, or a pane in its frame's groove.
 */
export function plugAxes(other: WorldSnap[], box: { min: V; max: V }): [number, number, number][] {
  const out: [number, number, number][] = [];
  const inside = (p: V, slack: number) => [0, 1, 2].every((k) => p[k] >= box.min[k] - slack && p[k] <= box.max[k] + slack);
  for (const s of other) {
    // round sockets and studs; grooves (a window frame's slot for its glass)
    if ((s.snap.kind !== 'cyl' && s.snap.kind !== 'fgr') || !(s.snap.length > 0)) continue;
    const slack = s.snap.kind === 'fgr' ? 2 : 0.5;
    // a groove's position is its middle (window and hinge snaps run both ways from it)
    const from = s.snap.kind === 'fgr' ? [0, 1, 2].map((k) => s.start[k] - s.axis[k] * s.snap.length / 2) : s.start;
    const end = [0, 1, 2].map((k) => from[k] + s.axis[k] * s.snap.length);
    if (!inside(from, slack) || !inside(end, slack)) continue;
    // a male points out of its own part, so the joined part arrives against it
    const axis: [number, number, number] = s.snap.gender === 'M' ? [-s.axis[0], -s.axis[1], -s.axis[2]] : s.axis;
    if (!out.some((o) => Math.abs(dot(o, axis)) > PARALLEL)) out.push(axis);
  }
  return out;
}
