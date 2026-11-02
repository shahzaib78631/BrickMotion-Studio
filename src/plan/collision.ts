import type { Box } from '../ldraw/flatten';
import type { StudConnector } from '../ldraw/connectors';
import type { Instance, Metrics } from '../model/assemble';
import type { Snap } from '../ldraw/shadow';
import type { SnapPart } from './studSnap';
import { allSockets, columnsOf, studsOf } from './sockets';

/**
 * Which pieces a moved selection would sit inside. Points sampled through the moving parts'
 * bodies are tested against the other parts' meshes, column by column, with a little slack so
 * parts that only touch pass. Studs are solid as well, and are tested as shafts against the
 * other pieces' bodies: a stud counts as seated only where an opposing socket is waiting for
 * it, and anywhere else it is in the way. That is what stops a piece from sliding its studs
 * through a neighbour, or standing on one with its studs buried. Everything is in LDU, one
 * frame. `guardEdit` and the drag engine both ask this world, so they agree.
 */

/** A placed part, tagged with its top-level plan item id (a submodel use's parts share its id). */
export type Solid = SnapPart & { id: string };
export type CollisionWorld = {
  /**
   * ids of the world's solids that `moving` would penetrate. `transform` places the
   * moving set: a column-major 4x4 (LDU matrix), or a 3-number LDU shift. `studs` adds
   * the stud test (see the module comment); it defaults to on, and only a caller with its
   * own stud seating (the sideways snapper) turns it off.
   */
  hits(moving: readonly Solid[], transform?: ArrayLike<number>, studs?: boolean): Set<string>;
};

type P3 = readonly [number, number, number];
const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const apply = (e: ArrayLike<number>, p: readonly number[]): P3 => [
  e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12],
  e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13],
  e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14],
];
const vector = (e: ArrayLike<number>, p: readonly number[]): P3 => [
  e[0] * p[0] + e[4] * p[1] + e[8] * p[2],
  e[1] * p[0] + e[5] * p[1] + e[9] * p[2],
  e[2] * p[0] + e[6] * p[1] + e[10] * p[2],
];
const unit = (v: readonly number[]): P3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** `a ∘ b`: what `b` does, then `a` (both column-major 4x4 element arrays). */
function compose(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += a[k * 4 + row] * b[col * 4 + k];
    out[col * 4 + row] = v;
  }
  return out;
}
const LINEAR_IDENTITY = (m: ArrayLike<number>) => m[0] === 1 && m[5] === 1 && m[10] === 1 &&
  m[1] === 0 && m[2] === 0 && m[4] === 0 && m[6] === 0 && m[8] === 0 && m[9] === 0;
const isIdentity = (m: ArrayLike<number>) => LINEAR_IDENTITY(m) && m[12] === 0 && m[13] === 0 && m[14] === 0;
const isShift = (m: ArrayLike<number>) => LINEAR_IDENTITY(m);
/** The transform a caller hands in: a column-major matrix, or a 3-number LDU shift. */
function asMatrix(transform?: ArrayLike<number>): ArrayLike<number> {
  if (!transform) return IDENTITY;
  if (transform.length !== 3) return transform;
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, transform[0], transform[1], transform[2], 1];
}

function worldBox(e: ArrayLike<number>, body: Box): Box {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const x of [body.min[0], body.max[0]]) for (const y of [body.min[1], body.max[1]]) for (const z of [body.min[2], body.max[2]]) {
    const p = apply(e, [x, y, z]);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
  }
  return { min: min as unknown as [number, number, number], max: max as unknown as [number, number, number] };
}
const unionBox = (a: Box, b: Box): Box => ({
  min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
  max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
});
const boxesTouch = (a: Box, b: Box, margin = 0) =>
  [0, 1, 2].every((k) => a.min[k] <= b.max[k] + margin && b.min[k] <= a.max[k] + margin);

