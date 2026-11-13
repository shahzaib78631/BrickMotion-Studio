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

/** The round pin of a hinge brick (6.5 LDU, longer than a stud) or the knuckle hole it turns in. */
export const isHingePin = (s: Snap) => s.kind === 'cyl' && s.length >= 8 && s.radius > 6.25 && s.radius <= 7 && s.shapes.some((x) => x === 'R');

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
 * The underside tubes: one at the centre of every 2 x 2 group of footprint sockets on one plane. A
 * stud fits inside a tube — a jumper plate's centre stud, or any half-stud offset, seats there — so
 * the collision verdict must not read it as a stud poking into the part.
 */
function tubeSockets(grid: readonly { pos: SocketPoint; dir: SocketPoint }[]): { pos: SocketPoint; dir: SocketPoint; radius: number }[] {
  const at = new Map(grid.map((s) => [`${s.pos[0]},${s.pos[2]}`, s.pos[1]]));
  const out: { pos: SocketPoint; dir: SocketPoint; radius: number }[] = [];
  for (const s of grid) {
    const [x, y, z] = s.pos;
    const corners = [at.get(`${x + 20},${z}`), at.get(`${x},${z + 20}`), at.get(`${x + 20},${z + 20}`)];
    if (corners.some((c) => c === undefined || Math.abs(c - y) > 0.5)) continue;
    out.push({ pos: [x + 10, y, z + 10], dir: s.dir, radius: 6 });
  }
  return out;
}

/**
 * A 1-wide row of stud sockets also takes a stud midway between two of them: the underside of a
 * 1 x 2 plate (or a bracket's inverted face) holds a jumper's centre stud between its slots. Only
 * where no row runs alongside — in a 2-wide part that spot is a tube's wall.
 */
function rowSockets(mouths: readonly { pos: SocketPoint; dir: SocketPoint }[]): { pos: SocketPoint; dir: SocketPoint; radius: number }[] {
  const out: { pos: SocketPoint; dir: SocketPoint; radius: number }[] = [];
  const same = (a: SocketPoint, b: SocketPoint, eps = 0.5) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps && Math.abs(a[2] - b[2]) < eps;
  const has = (p: SocketPoint, dir: SocketPoint) => mouths.some((m) => same(m.pos, p) && same(m.dir, dir, 0.05));
  for (let i = 0; i < mouths.length; i++) for (let j = i + 1; j < mouths.length; j++) {
    const a = mouths[i], b = mouths[j];
    if (!same(a.dir, b.dir, 0.05)) continue;
    const d: SocketPoint = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]];
    if (Math.abs(Math.hypot(...d) - 20) > 0.5) continue;
    // the row runs along d, square to the opening
    if (Math.abs(d[0] * a.dir[0] + d[1] * a.dir[1] + d[2] * a.dir[2]) > 0.5) continue;
    // across the row, in the plane of the openings
    const n = a.dir;
    const across: SocketPoint = [(n[1] * d[2] - n[2] * d[1]) / 20, (n[2] * d[0] - n[0] * d[2]) / 20, (n[0] * d[1] - n[1] * d[0]) / 20];
    const beside = [1, -1].some((k) => [a, b].some((m) => has([m.pos[0] + k * 20 * across[0], m.pos[1] + k * 20 * across[1], m.pos[2] + k * 20 * across[2]], m.dir)));
    if (beside) continue;
    const mid: SocketPoint = [a.pos[0] + d[0] / 2, a.pos[1] + d[1] / 2, a.pos[2] + d[2] / 2];
    // the grid and the shadow library often list the same socket twice
    if (out.some((o) => same(o.pos, mid) && same(o.dir, a.dir, 0.05))) continue;
    out.push({ pos: mid, dir: a.dir, radius: 6 });
  }
  return out;
}

/**
 * Every socket a part has: the footprint grid (so a cell the shadow library does not cover
 * still counts) plus the shadow library's own. The collision verdict excuses a stud that
 * meets any of them, so seating and overlap never disagree about a legitimate join.
 */
export function allSockets(part: { body: Box; snaps?: readonly Snap[]; mesh?: Float32Array }): { pos: SocketPoint; dir: SocketPoint; radius: number; length?: number }[] {
  const grid = footprintSockets(part);
  const out: { pos: SocketPoint; dir: SocketPoint; radius: number; length?: number }[] = grid.map((s) => ({ ...s, radius: 6 }));
  out.push(...tubeSockets(grid));
  const mouths: { pos: SocketPoint; dir: SocketPoint }[] = grid.map((g) => ({ pos: g.pos, dir: g.dir }));
  for (const s of part.snaps ?? []) {
    // a clip takes a bar, whether or not the library models its opening as a round section
    // a clip, or a finger hinge's female knuckles, takes a bar-sized column
    const grip = (s.kind === 'clp' || s.kind === 'fgr') && s.gender === 'F';
    // An underside anti-stud is often modelled square ("S"), not round. A bracket's plate
    // (44728) has no whole-stud footprint grid to fall back on, so it needs these. Like the
    // footprint sockets they take a stud at the mouth only.
    if (!grip && isStudSocket(s) && !s.shapes.includes('R')) {
      out.push({ pos: [...s.start] as SocketPoint, dir: unit(s.axis), radius: s.radius });
      mouths.push({ pos: [...s.start] as SocketPoint, dir: unit(s.axis) });
      continue;
    }
    if (!grip && (s.kind !== 'cyl' || s.gender !== 'F' || !s.shapes.some((x) => x === 'R'))) continue;
    if (s.length <= 0 || s.radius < 3 || s.radius > 8.6) continue;
    out.push({ pos: [...s.start] as SocketPoint, dir: unit(s.axis), radius: s.radius, length: s.length });
  }
  out.push(...rowSockets(mouths));
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
    if (!stud && !pin && !bar && !isHingePin(s)) continue;
    const base = s.start as SocketPoint, a = unit(s.axis);
    const tip: SocketPoint = [base[0] + a[0] * s.length, base[1] + a[1] * s.length, base[2] + a[2] * s.length];
    if (out.some((o) => Math.hypot(o.base[0] - base[0], o.base[1] - base[1], o.base[2] - base[2]) < 1)) continue;
    out.push({ base: [base[0], base[1], base[2]], tip: [tip[0], tip[1], tip[2]], radius: s.radius });
  }
  return out;
}

/**
 * Every shaft a part can put into a hole: its columns plus axles (a cross section, "A", that
 * `columnsOf` leaves out because an axle never pokes as a stud does). The collision verdict opens a
 * bore that one of these lies on, so an axle through a connector is not read as overlap.
 */
export function shaftsOf(part: { body: Box; studs?: readonly StudConnector[]; snaps?: readonly Snap[] }): StudConnector[] {
  const out: StudConnector[] = [...columnsOf(part)];
  for (const s of part.snaps ?? []) {
    if (s.kind !== 'cyl' || s.gender !== 'M' || s.length <= 0 || s.radius < 3 || s.radius > 8.6) continue;
    const base = s.start as SocketPoint, a = unit(s.axis);
    if (out.some((o) => Math.hypot(o.base[0] - base[0], o.base[1] - base[1], o.base[2] - base[2]) < 1 && o.radius === s.radius)) continue;
    out.push({ base: [base[0], base[1], base[2]], tip: [base[0] + a[0] * s.length, base[1] + a[1] * s.length, base[2] + a[2] * s.length], radius: s.radius });
  }
  return out;
}
