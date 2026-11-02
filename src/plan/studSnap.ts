import type { Box } from '../ldraw/flatten';
import type { StudConnector } from '../ldraw/connectors';
import type { Snap } from '../ldraw/shadow';
import { collisionWorld, sampleCount } from './collision';
import { localSockets, socketsOf } from './sockets';

export { socketsOf };

/**
 * Half-stud snapping for drags. Parts normally move in whole studs, but some
 * studs sit half a stud off the grid (jumper plates, 2x2 jumpers, offset
 * plates). When a half-stud position would seat the dragged part's underside
 * onto such a stud, the drag uses it, so a 1x1 round plate clicks onto the
 * centre stud of a 1x2 jumper instead of landing beside it.
 *
 * Sideways parts (studs pointing along X or Z, like the side panels of a
 * BrickHeadz head) seat the same way, along their stud axis: the drag still
 * moves in whole or half studs, then the part is pulled in or pushed out by
 * the fraction of a stud that puts its sockets on the side studs.
 *
 * Everything here is in LDraw units (Y down), in one shared frame.
 */

/** A placed part: `world` is the column-major part → frame matrix (16 numbers). */
/** `mesh` (part-space xyz triangles) lets recessed undersides seat at their real depth. */
export type SnapPart = { world: ArrayLike<number>; body: Box; studs?: readonly StudConnector[]; snaps?: readonly Snap[]; mesh?: Float32Array };
type P3 = readonly [number, number, number];

const vec = (e: ArrayLike<number>, p: readonly number[]): P3 => [
  e[0] * p[0] + e[4] * p[1] + e[8] * p[2],
  e[1] * p[0] + e[5] * p[1] + e[9] * p[2],
  e[2] * p[0] + e[6] * p[1] + e[10] * p[2],
];
const apply = (e: ArrayLike<number>, p: readonly number[]): P3 => [
  e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12],
  e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13],
  e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14],
];

function worldBox(e: ArrayLike<number>, body: Box): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const x of [body.min[0], body.max[0]]) for (const y of [body.min[1], body.max[1]]) for (const z of [body.min[2], body.max[2]]) {
    const p = apply(e, [x, y, z]);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
  }
  return { min, max };
}

/**
 * x, z in studs along LDraw X and Z; y in plates, up positive (like plan moves).
 * `raw.y` is a vertical drag in studs (world up). It only matters for a sideways
 * selection, whose stud rows are a stud apart vertically: `sideways` is then true
 * and the returned y carries the whole move, so callers must not add their own
 * plate-rounded lift.
 */
export type StudSnapper = ((raw: { x: number; z: number; y?: number }) => { x: number; y: number; z: number }) & { sideways?: boolean };

/** A seat is only corrected vertically by less than one plate: whole-plate stacks never jump. */
const MAX_LIFT = 7.5;
/** Along a sideways axis the drag itself moves in studs, so any seat within half a stud is the nearest one. */
const MAX_SIDE_LIFT = 10;
/**
 * A sideways part is pulled onto the nearest seat within this distance (LDU, per axis) of
 * where it is dragged. A seat is often a plate (8 LDU) off the stud grid, so a drag of about
 * a stud toward it must still land on it instead of rounding into the model.
 */
const SIDE_MAGNET = 14;
/** How far (LDU) a blocked sideways drag may look for a free seat instead. */
const SIDE_REACH = 30;

/**
 * A connection point of the selection in the shared frame: a socket (where a stud's base
 * meets it) or a stud base, and the way that stud points (unit, axis-aligned).
 */
type Socket = { p: P3; up: P3; axis: 0 | 1 | 2; kind: 'socket' | 'stud' };

/** Stud sockets of a part, in its own frame, at the height its surface really sits. */
const socketsInPart = (part: SnapPart): { p: P3; up: P3 }[] =>
  localSockets({ body: part.body, snaps: part.snaps, mesh: part.mesh }).map((s) => ({ p: s.pos, up: s.dir }));

/**
 * Tests whether a selection, shifted by an LDraw offset, would sink its body into another
 * part. A thin wrapper over the collision world (see collision.ts), without the stud test:
 * this snapper seats sideways parts by their own connectors (`seat`/`magnet`), where a stud
 * reaching under a neighbour is the seat it is aiming for, not an overlap.
 */