/** A stud in the shared frame, and the same stud in its own part (for the seat test). */
type Stud = { local: StudConnector; base: P3; axis: P3; radius: number };
function worldStuds(e: ArrayLike<number>, studs?: readonly StudConnector[]): Stud[] {
  return (studs ?? []).map((local) => {
    const base = apply(e, local.base), tip = apply(e, local.tip);
    return { local, base, axis: unit([tip[0] - base[0], tip[1] - base[1], tip[2] - base[2]]), radius: local.radius };
  });
}
/** The box a set of studs fills, so studs far from the moving set cost nothing. */
function studBox(studs: readonly Stud[]): Box | null {
  let out: Box | null = null;
  for (const st of studs) {
    const b: Box = {
      min: [st.base[0] - st.radius, st.base[1] - st.radius, st.base[2] - st.radius],
      max: [st.base[0] + st.radius, st.base[1] + st.radius, st.base[2] + st.radius],
    };
    out = out ? unionBox(out, b) : b;
  }
  return out;
}
/**
 * Whether a stud reaches into a box: the point two LDU along its shaft must be inside the
 * box, and the shaft must pass its sides within the stud's radius. A stud that only meets
 * the face is not in. Deliberately a box test — the mesh test treats a hollow as filled, so
 * it cannot tell a stud in an open cavity from one buried in a wall, and a stud has to meet
 * a socket either way.
 */
function studInBox(st: Stud, box: Box): boolean {
  const a = st.axis;
  const along = a[0] * a[0] >= a[1] * a[1] && a[0] * a[0] >= a[2] * a[2] ? 0 : a[1] * a[1] >= a[2] * a[2] ? 1 : 2;
  for (let i = 0; i < 3; i++) {
    const v = st.base[i] + 2 * a[i];
    if (i === along) {
      if (!(v > box.min[i] + 0.5 && v < box.max[i] - 0.5)) return false;
    } else if (!(v > box.min[i] - (st.radius - 0.5) && v < box.max[i] + (st.radius - 0.5))) return false;
  }
  return true;
}

/**
 * A bore: the column of a female round snap — a Technic pin's hole, a minifig hand's grip, a
 * scabbard's peg hole, and the hollow inside a stud. Material inside a bore is something
 * inserted in the hole (a bar, a stud, a pin), not a collision, so the narrow phase skips it.
 */
type Bore = { base: P3; axis: P3; radius: number; length: number; /** a clip grips any bar-sized column */ grip: boolean };
const worldBores = (e: ArrayLike<number>, snaps?: readonly Snap[]): Bore[] => {
  const out: Bore[] = [];
  for (const s of snaps ?? []) {
    // a clip's opening is not modelled as a round section, but a bar goes in it all the same
    const grip = s.kind === 'clp' && s.gender === 'F';
    if (!grip && (s.kind !== 'cyl' || s.gender !== 'F' || !s.shapes.some((x) => x === 'R'))) continue;
    if (s.length <= 0 || s.radius < 3 || s.radius > 8.6) continue;
    out.push({ base: apply(e, s.start), axis: unit(vector(e, s.axis)), radius: s.radius, length: s.length, grip });
  }
  return out;
};
/** Whether a shared-frame point is inside a bore, half an LDU inside its wall. */
const inBore = (b: Bore, p: P3) => {
  const d = [p[0] - b.base[0], p[1] - b.base[1], p[2] - b.base[2]];
  const t = d[0] * b.axis[0] + d[1] * b.axis[1] + d[2] * b.axis[2];
  if (t < -0.5 || t > b.length + 0.5) return false;
  const radial = [d[0] - t * b.axis[0], d[1] - t * b.axis[1], d[2] - t * b.axis[2]];
  return radial[0] ** 2 + radial[1] ** 2 + radial[2] ** 2 < (b.radius - 0.5) ** 2;
};

