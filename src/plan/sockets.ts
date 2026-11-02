import type { Box } from '../ldraw/flatten';
import type { StudConnector } from '../ldraw/connectors';
import type { Snap } from '../ldraw/shadow';

/**
 * The connector geometry a part really has, in its own frame: the sockets it takes a stud
 * in, and the studs it offers. Seating (the drag, the snapper) and the collision verdict
 * both read from here, so they agree on what a socket and a stud are.
 */

/** A part-space point or direction (LDU). */
export type SocketPoint = readonly [number, number, number];

const unit = (v: readonly number[]): SocketPoint => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Underside sockets of a standard part: one per stud cell of its footprint, at its bottom face. */
export function socketsOf(body: Box): SocketPoint[] {
  const w = body.max[0] - body.min[0], d = body.max[2] - body.min[2];
  const nx = Math.round(w / 20), nz = Math.round(d / 20);
  // only parts whose footprint is whole studs have a socket grid we can trust
  if (nx < 1 || nz < 1 || nx * nz > 64 || Math.abs(w - nx * 20) > 2 || Math.abs(d - nz * 20) > 2) return [];
  const x0 = (body.min[0] + body.max[0]) / 2 - (nx - 1) * 10;
  const z0 = (body.min[2] + body.max[2]) / 2 - (nz - 1) * 10;
  const out: SocketPoint[] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) out.push([x0 + i * 20, body.max[1], z0 + j * 20]);
  return out;
}

/**
 * A deep/hollow female stud connector (an anti-stud, a tube, a recessed underside) is a
 * socket a stud may seat in; a thin or non-round hole is not.
 */
const isStudSocket = (s: Snap) => s.kind === 'cyl' && s.length > 0 && s.gender === 'F' && s.shapes.length > 0
  && s.shapes.every((x) => x === 'R' || x === 'S') && Math.abs(s.radius - 6) <= 0.6;

const bottoms = new WeakMap<Float32Array, Map<string, number>>();
/**
 * The underside plane of one stud cell: the lowest point (largest LDraw y) of the
 * part's surface inside the cell, slightly inset so the neighbouring cell's walls
 * do not count. Most cells reach the part's bottom; a recessed one does not — the
 * thick end of curved slope 7302 is a one-plate tongue that seats a plate above
 * the flat bottom, so its socket is a plate higher.
 */
