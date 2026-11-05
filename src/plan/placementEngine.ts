import * as THREE from 'three';
import type { Vec3 } from '../ldraw/parse';
import { type CollisionWorld, type Solid } from './collision';
import { worldConnectors, type Connector } from './connectors';
import { candidates, rayAngle, rayDepth, PICK_RADIUS, OCCLUDE_SLACK, type Aim } from './aim';
import type { AttachmentTarget } from '../model/attachmentPlacements';

/**
 * Studio-style placement: given the mouse ray, find the pose that puts the moving parts where
 * the mouse points, snapped onto a free connection near it. Every connection near the ray (on
 * any visible piece) is tried with every connector of the moving set that can take it (the
 * grip); the pose whose reference point (where the parts are held) lands nearest the ray wins,
 * mating more connectors breaks ties, and poses that push into something are skipped. All in
 * LDU (Y down), in one shared frame.
 */

/** A free connector of a fixed piece, in world LDU. */
export type Target = Connector & { owner: string };
export type Quarter = 0 | 90 | 180 | 270;
export type PoseQuery = {
  /** the moving set in its current world pose (LDU) */
  moving: { solids: Solid[]; connectors: Connector[] };
  /** free connectors of the pieces it may land on (already limited to visible pieces) */
  targets: Target[];
  /** Reviewed non-cylindrical attachment placements (independent of SNAP_CYL). */
  precisionTargets?: AttachmentTarget[];
  /** the mouse ray, how deep it hits a fixed piece, and where it meets the floor */
  aim: Aim;
  /** the point the parts are held by (the grab point, or a new part's underside centre), world LDU */
  ref: Vec3;
  /** index into moving.connectors: the only grip to use (Tab); null = automatic */
  lock: number | null;
  /** extra quarter turns about the target axis (R / Shift+R) */
  yaw: Quarter;
  /** null = collision off */
  world: CollisionWorld | null;
  /** pieces the moving set already overlapped at the start (they may stay) */
  before: ReadonlySet<string>;
  /** the last pose, for hysteresis */
  prev: Pose | null;
  /** LDraw height of the drawn floor (default FLOOR_Y) */
  floor?: number;
};
export type Pose = {
  /** column-major 4x4 LDU transform applied to the moving set's current world pose */
  delta: number[];
  /** how many moving connectors the pose seats */
  mated: number;
  /** pieces it seats onto */
  owners: string[];
  /** false = no clean pose: the ghost shows red and a release does nothing */
  valid: boolean;
  /** the grip used (index into moving.connectors); -1 on the floor */
  handle: number;
  yaw: Quarter;
  /** the target the grip sits on (null on the floor) */
  at: Vec3 | null;
  /** the target connectors the pose mates (drawn as rings) */
  links: { pos: Vec3; axis: Vec3 }[];
  /** how far from the mouse the held point lands (angle from the ray; lower is nearer) */
  score: number;
  /** why an invalid pose is refused, for the sidebar (set only when `valid` is false) */
  why?: string;
  /** the pieces an invalid pose would sit inside */
  with?: string[];
  /** Named documented attachment, not a cylinder snap or collision approval. */
  attachment?: { slot: string; evidence: string; source: string; mirrored: boolean };
};

/** How many of the moving set's connectors are tried as the grip on each target. */
export const MAX_GRIPS = 16;
/** A new pose must land this much (LDU at the target's depth) nearer the mouse to take over. */
export const HYSTERESIS = 4;
/** Collision tests stop after this long (ms) in one search: a big moving set never hitches the drag. */
export const TRY_BUDGET_MS = 12;
/** The floor's LDraw height. */
export const FLOOR_Y = 0;

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mates = (c: Connector, t: Connector) => c.gender !== t.gender && c.type === t.type && dist(c.pos, t.pos) < 1 && dot(c.axis, t.axis) < -0.999;

function boxOf(solids: readonly Solid[], m: THREE.Matrix4): THREE.Box3 {
  const out = new THREE.Box3();
  const e = new THREE.Matrix4();
  for (const s of solids) {
    e.fromArray(Array.from(s.world)).premultiply(m);
    const b = new THREE.Box3(new THREE.Vector3(...s.body.min), new THREE.Vector3(...s.body.max)).applyMatrix4(e);
    out.union(b);
  }
  return out;
}

