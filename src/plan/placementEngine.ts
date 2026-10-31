import * as THREE from 'three';
import type { Vec3 } from '../ldraw/parse';
import { addsOverlap, type CollisionWorld, type Solid } from './collision';
import { worldConnectors, type Connector } from './connectors';

/**
 * Studio-style placement: given where the mouse ray hits the model, find the pose that seats
 * the moving parts on the connection under the mouse. One of the moving set's connectors is
 * the handle (Tab cycles it); it is put onto a free target connector of the opposite gender,
 * axes opposed, and the pose that mates the most connectors without pushing into anything
 * wins. Everything is in LDU (Y down), in one shared frame.
 */

/** A free connector of a fixed piece, in world LDU. */
export type Target = Connector & { owner: string };
export type Quarter = 0 | 90 | 180 | 270;
export type PoseQuery = {
  /** the moving set in its current world pose (LDU) */
  moving: { solids: Solid[]; connectors: Connector[] };
  /** free connectors of the pieces it may land on (already limited to visible pieces) */
  targets: Target[];
  /** where the mouse ray meets the model; owner null = the floor */
  hit: { point: Vec3; owner: string | null };
  /** index into moving.connectors: the connector that seats on the target */
  handle: number;
  /** extra quarter turns about the target axis (R / Shift+R) */
  yaw: Quarter;
  /** null = collision off */
  world: CollisionWorld | null;
  /** pieces the moving set already overlapped at the start (they may stay) */
  before: ReadonlySet<string>;
  /** the last pose, for hysteresis */
  prev: Pose | null;
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
  handle: number;
  yaw: Quarter;
  /** the target the handle sits on (null on the floor) */
  at: Vec3 | null;
};

/** How far (LDU) from the hit point a target may be. */
export const SEARCH_RADIUS = 30;
/** A new target must be this much (LDU) nearer the hit than the current one to take over. */
export const HYSTERESIS = 7;
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

export function findPose(q: PoseQuery): Pose {
  const { moving, hit, handle, yaw } = q;
  const h = moving.connectors[handle];
  // the floor is solid: nothing goes underground (unless it already started there)
  const ground = Math.max(FLOOR_Y, boxOf(moving.solids, new THREE.Matrix4()).max.y) + 0.5;
  const blocked = (m: THREE.Matrix4) => {
    if (moving.solids.length && boxOf(moving.solids, m).max.y > ground) return true;
    if (!q.world) return false;
    const shifted = moving.solids.map((s) => ({ ...s, world: new THREE.Matrix4().fromArray(Array.from(s.world)).premultiply(m).elements }));
    return addsOverlap(q.before, q.world.hits(shifted));
  };
  if (hit.owner === null || !h) return floorPose(q, blocked);

  type Scored = { m: THREE.Matrix4; at: Vec3; mated: number; owners: string[]; ok: boolean; d: number };
  const scored: Scored[] = [];
  const index = targetIndex(q.targets);
  for (const t of q.targets) {
    if (t.owner !== hit.owner || t.gender === h.gender || t.type !== h.type || dist(t.pos, hit.point) > SEARCH_RADIUS) continue;
    const m = seat(h, t, yaw);
    const placed = worldConnectors(moving.connectors, m.elements);
    const owners = new Set<string>();
    let mated = 0;
    for (const c of placed) {
      const o = index(c);
      if (o) { mated++; owners.add(o.owner); }
    }
    scored.push({ m, at: t.pos, mated, owners: [...owners].sort(), ok: !blocked(m), d: dist(t.pos, hit.point) });
  }
  const valid = scored.filter((s) => s.ok).sort((a, b) => b.mated - a.mated || a.d - b.d);
  const best = valid[0];
  if (!best) {
    // nothing clean: show where it would go (nearest), in red
    const near = scored.sort((a, b) => a.d - b.d)[0];
    return { delta: clean(near?.m ?? new THREE.Matrix4()), mated: 0, owners: [], valid: false, handle, yaw, at: near?.at ?? null };
  }
  const p = q.prev;
  if (p && p.valid && p.at && p.handle === handle && p.yaw === yaw && dist(p.at, hit.point) <= SEARCH_RADIUS &&
    dist(p.at, hit.point) <= best.d + HYSTERESIS && valid.some((s) => dist(s.at, p.at!) < 1e-6)) return p;
  return { delta: clean(best.m), mated: best.mated, owners: best.owners, valid: true, handle, yaw, at: best.at };
}

/** Over empty floor: the moving set stands on the floor at the nearest whole-stud spot under the mouse. */
function floorPose(q: PoseQuery, blocked: (m: THREE.Matrix4) => boolean): Pose {
  const { moving, hit, handle, yaw } = q;
  const start = boxOf(moving.solids, new THREE.Matrix4());
  const pivot = start.getCenter(new THREE.Vector3());
  const turn = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new THREE.Matrix4().makeRotationY((yaw * Math.PI) / 180))
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  const b = boxOf(moving.solids, turn);
  const c = b.getCenter(new THREE.Vector3());
  const snapX = Math.round((b.min.x + hit.point[0] - c.x) / 20) * 20 - b.min.x;
  const snapZ = Math.round((b.min.z + hit.point[2] - c.z) / 20) * 20 - b.min.z;
  const m = new THREE.Matrix4().makeTranslation(snapX, FLOOR_Y - b.max.y, snapZ).multiply(turn);
  return { delta: clean(m), mated: 0, owners: [], valid: !blocked(m), handle, yaw, at: null };
}
