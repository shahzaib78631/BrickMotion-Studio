import * as THREE from 'three';
import type { Vec3 } from '../ldraw/parse';
import { addsOverlap, type CollisionWorld, type Solid } from './collision';
import { worldConnectors, type Connector } from './connectors';
import { candidates, rayAngle, rayDepth, type Aim } from './aim';

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
};

/** How many of the moving set's connectors are tried as the grip on each target. */
export const MAX_GRIPS = 16;
/** A new pose must land this much (LDU at the target's depth) nearer the mouse to take over. */
export const HYSTERESIS = 4;
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
function seat(handle: Connector, target: Connector, yaw: Quarter): THREE.Matrix4 {
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

const STUD_RADIUS = 6;
/** Whether a stud (base `pos`, pointing along `axis`) reaches into a box, with half an LDU of slack. */
function studInBox(pos: readonly number[], axis: readonly number[], b: THREE.Box3): boolean {
  const along = [0, 1, 2].reduce((k, i) => (Math.abs(axis[i]) > Math.abs(axis[k]) ? i : k), 0);
  const lo = b.min.toArray(), hi = b.max.toArray();
  return [0, 1, 2].every((i) => {
    const v = pos[i] + 2 * axis[i]; // 2 LDU up the stud
    return i === along ? v > lo[i] + 0.5 && v < hi[i] - 0.5 : v > lo[i] - (STUD_RADIUS - 0.5) && v < hi[i] + (STUD_RADIUS - 0.5);
  });
}
/**
 * A free stud of a fixed piece that would reach into a moving part without one of the moving
 * part's sockets taking it: it would be cutting through a wall (the collision world lets studs
 * pass everywhere, as if they always sat in a socket).
 */
function studPokesIn(q: PoseQuery, m: THREE.Matrix4): boolean {
  const all = boxOf(q.moving.solids, m);
  const near = q.targets.filter((t) => t.gender === 'M' && studInBox(t.pos, t.axis, all));
  if (!near.length) return false;
  const boxes = q.moving.solids.map((s) => boxOf([s], m));
  const sockets = worldConnectors(q.moving.connectors, m.elements).filter((c) => c.gender === 'F');
  return near.some((t) => boxes.some((b) => studInBox(t.pos, t.axis, b)) && !sockets.some((c) => mates(c, t)));
}

const same = (a: readonly number[], b: readonly number[]) => dist(a, b) < 1e-6;
/** scores closer than this count as equal (mating more connectors then wins) */
const TIE = 1e-9;

export function findPose(q: PoseQuery): Pose {
  const { moving, aim, yaw } = q;
  // nothing solid to place (e.g. only unknown parts): no pose can be trusted
  if (!moving.solids.length) return { delta: clean(new THREE.Matrix4()), mated: 0, owners: [], valid: false, handle: -1, yaw, at: null, links: [], score: Infinity };
  const floor = q.floor ?? FLOOR_Y;
  // the floor is solid: nothing goes underground (unless it already started there)
  const ground = Math.max(floor, boxOf(moving.solids, new THREE.Matrix4()).max.y) + 0.5;
  const blocked = (m: THREE.Matrix4) => {
    if (boxOf(moving.solids, m).max.y > ground) return true;
    if (!q.world) return false;
    if (studPokesIn(q, m)) return true;
    const shifted = moving.solids.map((s) => ({ ...s, world: new THREE.Matrix4().fromArray(Array.from(s.world)).premultiply(m).elements }));
    return addsOverlap(q.before, q.world.hits(shifted));
  };
  const near = candidates(q.targets, aim);
  if (!near.length) return floorPose(q, blocked);

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

  type Option = { m: THREE.Matrix4; t: Target; grip: number; score: number; mates?: ReturnType<typeof matesOf> };
  const mates = (o: Option) => (o.mates ??= matesOf(o.m));
  const options: Option[] = [];
  for (const t of near) {
    const want = t.gender === 'M' ? 'F' : 'M';
    const key = `${want}|${t.type}`;
    const list = gripCache.get(key) ?? gripCache.set(key, grips(want, t.type)).get(key)!;
    for (const g of list) {
      const m = seat(moving.connectors[g], t, yaw);
      options.push({ m, t, grip: g, score: scoreOf(m) });
    }
  }
  if (!options.length) return floorPose(q, blocked);
  options.sort((a, b) => a.score - b.score);

  const pose = (o: Option, valid: boolean): Pose => valid
    ? { delta: clean(o.m), ...mates(o), valid: true, handle: o.grip, yaw, at: o.t.pos, score: o.score }
    : { delta: clean(o.m), mated: 0, owners: [], links: [], valid: false, handle: o.grip, yaw, at: o.t.pos, score: o.score };
  // nearest first; among equally near ones, the one mating more (counted only where needed)
  let best: Option | undefined;
  for (let i = 0; i < options.length && !best;) {
    let j = i + 1;
    while (j < options.length && options[j].score - options[i].score <= TIE) j++;
    const group = options.slice(i, j);
    if (group.length > 1) group.sort((a, b) => mates(b).mated - mates(a).mated);
    best = group.find((o) => !blocked(o.m));
    if (i === 0) options.splice(0, j, ...group); // options[0] = the best pose, clean or not
    i = j;
  }

  // the last pose holds while its target is still near the mouse and it lands about as near
  // (the fixed pieces do not change during a drag, so it is still clean)
  const p = q.prev;
  if (p && p.valid && p.at && p.yaw === yaw && p.handle >= 0 && (q.lock === null || p.handle === q.lock) && near.some((t) => same(t.pos, p.at!))) {
    const again = scoreOf(new THREE.Matrix4().fromArray(p.delta));
    const depth = rayDepth(aim.ray, p.at);
    if (depth > 0 && (!best || again <= best.score + HYSTERESIS / depth + TIE)) return { ...p, score: again };
  }
  // nothing clean: show the nearest, in red (a release does nothing)
  return best ? pose(best, true) : pose(options[0], false);
}

/** No connection near the mouse: the moving set stands on the floor at the nearest whole-stud spot under it. */
function floorPose(q: PoseQuery, blocked: (m: THREE.Matrix4) => boolean): Pose {
  const { moving, yaw } = q;
  const at = q.aim.floorPoint;
  if (!at) return { delta: clean(new THREE.Matrix4()), mated: 0, owners: [], valid: false, handle: -1, yaw, at: null, links: [], score: Infinity };
  const start = boxOf(moving.solids, new THREE.Matrix4());
  const pivot = start.getCenter(new THREE.Vector3());
  const turn = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationY((yaw * Math.PI) / 180))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  const b = boxOf(moving.solids, turn);
  const c = b.getCenter(new THREE.Vector3());
  const snapX = Math.round((b.min.x + at[0] - c.x) / 20) * 20 - b.min.x;
  const snapZ = Math.round((b.min.z + at[2] - c.z) / 20) * 20 - b.min.z;
  const m = new THREE.Matrix4().makeTranslation(snapX, (q.floor ?? FLOOR_Y) - b.max.y, snapZ).multiply(turn);
  return { delta: clean(m), mated: 0, owners: [], valid: !blocked(m), handle: -1, yaw, at: null, links: [], score: Infinity };
}