/** The transform that puts `handle` onto `target`, axes opposed, plus `yaw` about the target axis. */
export function seat(handle: Connector, target: Connector, yaw: Quarter): THREE.Matrix4 {
  const from = new THREE.Vector3(...handle.axis), to = new THREE.Vector3(...target.axis).negate();
  const align = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(from, to));
  const turn = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...target.axis).normalize(), (yaw * Math.PI) / 180);
  return new THREE.Matrix4().makeTranslation(...target.pos)
    .multiply(turn).multiply(align)
    .multiply(new THREE.Matrix4().makeTranslation(-handle.pos[0], -handle.pos[1], -handle.pos[2]));
}

const clean = (m: THREE.Matrix4) => Array.from(m.elements, (v) => (Math.abs(v - Math.round(v)) < 1e-6 ? Math.round(v) || 0 : v));

export function handleCount(moving: PoseQuery['moving']): number {
  return moving.connectors.length;
}

/** Free connectors: not already mated with another piece, and not covered by one. */
export function freeTargets(groups: readonly { list: readonly Connector[]; owner: string }[], solids: readonly Solid[]): Target[] {
  // connectors hashed by whole-LDU position (mates sit within 1 LDU), boxes by 40 LDU cells
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const byPos = new Map<string, { c: Connector; owner: string }[]>();
  for (const g of groups) for (const c of g.list) {
    const k = key(Math.round(c.pos[0]), Math.round(c.pos[1]), Math.round(c.pos[2]));
    (byPos.get(k) ?? byPos.set(k, []).get(k)!).push({ c, owner: g.owner });
  }
  const matedElsewhere = (c: Connector, owner: string) => {
    const [x, y, z] = c.pos.map(Math.round);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const o of byPos.get(key(x + dx, y + dy, z + dz)) ?? []) if (o.owner !== owner && mates(c, o.c)) return true;
    return false;
  };
  const CELL = 40;
  const cells = new Map<string, { id: string; box: THREE.Box3 }[]>();
  for (const s of solids) {
    const box = boxOf([s], new THREE.Matrix4()).expandByScalar(-0.5);
    if (box.isEmpty()) continue;
    const lo = box.min.toArray().map((v) => Math.floor(v / CELL)), hi = box.max.toArray().map((v) => Math.floor(v / CELL));
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
      const ck = key(i, j, k);
      (cells.get(ck) ?? cells.set(ck, []).get(ck)!).push({ id: s.id, box });
    }
  }
  const q = new THREE.Vector3();
  const out: Target[] = [];
  for (const g of groups) for (const c of g.list) {
    if (matedElsewhere(c, g.owner)) continue;
    q.set(c.pos[0] + 2 * c.axis[0], c.pos[1] + 2 * c.axis[1], c.pos[2] + 2 * c.axis[2]);
    const near = cells.get(key(Math.floor(q.x / CELL), Math.floor(q.y / CELL), Math.floor(q.z / CELL))) ?? [];
    if (near.some((b) => b.id !== g.owner && b.box.containsPoint(q))) continue;
    out.push({ ...c, owner: g.owner });
  }
  return out;
}

const posKey = (x: number, y: number, z: number) => `${x},${y},${z}`;
const indexes = new WeakMap<readonly Target[], (c: Connector) => Target | undefined>();
/** The target a connector mates with, looked up by whole-LDU position (built once per target list). */
function targetIndex(targets: readonly Target[]): (c: Connector) => Target | undefined {
  const hit = indexes.get(targets);
  if (hit) return hit;
  const byPos = new Map<string, Target[]>();
  for (const t of targets) {
    const k = posKey(Math.round(t.pos[0]), Math.round(t.pos[1]), Math.round(t.pos[2]));
    (byPos.get(k) ?? byPos.set(k, []).get(k)!).push(t);
  }
  const find = (c: Connector) => {
    const x = Math.round(c.pos[0]), y = Math.round(c.pos[1]), z = Math.round(c.pos[2]);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const t of byPos.get(posKey(x + dx, y + dy, z + dz)) ?? []) if (mates(c, t)) return t;
    return undefined;
  };
  indexes.set(targets, find);
  return find;
}