/** A socket in the shared frame: where a column's base meets it, the way it opens, and its bore. */
type Socket = { pos: P3; axis: P3; radius: number; /** a shadow bore: it takes its column at any depth */ length?: number };
type HasSockets = { body: Box; snaps?: readonly Snap[]; mesh?: Float32Array };
/** A part's own studs (radius 6), the only columns the box intrusion rule is safe for. */
const studCache = new WeakMap<HasSockets, readonly StudConnector[]>();
const localStuds = (part: HasSockets): readonly StudConnector[] => {
  let own = studCache.get(part);
  if (!own) studCache.set(part, (own = studsOf(part)));
  return own;
};
/** Every column a part pokes out from itself (studs, pin shafts, bars), for bore seating. */
const columnCache = new WeakMap<HasSockets, readonly StudConnector[]>();
const localColumns = (part: HasSockets): readonly StudConnector[] => {
  let own = columnCache.get(part);
  if (!own) columnCache.set(part, (own = columnsOf(part)));
  return own;
};
/** A part's own sockets, worked out once per part: the drag asks again per candidate pose. */
const socketCache = new WeakMap<HasSockets, readonly { pos: P3; dir: P3; radius: number; length?: number }[]>();
const worldSockets = (e: ArrayLike<number>, part: HasSockets): Socket[] => {
  let own = socketCache.get(part);
  if (!own) socketCache.set(part, (own = allSockets(part)));
  return own.map((s) => ({ pos: apply(e, s.pos), axis: unit(vector(e, s.dir)), radius: s.radius, ...(s.length === undefined ? {} : { length: s.length }) }));
};

/**
 * Whether a socket of the same family is waiting for this column. A socket with a bore takes
 * the column at any depth along its line — a pin slid half way into a Technic hole is seated
 * — while a plain socket takes it at its mouth. Either way the walls are around the column,
 * not in front of it, so it is not a poke.
 */
const seatedIn = (st: Stud, sockets: readonly Socket[]) => sockets.some((c) => {
  if (Math.abs(c.radius - st.radius) > 0.7 || Math.abs(dot(c.axis, st.axis)) < 0.999) return false;
  const d = [st.base[0] - c.pos[0], st.base[1] - c.pos[1], st.base[2] - c.pos[2]];
  if (c.length === undefined) return Math.hypot(d[0], d[1], d[2]) < 1;
  const along = dot(d, c.axis);
  return Math.hypot(d[0] - along * c.axis[0], d[1] - along * c.axis[1], d[2] - along * c.axis[2]) <= 1.5;
});

/**
 * The bores a moving column is actually in: only those may be ignored by the mesh test. A
 * through-hole takes the column at any depth (a pin slid half way in is seated), so the test
 * is "on the bore's line and along its axis", not "at its mouth".
 */
const takenBores = (bores: readonly Bore[], columns: readonly Stud[]) => bores.filter((b) => columns.some((m) => {
  // a clip holds a bar of any size — a hand grips a 3 LDU tool shaft as readily as a 4 LDU bar
  const fits = b.grip ? m.radius <= 4.6 && m.radius >= 2.2 : Math.abs(m.radius - b.radius) <= 0.7;
  if (!fits || Math.abs(dot(m.axis, b.axis)) < 0.999) return false;
  const d = [m.base[0] - b.base[0], m.base[1] - b.base[1], m.base[2] - b.base[2]];
  const along = dot(d, b.axis);
  const off = Math.hypot(d[0] - along * b.axis[0], d[1] - along * b.axis[1], d[2] - along * b.axis[2]);
  return off <= 1.5;
}));

/** Triangles bucketed by the 4 LDU cell their shadow covers, per mesh and per line axis. */
const TRI_CELL = 4;
const NO_TRIS: number[] = [];
const triIndex = new WeakMap<Float32Array, (Map<number, number[]> | undefined)[]>();
const cellOf = (a: number, b: number) => (Math.floor(a / TRI_CELL) + 32768) * 65536 + (Math.floor(b / TRI_CELL) + 32768);
/** Offsets (into `mesh`) of the triangles whose shadow on the plane across `axis` may cover (x, z). */
function trianglesNear(mesh: Float32Array, axis: 0 | 1 | 2, x: number, z: number): number[] {
  let perAxis = triIndex.get(mesh);
  if (!perAxis) triIndex.set(mesh, (perAxis = []));
  let cells = perAxis[axis];
  if (!cells) {
    cells = perAxis[axis] = new Map();
    const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    for (let t = 0; t + 8 < mesh.length; t += 9) {
      const a0 = Math.min(mesh[t + i], mesh[t + 3 + i], mesh[t + 6 + i]) - 1e-3, a1 = Math.max(mesh[t + i], mesh[t + 3 + i], mesh[t + 6 + i]) + 1e-3;
      const b0 = Math.min(mesh[t + j], mesh[t + 3 + j], mesh[t + 6 + j]) - 1e-3, b1 = Math.max(mesh[t + j], mesh[t + 3 + j], mesh[t + 6 + j]) + 1e-3;
      for (let ca = Math.floor(a0 / TRI_CELL); ca <= Math.floor(a1 / TRI_CELL); ca++)
        for (let cb = Math.floor(b0 / TRI_CELL); cb <= Math.floor(b1 / TRI_CELL); cb++) {
          const k = (ca + 32768) * 65536 + (cb + 32768), list = cells.get(k);
          if (list) list.push(t); else cells.set(k, [t]);
        }
    }
  }
  return cells.get(cellOf(x, z)) ?? NO_TRIS;
}