function cellBottom(mesh: Float32Array, cx: number, cz: number, fallback: number): number {
  let cache = bottoms.get(mesh);
  if (!cache) bottoms.set(mesh, (cache = new Map()));
  const key = `${cx},${cz}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const inset = 1.5, x0 = cx - 10 + inset, x1 = cx + 10 - inset, z0 = cz - 10 + inset, z1 = cz + 10 - inset;
  let low = -Infinity;
  for (let i = 0; i + 8 < mesh.length; i += 9) {
    let poly: number[][] = [[mesh[i], mesh[i + 1], mesh[i + 2]], [mesh[i + 3], mesh[i + 4], mesh[i + 5]], [mesh[i + 6], mesh[i + 7], mesh[i + 8]]];
    if (Math.max(...poly.map((v) => v[0])) < x0 || Math.min(...poly.map((v) => v[0])) > x1 ||
      Math.max(...poly.map((v) => v[2])) < z0 || Math.min(...poly.map((v) => v[2])) > z1) continue;
    // clip the triangle to the cell (Sutherland-Hodgman in x/z, carrying y)
    for (const [k, lim, keepBelow] of [[0, x1, true], [0, x0, false], [2, z1, true], [2, z0, false]] as const) {
      const out: number[][] = [];
      const inside = (v: number[]) => (keepBelow ? v[k] <= lim : v[k] >= lim);
      for (let j = 0; j < poly.length; j++) {
        const a = poly[j], b = poly[(j + 1) % poly.length];
        if (inside(a)) out.push(a);
        if (inside(a) !== inside(b)) {
          const t = (lim - a[k]) / (b[k] - a[k]);
          out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
        }
      }
      poly = out;
      if (!poly.length) break;
    }
    for (const v of poly) low = Math.max(low, v[1]);
  }
  // a cell with no surface, or one that reaches the bottom, uses the part's bottom face
  const y = !Number.isFinite(low) || Math.abs(low - fallback) < 0.5 ? fallback : low;
  cache.set(key, y);
  return y;
}

/**
 * Where a part takes a stud, in part space. Shadow-library female stud snaps are exact, so a
 * part that has one (the cutout ear 29120 grips its stud a plate up inside) seats on those;
 * otherwise one socket per stud cell of the footprint, at the height the part's own surface
 * really sits there. `dir` is the way the mating stud comes in.
 */
export function localSockets(part: { body: Box; snaps?: readonly Snap[]; mesh?: Float32Array }): { pos: SocketPoint; dir: SocketPoint }[] {
  const holes = (part.snaps ?? []).filter((s) => s.kind === 'cyl' && s.gender === 'F' && Math.abs(s.radius - 6) < 0.6 &&
    Math.abs(Math.abs(s.axis[1]) - 1) < 1e-3);
  if (holes.length) return holes.map((s) => ({ pos: [...s.start] as SocketPoint, dir: [0, Math.sign(s.axis[1]), 0] as SocketPoint }));
  return footprintSockets(part);
}

const footprintSockets = (part: { body: Box; mesh?: Float32Array }): { pos: SocketPoint; dir: SocketPoint }[] =>
  socketsOf(part.body).map((p) => ({
    pos: [p[0], part.mesh ? cellBottom(part.mesh, p[0], p[2], part.body.max[1]) : p[1], p[2]] as SocketPoint,
    dir: [0, -1, 0] as SocketPoint,
  }));

/**
 * Every socket a part has: the footprint grid (so a cell the shadow library does not cover
 * still counts) plus the shadow library's own. The collision verdict excuses a stud that
 * meets any of them, so seating and overlap never disagree about a legitimate join.
 */
export function allSockets(part: { body: Box; snaps?: readonly Snap[]; mesh?: Float32Array }): { pos: SocketPoint; dir: SocketPoint; radius: number; length?: number }[] {
  const out: { pos: SocketPoint; dir: SocketPoint; radius: number; length?: number }[] = footprintSockets(part).map((s) => ({ ...s, radius: 6 }));
  for (const s of part.snaps ?? []) {
    // a clip takes a bar, whether or not the library models its opening as a round section
    const grip = s.kind === 'clp' && s.gender === 'F';
    if (!grip && (s.kind !== 'cyl' || s.gender !== 'F' || !s.shapes.some((x) => x === 'R'))) continue;
    if (s.length <= 0 || s.radius < 3 || s.radius > 8.6) continue;
    out.push({ pos: [...s.start] as SocketPoint, dir: unit(s.axis), radius: s.radius, length: s.length });
  }
  return out;
}

/**
 * A part's studs: the ones its geometry records as `stud.dat` primitives, plus the shadow
 * library's own male stud snaps. A part that draws its side (SNOT) studs with other
 * primitives — 22885's four side studs — has none in its measured list, and the collision
 * verdict has to know about them or a plate mounted on them reads as four LDU of overlap.
 */
export function studsOf(part: { studs?: readonly StudConnector[]; snaps?: readonly Snap[] }): StudConnector[] {
  const out: StudConnector[] = [...(part.studs ?? [])];
  for (const s of part.snaps ?? []) {
    // the same rule the snap connectors use: a short round male stud
    if (s.kind !== 'cyl' || s.gender !== 'M' || s.length <= 0 || s.length > 8) continue;
    if (!s.shapes.length || !s.shapes.every((x) => x === 'R')) continue;
    if (Math.abs(s.radius - 6) > 0.6) continue;
    const a = unit(s.axis);
    const base = s.start as SocketPoint;
    const tip: SocketPoint = [base[0] + a[0] * s.length, base[1] + a[1] * s.length, base[2] + a[2] * s.length];
    // a top stud can be in both lists; one stud is one stud
    if (out.some((o) => Math.hypot(o.base[0] - base[0], o.base[1] - base[1], o.base[2] - base[2]) < 1)) continue;
    out.push({ base: [base[0], base[1], base[2]], tip: [tip[0], tip[1], tip[2]], radius: s.radius });
  }
  return out;
}

/**
 * Everything a part pokes out of itself with, as columns: its studs (radius 6), its Technic
 * pin shafts (8) and its minifig bars (4). The verdict uses one rule for all of them — a
 * column has to meet a socket of its own family, not a wall — so the three joints behave the
 * same way.
 */
export function columnsOf(part: { body: Box; studs?: readonly StudConnector[]; snaps?: readonly Snap[] }): StudConnector[] {
  const out: StudConnector[] = [...studsOf(part)];
  for (const s of part.snaps ?? []) {
    // a friction grip is the handle a hand closes round: a bar-sized male, not a cylinder
    const grip = s.kind === 'fgr' && s.gender === 'M';
    if (!grip && (s.kind !== 'cyl' || s.gender !== 'M')) continue;
    if (s.length <= 0 || (!grip && !s.shapes.some((x) => x === 'R'))) continue;
    if (grip) {
      const base = s.start as SocketPoint, a = unit(s.axis);
      if (!out.some((o) => Math.hypot(o.base[0] - base[0], o.base[1] - base[1], o.base[2] - base[2]) < 1)) {
        out.push({ base: [base[0], base[1], base[2]], tip: [base[0] + a[0] * s.length, base[1] + a[1] * s.length, base[2] + a[2] * s.length], radius: s.radius });
      }
      continue;
    }
    const stud = Math.abs(s.radius - 6) <= 0.6 && s.length <= 8;
    const pin = Math.abs(s.radius - 8) <= 0.6;
    const bar = Math.abs(s.radius - 4) <= 0.6 && s.length >= 8;
    if (!stud && !pin && !bar) continue;
    const base = s.start as SocketPoint, a = unit(s.axis);
    const tip: SocketPoint = [base[0] + a[0] * s.length, base[1] + a[1] * s.length, base[2] + a[2] * s.length];
    if (out.some((o) => Math.hypot(o.base[0] - base[0], o.base[1] - base[1], o.base[2] - base[2]) < 1)) continue;
    out.push({ base: [base[0], base[1], base[2]], tip: [tip[0], tip[1], tip[2]], radius: s.radius });
  }
  return out;
}