const same = (a: readonly number[], b: readonly number[]) => dist(a, b) < 1e-6;
/** scores closer than this count as equal (mating more connectors then wins) */
const TIE = 1e-9;
/** How to explain a refused pose, so the sidebar can say why a piece shows red. */
const refusal = (b: { ground: boolean; hits: string[] }): Pick<Pose, 'why' | 'with'> =>
  b.ground ? { why: 'it would go below the floor', with: [] }
    : b.hits.length ? { why: 'it would sit inside another piece', with: b.hits }
    : { why: 'there is no clean seat here', with: [] };

export function findPose(q: PoseQuery): Pose {
  const { moving, aim, yaw } = q;
  // nothing solid to place (e.g. only unknown parts): no pose can be trusted
  if (!moving.solids.length) return { delta: clean(new THREE.Matrix4()), mated: 0, owners: [], valid: false, handle: -1, yaw, at: null, links: [], score: Infinity };
  const floor = q.floor ?? FLOOR_Y;
  // the floor is solid: nothing goes underground (unless it already started there)
  const lowest = Math.max(floor, boxOf(moving.solids, new THREE.Matrix4()).max.y) + 0.5;
  /** What stops a pose: the floor, or the pieces it would newly sit inside. */
  const blockOf = (m: THREE.Matrix4): { ground: boolean; hits: string[] } => {
    if (boxOf(moving.solids, m).max.y > lowest) return { ground: true, hits: [] };
    if (!q.world) return { ground: false, hits: [] };
    // one verdict for every edit path: bodies, and studs that do not meet a socket
    const hits = [...q.world.hits(moving.solids, m.elements)].filter((id) => !q.before.has(id));
    return { ground: false, hits };
  };
  const blocked = (m: THREE.Matrix4) => {
    const b = blockOf(m);
    return b.ground || b.hits.length > 0;
  };
  const near = candidates(q.targets, aim);

  const ref = new THREE.Vector3(...q.ref);
  const scoreOf = (m: THREE.Matrix4) => rayAngle(aim.ray, ref.clone().applyMatrix4(m).toArray());
  // grips: the locked one, or the connectors nearest the held point (one list per gender)
  const grips = (gender: Connector['gender'], type: string): number[] => {
    if (q.lock !== null) {
      const c = moving.connectors[q.lock];
      return c && c.gender === gender && c.type === type ? [q.lock] : [];
    }
    return moving.connectors
      .map((c, i) => ({ c, i, d: dist(c.pos, q.ref) }))
      .filter(({ c }) => c.gender === gender && c.type === type)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_GRIPS)
      .map(({ i }) => i);
  };
  const gripCache = new Map<string, number[]>();
  const index = targetIndex(q.targets);
  const matesOf = (m: THREE.Matrix4) => {
    const owners = new Set<string>();
    const links: Pose['links'] = [];
    for (const c of worldConnectors(moving.connectors, m.elements)) {
      const o = index(c);
      if (o) { links.push({ pos: o.pos, axis: o.axis }); owners.add(o.owner); }
    }
    return { mated: links.length, owners: [...owners].sort(), links };
  };

  type Option = { m: THREE.Matrix4; t?: Target; precision?: AttachmentTarget; grip: number; score: number; mates?: ReturnType<typeof matesOf> };
  const mates = (o: Option) => (o.mates ??= matesOf(o.m));
  /**
   * A finger hinge seated at the far end of its run joins with the other half turned round.
   * Both ways can fit (3937 / 3938's knuckles are symmetric), but only one faces the way the
   * parts are made to go together: the same-way seat. The turned seat is the right one only
   * when the same-way one is blocked, as with 4275 / 4276, whose plates would coincide. So
   * a far-end seat becomes the same-way seat of that hinge whenever that one is clean.
   */
  const sameWay = new Map<string, { t: Target; g: number; m: THREE.Matrix4 } | null>();
  const unturned = (t: Target, g: number): { t: Target; g: number; m: THREE.Matrix4 } | null => {
    const h = moving.connectors[g];
    if (!(t.flip || h.flip) || !t.joint || !h.joint) return null;
    const key = `${t.owner}|${t.joint}|${h.joint}`;
    if (!sameWay.has(key)) {
      const t2 = q.targets.find((x) => x.owner === t.owner && x.joint === t.joint && !x.flip);
      const g2 = moving.connectors.findIndex((x) => x.joint === h.joint && !x.flip && x.gender === h.gender);
      const m = t2 && g2 >= 0 ? seat(moving.connectors[g2], t2, yaw) : null;
      sameWay.set(key, t2 && m && !blocked(m) ? { t: t2, g: g2, m } : null);
    }
    return sameWay.get(key)!;
  };
  const options: Option[] = [];
  for (const t of near) {
    const want = t.gender === 'M' ? 'F' : 'M';
    const key = `${want}|${t.type}`;
    const list = gripCache.get(key) ?? gripCache.set(key, grips(want, t.type)).get(key)!;
    for (const g of list) {
      const plain = unturned(t, g);
      // scored where the mouse asked for it, seated the way the hinge is made to go
      const m = plain?.m ?? seat(moving.connectors[g], t, yaw);
      options.push({ m, t: plain?.t ?? t, grip: plain?.g ?? g, score: scoreOf(m) });
    }
  }
  // Precise non-cylindrical placements are a parallel route through the same
  // score/occlusion/collision pipeline. No fake stud/bar or SNAP_CYL is created.
  // Only a single independently movable part can use this path. The reference
  // pose is rigid; arbitrary R-yaw or a locked cylindrical grip disables it.
  if (moving.solids.length === 1 && q.lock === null && yaw === 0) {
    const current = new THREE.Matrix4().fromArray(Array.from(moving.solids[0].world));
    if (Number.isFinite(current.determinant()) && Math.abs(current.determinant()) > 1e-8) {
      const inv = current.clone().invert();
      for (const t of q.precisionTargets ?? []) {
        const depth = rayDepth(aim.ray, t.anchor);
        if (depth <= 0 || !Number.isFinite(depth)) continue;
        // Placement centres are inside a sheath, behind its rendered surface.
        // Permit a modest occlusion depth but not a hidden remote host.
        if (aim.hitDepth !== null && depth > aim.hitDepth + Math.max(OCCLUDE_SLACK, 24)) continue;
        const score = rayAngle(aim.ray, t.anchor);
        if (score * depth > PICK_RADIUS) continue;
        const m = new THREE.Matrix4().fromArray(t.world).multiply(inv);
        if (Array.from(m.elements).every(Number.isFinite)) options.push({ m, precision: t, grip: -2, score });
      }
    }
  }
  if (!options.length) return floorPose(q, blockOf);
  options.sort((a, b) => a.score - b.score);

  const pose = (o: Option, valid: boolean): Pose => valid
    ? o.precision
      ? { delta: clean(o.m), mated: 1, owners: [o.precision.owner], links: [], valid: true,
          handle: -2, yaw, at: o.precision.anchor, score: o.score,
          attachment: { slot: o.precision.slot.id, evidence: o.precision.slot.evidence, source: o.precision.slot.source, mirrored: o.precision.slot.mirrored } }
      : { delta: clean(o.m), ...mates(o), valid: true, handle: o.grip, yaw, at: o.t!.pos, score: o.score }
    : { delta: clean(o.m), mated: 0, owners: [], links: [], valid: false, handle: o.grip, yaw,
        at: o.precision?.anchor ?? o.t!.pos, score: o.score, ...refusal(blockOf(o.m)),
        ...(o.precision ? { attachment: { slot: o.precision.slot.id, evidence: o.precision.slot.evidence, source: o.precision.slot.source, mirrored: o.precision.slot.mirrored } } : {}) };
  // nearest first; among equally near ones, the one mating more (counted only where needed).
  // The budget bounds how long the search may run, never a verdict: an option that was not
  // tested can neither win nor be shown, so what the drag previews has always been checked.
  let best: Option | undefined;
  let shown: Option | undefined;
  const t0 = performance.now();
  const outOfTime = () => performance.now() - t0 > TRY_BUDGET_MS;
  for (let i = 0; i < options.length && !best && !(shown && outOfTime());) {
    let j = i + 1;
    while (j < options.length && options[j].score - options[i].score <= TIE) j++;
    // collision first (cheap next to counting mates on a big set), then the most mated clean one
    const clear: Option[] = [];
    for (let k = i; k < j; k++) {
      const o = options[k];
      if (shown && outOfTime()) break;
      shown ??= o;
      if (!blocked(o.m)) clear.push(o);
    }
    best = clear.length > 1 ? clear.reduce((a, b) => (mates(b).mated > mates(a).mated ? b : a)) : clear[0];
    i = j;
  }

  // the last pose holds while its target is still near the mouse and it lands about as near
  // (the fixed pieces do not change during a drag, so it is still clean)
  const p = q.prev;
  if (p && p.valid && p.at && p.yaw === yaw && p.handle >= -2 && (q.lock === null || p.handle === q.lock) && (near.some((t) => same(t.pos, p.at!)) ||
    (p.handle === -2 && (q.precisionTargets ?? []).some((t) => t.slot.id === p.attachment?.slot && same(t.anchor, p.at!))))) {
    const again = scoreOf(new THREE.Matrix4().fromArray(p.delta));
    const depth = rayDepth(aim.ray, p.at);
    if (depth > 0 && (!best || again <= best.score + HYSTERESIS / depth + TIE)) return { ...p, score: again };
  }
  // nothing clean: show the nearest pose that was tested, in red (a release does nothing)
  return best ? pose(best, true) : pose(shown ?? options[0], false);
}