export function overlapTest(moving: readonly SnapPart[], others: readonly SnapPart[]): ((shift: readonly number[]) => boolean) | null {
  if (moving.some((p) => !p.mesh)) return null;
  const world = collisionWorld(others.map((o, i) => ({ ...o, id: String(i) })));
  const mine = moving.map((m) => ({ ...m, id: 'moving' }));
  if (!sampleCount(mine)) return null;
  return (shift) => world.hits(mine, shift, false).size > 0;
}

/** The world axis a unit vector lies along, or -1 when it is tilted. */
function axisOf(v: P3): 0 | 1 | 2 | -1 {
  for (const k of [0, 1, 2] as const) if (Math.abs(Math.abs(v[k]) - 1) < 1e-3) return k;
  return -1;
}

/**
 * Builds a snapper for one drag. Without a stud fit the result is the plain
 * whole-stud rounding with no height change, so ordinary drags behave exactly
 * as before. With a fit it may use a half-stud spot, and it lifts or lowers a
 * part that sits a fraction of a plate off the stud it lands on; a sideways
 * part is moved the same fraction along its stud axis instead.
 */
export function studSnapper(moving: readonly SnapPart[], others: readonly SnapPart[]): StudSnapper {
  /** Unit direction of a stud (base → tip) in the shared frame, with its base point. */
  const studIn = (part: SnapPart, stud: StudConnector): { p: P3; dir: P3 } | null => {
    const p = apply(part.world, stud.base), tip = apply(part.world, stud.tip);
    const d = [tip[0] - p[0], tip[1] - p[1], tip[2] - p[2]], len = Math.hypot(d[0], d[1], d[2]);
    return len < 1e-6 ? null : { p, dir: [d[0] / len, d[1] / len, d[2] / len] };
  };
  /** World sockets of a part; a tilted part has no square underside to seat. */
  const socketsIn = (part: SnapPart): { p: P3; dir: P3 }[] => socketsInPart(part).flatMap((s) => {
    const dir = vec(part.world, s.up);
    return axisOf(dir) === -1 ? [] : [{ p: apply(part.world, s.p), dir }];
  });
  // What the selection can connect with: its sockets onto other parts' studs, and its
  // own studs up into other parts' sockets (a 1x1 plate under a curved slope).
  const sockets: Socket[] = [];
  for (const part of moving) {
    for (const s of socketsIn(part)) sockets.push({ p: s.p, up: s.dir, axis: axisOf(s.dir) as 0 | 1 | 2, kind: 'socket' });
    for (const stud of part.studs ?? []) {
      const s = studIn(part, stud), axis = s ? axisOf(s.dir) : -1;
      if (s && axis !== -1) sockets.push({ p: s.p, up: s.dir, axis, kind: 'stud' });
    }
  }
  // the drag never changes height, so for an upright selection a target must already be within a lift
  const near = (p: P3, dir: P3, kind: Socket['kind']) => sockets.some((s) => s.kind === kind &&
    s.up[0] * dir[0] + s.up[1] * dir[1] + s.up[2] * dir[2] > 0.999 && (s.axis !== 1 || Math.abs(p[1] - s.p[1]) < MAX_LIFT));
  // A stud that another part already covers (a jumper sitting over it) is not free.
  const boxes = others.map((part) => worldBox(part.world, part.body));
  const covered = (p: P3, dir: P3) => {
    const q = [p[0] + 2 * dir[0], p[1] + 2 * dir[1], p[2] + 2 * dir[2]];
    return boxes.some((b) => [0, 1, 2].every((k) => q[k] > b.min[k] + 0.5 && q[k] < b.max[k] - 0.5));
  };
  const studs: { p: P3; dir: P3 }[] = [];
  const otherStuds: { p: P3; dir: P3 }[] = [];
  for (const part of others) for (const stud of part.studs ?? []) {
    const t = studIn(part, stud);
    if (!t) continue;
    otherStuds.push(t);
    if (near(t.p, t.dir, 'socket') && !covered(t.p, t.dir)) studs.push(t);
  }
  // A socket already filled by another part's stud is not free.
  const holes: { p: P3; dir: P3 }[] = [];
  for (const part of others) for (const t of socketsIn(part)) {
    const filled = otherStuds.some((o) => Math.hypot(o.p[0] - t.p[0], o.p[1] - t.p[1], o.p[2] - t.p[2]) < 1 &&
      o.dir[0] * t.dir[0] + o.dir[1] * t.dir[1] + o.dir[2] * t.dir[2] > 0.999);
    if (!filled && near(t.p, t.dir, 'stud')) holes.push(t);
  }
  // every socket points along X or Z: its stud rows are a stud apart vertically
  const sideways = sockets.length > 0 && sockets.every((sk) => sk.axis !== 1);
  const whole: StudSnapper = (raw) => ({
    x: Math.round(raw.x) || 0,
    y: sideways ? (Math.round(raw.y ?? 0) * 20) / 8 || 0 : 0,
    z: Math.round(raw.z) || 0,
  });
  whole.sideways = sideways;
  if (!sockets.length || (!studs.length && !holes.length)) return whole;

  type Fit = { n: number; axis: number; d: number; vy: number };
  /**
   * The best seat at (dx, dy, dz) (studs; dy in LDraw y): how many sockets land on a stud,
   * the shift along the stud axis, and for a sideways part the vertical shift onto its stud row (LDraw).
   */
  const seat = (dx: number, dyLdu: number, dz: number): Fit => {
    const votes = new Map<string, Fit>();
    for (const sk of sockets) {
      const at = [sk.p[0] + dx * 20, sk.p[1] + dyLdu, sk.p[2] + dz * 20];
      const limit = sk.axis === 1 ? MAX_LIFT : MAX_SIDE_LIFT;
      const fits = new Map<string, { d: number; vy: number }>();
      for (const t of sk.kind === 'socket' ? studs : holes) {
        if (sk.up[0] * t.dir[0] + sk.up[1] * t.dir[1] + sk.up[2] * t.dir[2] < 0.999) continue;
        const off = [t.p[0] - at[0], t.p[1] - at[1], t.p[2] - at[2]];
        // a sideways socket may slide up or down onto the nearest stud row; other directions must line up
        const ok = [0, 1, 2].every((k) => k === sk.axis ||
          (sk.axis !== 1 && k === 1 ? Math.abs(off[k]) < MAX_SIDE_LIFT : Math.abs(off[k]) < 1.5));
        if (!ok || Math.abs(off[sk.axis]) >= limit) continue;
        const d = Math.round(off[sk.axis] * 100) / 100, vy = sk.axis !== 1 ? Math.round(off[1] * 100) / 100 : 0;
        fits.set(`${d}:${vy}`, { d, vy });
      }
      for (const f of fits.values()) {
        const key = `${sk.axis}:${f.d}:${f.vy}`, v = votes.get(key) ?? { n: 0, axis: sk.axis, ...f };
        v.n++;
        votes.set(key, v);
      }
    }
    let best: Fit = { n: 0, axis: 1, d: 0, vy: 0 };
    const size = (f: Fit) => Math.abs(f.d) + Math.abs(f.vy);
    for (const v of votes.values()) if (v.n > best.n || (v.n === best.n && size(v) < size(best))) best = v;
    return best;
  };
  /** Plan move (x, z in studs, y in plates up) for a whole/half-stud spot plus its seat shift. */
  const move = (x: number, dyLdu: number, z: number, fit: Fit) => {
    // LDraw y is down; plan y is plates up
    const plates = (ldu: number) => Math.round((-ldu / 8) * 1000) / 1000 || 0;
    if (!fit.n) return { x, y: plates(dyLdu), z };
    if (fit.axis === 1) return { x, y: -fit.d / 8 || 0, z };
    const shift = Math.round((fit.d / 20) * 1000) / 1000;
    const y = plates(dyLdu + fit.vy);
    return fit.axis === 0 ? { x: x + shift || 0, y, z } : { x, y, z: z + shift || 0 };
  };
  // Every exact seat of a sideways selection: the shift (LDU) that puts a connection point on a
  // matching target, with how many points that same shift seats.
  const seats = new Map<string, { s: number[]; n: number }>();
  if (sideways) {
    for (const sk of sockets) {
      const shifts = new Set<string>();
      for (const t of sk.kind === 'socket' ? studs : holes) {
        if (sk.up[0] * t.dir[0] + sk.up[1] * t.dir[1] + sk.up[2] * t.dir[2] < 0.999) continue;
        const sh = [0, 1, 2].map((k) => Math.round((t.p[k] - sk.p[k]) * 100) / 100);
        shifts.add(sh.join(','));
      }
      for (const key of shifts) {
        const v = seats.get(key) ?? { s: key.split(',').map(Number), n: 0 };
        v.n++;
        seats.set(key, v);
      }
    }
  }
  /** The best seat near a sideways drag (LDraw shift), or null. */
  const magnet = (raw: { x: number; z: number; y?: number }) => {
    const want = [raw.x * 20, -(raw.y ?? 0) * 20, raw.z * 20];
    let best: { s: number[]; n: number; far: number } | null = null;
    for (const v of seats.values()) {
      const far = Math.max(...[0, 1, 2].map((k) => Math.abs(v.s[k] - want[k])));
      // up and down already move a whole stud row, so only the nearest row is in reach
      if (far > SIDE_MAGNET || Math.abs(v.s[1] - want[1]) > MAX_SIDE_LIFT || !free(v.s)) continue;
      if (!best || v.n > best.n || (v.n === best.n && far < best.far)) best = { ...v, far };
    }
    return best;
  };
  const blocked = sideways ? overlapTest(moving, others) : null;
  const free = (s: readonly number[]) => !blocked || !blocked(s);
  /** LDraw shift of a plan move (x, z in studs, y in plates up). */
  const ldu = (m: { x: number; y: number; z: number }) => [m.x * 20, -m.y * 8, m.z * 20];
  const toMove = (s: readonly number[]) => {
    const r = (v: number) => Math.round(v * 1000) / 1000 || 0;
    return { x: r(s[0] / 20), y: r(-s[1] / 8), z: r(s[2] / 20) };
  };
  const snapper: StudSnapper = (raw) => {
    const out = pick(raw);
    if (!blocked || free(ldu(out))) return out;
    // the drag would sink the part into the model: take the nearest free seat instead,
    // else keep it where it is
    const want = [raw.x * 20, -(raw.y ?? 0) * 20, raw.z * 20];
    let best: { s: number[]; far: number; n: number } | null = null;
    for (const v of seats.values()) {
      const far = Math.max(...[0, 1, 2].map((k) => Math.abs(v.s[k] - want[k])));
      if (far > SIDE_REACH || !free(v.s)) continue;
      if (!best || far < best.far - 1e-6 || (Math.abs(far - best.far) < 1e-6 && v.n > best.n)) best = { ...v, far };
    }
    if (best) return toMove(best.s);
    return free([0, 0, 0]) ? { x: 0, y: 0, z: 0 } : out;
  };
  const pick = (raw: { x: number; z: number; y?: number }) => {
    const near = sideways ? magnet(raw) : null;
    if (near) {
      const r = (v: number) => Math.round(v * 1000) / 1000 || 0;
      return { x: r(near.s[0] / 20), y: r(-near.s[1] / 8), z: r(near.s[2] / 20) };
    }
    const base = whole(raw);
    // a sideways part moves up and down in whole studs, its stud pitch
    const dyLdu = sideways ? -Math.round(raw.y ?? 0) * 20 : 0;
    // the whole stud plus the half-stud spots on either side: a free stud within half a stud pulls the part in
    const halves = (v: number) => [...new Set([Math.round(v) || 0, Math.floor(v * 2) / 2 || 0, Math.ceil(v * 2) / 2 || 0])];
    let best = { x: base.x, z: base.z, fit: seat(base.x, dyLdu, base.z) };
    for (const x of halves(raw.x)) for (const z of halves(raw.z)) {
      if (x === base.x && z === base.z) continue;
      const fit = seat(x, dyLdu, z);
      // a half-stud spot must seat more studs than the whole-stud one to win
      if (fit.n > best.fit.n) best = { x, z, fit };
    }
    return move(best.x, dyLdu, best.z, best.fit);
  };
  snapper.sideways = sideways;
  return snapper;
}