const spans = new WeakMap<Float32Array, Map<string, [number, number] | null>>();
/**
 * The range a part's mesh fills along one local axis through the line at the other two
 * coordinates of `q`, kept to its body, or null. Hollows between surfaces count as filled,
 * so callers test all three axes: a point is inside a part only when every axis agrees.
 */
function lineSpan(mesh: Float32Array, body: Box, axis: 0 | 1 | 2, q: readonly number[]): [number, number] | null {
  let cache = spans.get(mesh);
  if (!cache) spans.set(mesh, (cache = new Map()));
  const [i, j] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const x = Math.round(q[i] * 2) / 2, z = Math.round(q[j] * 2) / 2;
  const key = `${axis}:${x},${z}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let lo = Infinity, hi = -Infinity;
  for (const t of trianglesNear(mesh, axis, x, z)) {
    const ax = mesh[t + i], az = mesh[t + j], bx = mesh[t + 3 + i], bz = mesh[t + 3 + j], cx = mesh[t + 6 + i], cz = mesh[t + 6 + j];
    const area = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
    if (Math.abs(area) < 1e-6) continue;
    const u = ((bx - x) * (cz - z) - (cx - x) * (bz - z)) / area;
    const v = ((cx - x) * (az - z) - (ax - x) * (cz - z)) / area;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    const y = u * mesh[t + axis] + v * mesh[t + 3 + axis] + w * mesh[t + 6 + axis];
    lo = Math.min(lo, y); hi = Math.max(hi, y);
  }
  lo = Math.max(lo, body.min[axis]); hi = Math.min(hi, body.max[axis]);
  const span: [number, number] | null = hi - lo > 0.5 ? [lo, hi] : null;
  cache.set(key, span);
  return span;
}

/** Whether a part-space point lies in a stud (with half an LDU of slack). */
function inStud(st: StudConnector, q: readonly number[]): boolean {
  const a = [st.tip[0] - st.base[0], st.tip[1] - st.base[1], st.tip[2] - st.base[2]];
  const len = Math.hypot(a[0], a[1], a[2]);
  if (len < 1e-6) return false;
  const d = [q[0] - st.base[0], q[1] - st.base[1], q[2] - st.base[2]];
  const t = (d[0] * a[0] + d[1] * a[1] + d[2] * a[2]) / len;
  if (t < -0.5 || t > len + 0.5) return false;
  const r2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 - t * t;
  return r2 < (st.radius + 0.5) ** 2;
}

/** A placed part in the shared frame: everything the narrow phase needs, no more. */
type Body = { world: ArrayLike<number>; box: Box; body: Box; mesh: Float32Array };
/**
 * Whether a shared-frame point is inside a part's solid. `exempt` is handed the same point
 * in the part's own frame and may call it a seat: a stud in a socket is not a poke.
 */
function insidePart(part: Body, p: P3, exempt?: (q: readonly number[]) => boolean): boolean {
  const { box } = part;
  if (![0, 1, 2].every((k) => p[k] > box.min[k] && p[k] < box.max[k])) return false;
  // into the part's own frame (rotation transposed)
  const m = part.world, d = [p[0] - m[12], p[1] - m[13], p[2] - m[14]];
  const q: P3 = [
    m[0] * d[0] + m[4] * d[1] + m[8] * d[2],
    m[1] * d[0] + m[5] * d[1] + m[9] * d[2],
    m[2] * d[0] + m[6] * d[1] + m[10] * d[2],
  ];
  if (exempt?.(q)) return false;
  return ([0, 1, 2] as const).every((k) => {
    const span = lineSpan(part.mesh, part.body, k, q);
    return !!span && q[k] > span[0] + 0.5 && q[k] < span[1] - 0.5;
  });
}

const samples = new WeakMap<readonly Solid[], P3[]>();
/**
 * Points through the moving parts' solids (the shared frame), cached per moving list. The
 * lattice is inset half an LDU from the surface — not two, which would let a piece sit a
 * whole LDU inside another unseen — so the shallowest interpenetration the mesh test sees
 * is one LDU: anything a person can see leaves a sample inside.
 */
function sampleOf(moving: readonly Solid[]): P3[] {
  const hit = samples.get(moving);
  if (hit) return hit;
  const points: P3[] = [];
  for (const part of moving) {
    if (!part.mesh) continue;
    const { min, max } = part.body;
    for (let x = min[0] + 0.5; x <= max[0] - 0.5 + 1e-6; x += 4) for (let z = min[2] + 0.5; z <= max[2] - 0.5 + 1e-6; z += 4) {
      const span = lineSpan(part.mesh, part.body, 1, [x, 0, z]);
      if (!span || span[1] - span[0] < 2.5) continue;
      for (const y of [span[0] + 1, (span[0] + span[1]) / 2, span[1] - 1]) points.push(apply(part.world, [x, y, z]));
    }
  }
  samples.set(moving, points);
  return points;
}
/** How many sample points a moving set has (0 = nothing to test, e.g. no meshes). */
export const sampleCount = (moving: readonly Solid[]) => sampleOf(moving).length;

const CELL = 40;
const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** A fixed part plus the studs and sockets the verdict needs from it. */
type Entry = Body & { part: Solid; studs: Stud[]; studBox: Box | null; sockets: Socket[]; bores: Bore[] };

/** A collision world over fixed solids, indexed once in a uniform grid (40 LDU cells). */
export function collisionWorld(solids: readonly Solid[]): CollisionWorld {
  const entries: Entry[] = solids.filter((s) => s.mesh).map((part) => {
    const studs = worldStuds(part.world, localStuds(part));
    return {
      part, world: part.world, body: part.body, mesh: part.mesh!,
      box: worldBox(part.world, part.body),
      studs, studBox: studBox(studs),
      sockets: worldSockets(part.world, part),
      bores: worldBores(part.world, part.snaps),
    };
  });
  const grid = new Map<string, number[]>();
  entries.forEach(({ box }, i) => {
    const lo = box.min.map((v) => Math.floor(v / CELL)), hi = box.max.map((v) => Math.floor(v / CELL));
    for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
      const k = cellKey(x, y, z), list = grid.get(k);
      if (list) list.push(i); else grid.set(k, [i]);
    }
  });
  const atCells = (p: P3): number[] => {
    const out: number[] = [];
    const x = Math.floor(p[0] / CELL), y = Math.floor(p[1] / CELL), z = Math.floor(p[2] / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const i of grid.get(cellKey(x + dx, y + dy, z + dz)) ?? []) if (!out.includes(i)) out.push(i);
    return out;
  };
  /**
   * Each piece's studs that no other piece is sitting on. A stud with a piece on it is out
   * of the question — that piece is what a moving part would have to overlap — so only a
   * free stud can poke into one. Worked out only when a caller asks for the stud test.
   */
  let freeStuds: Stud[][] | null = null;
  const freeOn = () => freeStuds ??= entries.map((e, i) => e.studs.filter((st) =>
    !atCells(st.base).some((j) => j !== i && entries[j].part.id !== e.part.id && seatedIn(st, entries[j].sockets))));
  return {
    hits(moving, transform, withStuds = true) {
      const out = new Set<string>();
      const mine = new Set(moving);
      const T = asMatrix(transform);
      const plain = isIdentity(T), shiftOnly = isShift(T);
      const place = (p: P3): P3 => shiftOnly ? [p[0] + T[12], p[1] + T[13], p[2] + T[14]] : apply(T, p);
      // the moving set at the pose the caller asks about
      const posed: Body[] = [], studs: Stud[] = [], columns: Stud[] = [], sockets: Socket[] = [];
      let movingBox: Box | null = null;
      for (const s of moving) {
        const world = plain ? s.world : compose(T, s.world);
        const box = worldBox(world, s.body);
        movingBox = movingBox ? unionBox(movingBox, box) : box;
        posed.push({ world, box, body: s.body, mesh: s.mesh! });
        studs.push(...worldStuds(world, localColumns(s)));
        sockets.push(...worldSockets(world, s));
      }
      const near = (p: P3, visit: (e: Entry) => void) => {
        const list = grid.get(cellKey(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL), Math.floor(p[2] / CELL)));
        if (!list) return;
        for (const i of list) {
          const e = entries[i];
          if (out.has(e.part.id) || mine.has(e.part)) continue;
          visit(e);
        }
      };
      /** the fixed part's bores the moving columns are seated in (worked out once each) */
      const open = new Map<Entry, Bore[]>();
      const openBores = (e: Entry) => {
        let hit = open.get(e);
        if (!hit) open.set(e, (hit = takenBores(e.bores, columns)));
        return hit;
      };
      /** the fixed studs one of the moving sockets is waiting for: those are seats, not pokes */
      const seats = new Map<Entry, StudConnector[]>();
      const seatedStuds = (e: Entry) => {
        let hit = seats.get(e);
        if (!hit) seats.set(e, (hit = e.studs.filter((st) => seatedIn(st, sockets)).map((st) => st.local)));
        return hit;
      };
      /** Entry indices near a box: the grid prefilter for the stud tests. */
      const nearby = (box: Box): number[] => {
        const seen = new Set<number>();
        const out2: number[] = [];
        const lo = box.min.map((v) => Math.floor((v - 1) / CELL)), hi = box.max.map((v) => Math.floor((v + 1) / CELL));
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++)
          for (const i of grid.get(cellKey(x, y, z)) ?? []) {
            if (seen.has(i) || mine.has(entries[i].part)) continue;
            seen.add(i);
            out2.push(i);
          }
        return out2;
      };
      // the moving parts' own bodies
      for (const p0 of sampleOf(moving)) {
        const p = place(p0);
        near(p, (e) => {
          // a bore the selection is seated in is a hole in the part, not material
          if (openBores(e).some((b) => inBore(b, p))) return;
          const taken = seatedStuds(e);
          const hit = taken.length
            ? insidePart(e, p, (q) => taken.some((st) => inStud(st, q)))
            : insidePart(e, p);
          if (hit) out.add(e.part.id);
        });
      }
      // A stud is solid: the one an opposing socket is waiting for is a seat, any other one
      // that reaches into a piece is a poke. Nothing outside the drag tested the moving
      // parts' studs at all, which is how a piece could slide them straight through a
      // neighbour, and the drag only looked at the free studs it might snap to.
      if (withStuds && movingBox) for (const i of nearby(movingBox)) {
        const e = entries[i], free = freeOn()[i];
        if (!free.length || !e.studBox || !boxesTouch(e.studBox, movingBox, 1)) continue;
        for (const st of free) {
          if (seatedIn(st, sockets)) continue;
          if (posed.some((m) => studInBox(st, m.box))) { out.add(e.part.id); break; }
        }
      }
      // and the moving parts' studs into the fixed pieces, the other way round
      const movingStudBox = withStuds ? studBox(studs) : null;
      if (movingStudBox) for (const i of nearby(movingStudBox)) {
        const e = entries[i];
        if (out.has(e.part.id)) continue;
        for (const st of studs) {
          if (seatedIn(st, e.sockets)) continue;
          if (studInBox(st, e.box)) { out.add(e.part.id); break; }
        }
      }
      return out;
    },
  };
}

/** True when `after` hits a piece that `before` did not: the edit makes overlap worse. */
export function addsOverlap(before: ReadonlySet<string>, after: ReadonlySet<string>): boolean {
  for (const id of after) if (!before.has(id)) return true;
  return false;
}

/** Placed instances as solids, tagged with their top-level item id; placeholders are skipped. */
export function solidsFor(instances: readonly Instance[], metrics: Metrics): Solid[] {
  return instances.filter((i) => !i.placeholder).map((i) => {
    const m = metrics(i.part);
    return { id: i.key.split('/')[0], world: i.world.elements, body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh };
  });
}