/**
 * Nothing near the mouse will take this piece, and the mouse is on a piece: put the held
 * point exactly where it points, unsnapped, and let the guard decide. That is how a part
 * with no connector for the job is placed by hand — a sword threaded into a scabbard's slot.
 */
function freePose(q: PoseQuery, blockOf: (m: THREE.Matrix4) => { ground: boolean; hits: string[] }, at: Vec3): Pose {
  const { moving, yaw } = q;
  const pivot = boxOf(moving.solids, new THREE.Matrix4()).getCenter(new THREE.Vector3());
  const turn = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationY((yaw * Math.PI) / 180))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  const m = new THREE.Matrix4().makeTranslation(at[0], at[1], at[2]).multiply(turn)
    .multiply(new THREE.Matrix4().makeTranslation(-q.ref[0], -q.ref[1], -q.ref[2]));
  const block = blockOf(m);
  const free = !block.ground && !block.hits.length;
  return { delta: clean(m), mated: 0, owners: [], valid: free, handle: -1, yaw, at: null, links: [], score: Infinity, ...(free ? {} : refusal(block)) };
}

const mod20 = (v: number) => ((v % 20) + 20) % 20;
/**
 * The stud grid a part stands on near `at`, in x / z: `ref` is a point of the moving set
 * (after `turn`) that must land on the grid, `phase` where the grid lines fall (mod 20).
 * The grid is the one the nearest upright stud of the fixed pieces sits on, and the moving
 * set lines up by one of its own upright connectors. A model built off the 20 LDU floor
 * grid (moved, imported, or a bracket's studs between rows) would otherwise put a part
 * dropped beside it a few LDU inside its neighbour. With nothing to read, box corners on
 * the floor grid, as before.
 */
