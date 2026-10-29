import type { Box } from '../ldraw/flatten';
import type { StudConnector } from '../ldraw/connectors';

/**
 * Half-stud snapping for drags. Parts normally move in whole studs, but some
 * studs sit half a stud off the grid (jumper plates, 2x2 jumpers, offset
 * plates). When a half-stud position would seat the dragged part's underside
 * onto such a stud, the drag uses it, so a 1x1 round plate clicks onto the
 * centre stud of a 1x2 jumper instead of landing beside it.
 *
 * Everything here is in LDraw units (Y down), in one shared frame.
 */

/** A placed part: `world` is the column-major part → frame matrix (16 numbers). */
export type SnapPart = { world: ArrayLike<number>; body: Box; studs?: readonly StudConnector[] };
type P3 = readonly [number, number, number];

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

/** Underside sockets of a standard part: one per stud cell of its footprint, at its bottom face. */
export function socketsOf(body: Box): P3[] {
  const w = body.max[0] - body.min[0], d = body.max[2] - body.min[2];
  const nx = Math.round(w / 20), nz = Math.round(d / 20);
  // only parts whose footprint is whole studs have a socket grid we can trust
  if (nx < 1 || nz < 1 || nx * nz > 64 || Math.abs(w - nx * 20) > 2 || Math.abs(d - nz * 20) > 2) return [];
  const x0 = (body.min[0] + body.max[0]) / 2 - (nx - 1) * 10;
  const z0 = (body.min[2] + body.max[2]) / 2 - (nz - 1) * 10;
  const out: P3[] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) out.push([x0 + i * 20, body.max[1], z0 + j * 20]);
  return out;
}

/** x, z in studs along LDraw X and Z; y in plates, up positive (like plan moves). */
export type StudSnapper = (raw: { x: number; z: number }) => { x: number; y: number; z: number };

/** A seat is only corrected vertically by less than one plate: whole-plate stacks never jump. */
const MAX_LIFT = 7.5;

/**
 * Builds a snapper for one drag. Without a stud fit the result is the plain
 * whole-stud rounding with no height change, so ordinary drags behave exactly
 * as before. With a fit it may use a half-stud spot, and it lifts or lowers a
 * part that sits a fraction of a plate off the stud it lands on.
 */
export function studSnapper(moving: readonly SnapPart[], others: readonly SnapPart[]): StudSnapper {
  // A tilted part has no flat underside to seat.
  const sockets: P3[] = [];
  for (const part of moving) {
    if (Math.abs(part.world[5] - 1) > 1e-3) continue;
    for (const s of socketsOf(part.body)) sockets.push(apply(part.world, s));
  }
  // A stud that another part already covers (a jumper sitting over it) is not free.
  const boxes = others.map((part) => worldBox(part.world, part.body));
  const covered = (p: P3) => boxes.some((b) =>
    p[0] > b.min[0] + 0.5 && p[0] < b.max[0] - 0.5 && p[2] > b.min[2] + 0.5 && p[2] < b.max[2] - 0.5 &&
    p[1] - 2 > b.min[1] + 0.5 && p[1] - 2 < b.max[1] - 0.5);
  const studs: P3[] = [];
  for (const part of others) for (const stud of part.studs ?? []) {
    const p = apply(part.world, stud.base);
    if (sockets.some((s) => Math.abs(p[1] - s[1]) < MAX_LIFT) && !covered(p)) studs.push(p);
  }
  const whole = (raw: { x: number; z: number }) => ({ x: Math.round(raw.x) || 0, y: 0, z: Math.round(raw.z) || 0 });
  if (!sockets.length || !studs.length) return whole;

  /** The best vertical seat at (dx, dz): how many sockets land on a stud, and the LDraw y shift. */
  const seat = (dx: number, dz: number) => {
    const votes = new Map<number, number>();
    for (const s of sockets) {
      const x = s[0] + dx * 20, z = s[2] + dz * 20;
      const lifts = new Set<number>();
      for (const t of studs) {
        if (Math.abs(t[0] - x) < 1.5 && Math.abs(t[2] - z) < 1.5 && Math.abs(t[1] - s[1]) < MAX_LIFT) lifts.add(Math.round((t[1] - s[1]) * 100) / 100);
      }
      for (const l of lifts) votes.set(l, (votes.get(l) ?? 0) + 1);
    }
    let best = { n: 0, dy: 0 };
    for (const [dy, n] of votes) if (n > best.n || (n === best.n && Math.abs(dy) < Math.abs(best.dy))) best = { n, dy };
    return best;
  };
  return (raw) => {
    const base = whole(raw);
    // the whole stud plus the half-stud spots on either side: a free stud within half a stud pulls the part in
    const halves = (v: number) => [...new Set([Math.round(v) || 0, Math.floor(v * 2) / 2 || 0, Math.ceil(v * 2) / 2 || 0])];
    let best = { ...base, ...seat(base.x, base.z) };
    for (const x of halves(raw.x)) for (const z of halves(raw.z)) {
      if (x === base.x && z === base.z) continue;
      const fit = seat(x, z);
      // a half-stud spot must seat more studs than the whole-stud one to win
      if (fit.n > best.n) best = { x, y: 0, z, ...fit };
    }
    // LDraw y is down; plan y is plates up
    return { x: best.x, y: best.n ? -best.dy / 8 || 0 : 0, z: best.z };
  };
}