function gridOf(q: PoseQuery, turn: THREE.Matrix4, b: THREE.Box3, at: readonly number[]): { ref: [number, number]; phase: [number, number] } {
  const upright = (axis: readonly number[]) => Math.abs(Math.abs(axis[1]) - 1) < 1e-3;
  let near: Target | undefined, best = Infinity;
  for (const t of q.targets) {
    if (!upright(t.axis)) continue;
    const d = Math.hypot(t.pos[0] - at[0], t.pos[2] - at[2]);
    if (d < best) { best = d; near = t; }
  }
  const own = q.moving.connectors.find((c) => upright(new THREE.Vector3(...c.axis).transformDirection(turn).toArray()));
  if (!near || !own) return { ref: [b.min.x, b.min.z], phase: [0, 0] };
  const p = new THREE.Vector3(...own.pos).applyMatrix4(turn);
  return { ref: [p.x, p.z], phase: [mod20(near.pos[0]), mod20(near.pos[2])] };
}

/** No connection near the mouse: the moving set stands where the mouse points, or on the floor grid under it. */
function floorPose(q: PoseQuery, blockOf: (m: THREE.Matrix4) => { ground: boolean; hits: string[] }): Pose {
  const { moving, yaw } = q;
  const hit = q.aim.hitPoint;
  if (hit) {
    const free = freePose(q, blockOf, hit);
    // pointing at a piece's wall centres the part on the wall, inside the piece: stand it beside instead
    return free.valid ? free : besidePose(q, blockOf, hit) ?? free;
  }
  const at = q.aim.floorPoint;
  if (!at) return { delta: clean(new THREE.Matrix4()), mated: 0, owners: [], valid: false, handle: -1, yaw, at: null, links: [], score: Infinity, why: 'there is nowhere to put it', with: [] };
  const start = boxOf(moving.solids, new THREE.Matrix4());
  const pivot = start.getCenter(new THREE.Vector3());
  const turn = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationY((yaw * Math.PI) / 180))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  const b = boxOf(moving.solids, turn);
  const c = b.getCenter(new THREE.Vector3());
  const g = gridOf(q, turn, b, at);
  const snapX = Math.round((g.ref[0] + at[0] - c.x - g.phase[0]) / 20) * 20 + g.phase[0] - g.ref[0];
  const snapZ = Math.round((g.ref[1] + at[2] - c.z - g.phase[1]) / 20) * 20 + g.phase[1] - g.ref[1];
  const m = new THREE.Matrix4().makeTranslation(snapX, (q.floor ?? FLOOR_Y) - b.max.y, snapZ).multiply(turn);
  const block = blockOf(m);
  const free = !block.ground && !block.hits.length;
  return { delta: clean(m), mated: 0, owners: [], valid: free, handle: -1, yaw, at: null, links: [], score: Infinity, ...(free ? {} : refusal(block)) };
}

/** How many grid cells either side of the pointed spot are tried for a place beside a piece. */
const BESIDE_REACH = 4;
/** How many of the nearest cells are tried whatever the time budget says. */
const BESIDE_ALWAYS = 9;
/**
 * The cursor is on a piece that nothing can seat the part on (a wall, a smooth top) and the
 * part held there would sit inside it: stand the part on the floor grid at the nearest clean
 * cell to the pointed spot, which is the one touching the piece. Without this, putting a part
 * side by side with another meant hitting a free stud exactly.
 */
function besidePose(q: PoseQuery, blockOf: (m: THREE.Matrix4) => { ground: boolean; hits: string[] }, hit: Vec3): Pose | null {
  const { moving, yaw } = q;
  const pivot = boxOf(moving.solids, new THREE.Matrix4()).getCenter(new THREE.Vector3());
  const turn = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationY((yaw * Math.PI) / 180))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  const b = boxOf(moving.solids, turn);
  const c = b.getCenter(new THREE.Vector3());
  const g = gridOf(q, turn, b, hit);
  const x0 = Math.round((g.ref[0] + hit[0] - c.x - g.phase[0]) / 20), z0 = Math.round((g.ref[1] + hit[2] - c.z - g.phase[1]) / 20);
  const y = (q.floor ?? FLOOR_Y) - b.max.y;
  const cells: { m: THREE.Matrix4; d: number; e: number }[] = [];
  for (let i = -BESIDE_REACH; i <= BESIDE_REACH; i++) for (let j = -BESIDE_REACH; j <= BESIDE_REACH; j++) {
    const dx = (x0 + i) * 20 + g.phase[0] - g.ref[0], dz = (z0 + j) * 20 + g.phase[1] - g.ref[1];
    cells.push({ m: new THREE.Matrix4().makeTranslation(dx, y, dz).multiply(turn), d: Math.hypot(Math.max(b.min.x + dx - hit[0], 0, hit[0] - b.max.x - dx), Math.max(b.min.z + dz - hit[2], 0, hit[2] - b.max.z - dz)),
      e: Math.hypot(c.x + dx - hit[0], c.z + dz - hit[2]) });
  }
  // the cell that touches the pointed spot first; of those, the one centred nearest it
  cells.sort((a, z) => a.d - z.d || a.e - z.e);
  const t0 = performance.now();
  for (const [k, { m }] of cells.entries()) {
    // the nearest ring is always tried, so the answer does not depend on how busy the machine is
    if (k >= BESIDE_ALWAYS && performance.now() - t0 > TRY_BUDGET_MS) break;
    const block = blockOf(m);
    if (!block.ground && !block.hits.length) return { delta: clean(m), mated: 0, owners: [], valid: true, handle: -1, yaw, at: null, links: [], score: Infinity };
  }
  return null;
}
