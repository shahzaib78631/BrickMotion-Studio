import type { Vec3 } from '../ldraw/parse';
import type { Target } from './placementEngine';

/**
 * Where the mouse points, in the editing model's LDraw frame (LDU, Y down): the ray from the
 * camera through the cursor, how deep along it the first fixed piece is hit (null: nothing),
 * and where it meets the drawn floor (null: it does not).
 */
export type Ray = { origin: Vec3; dir: Vec3 };
export type Aim = {
  ray: Ray;
  hitDepth: number | null;
  floorPoint: Vec3 | null;
  /** the point on the piece under the cursor (null: the cursor is not on a piece) */
  hitPoint: Vec3 | null;
};

/** How far (LDU, across the ray) a connection may be from the cursor to count. */
export const PICK_RADIUS = 24;
/** How far (LDU) behind the hit surface a connection may sit and still count as visible. */
export const OCCLUDE_SLACK = 6;
/**
 * A hinge's or grip's connection is its axis, inside the knuckles or the hand, so the
 * surface the cursor hits is the knuckle around it: it may sit this much deeper still.
 */
export const BURIED_SLACK = 14;
/**
 * A stud whose surface the cursor is not on: the cursor point sits this much (LDU) behind the
 * plane the stud rises from, so the cursor is on a wall below it, not on the face it stands on.
 */
export const WALL_SLACK = 5;
/** The same for a hinge pivot or ball centre, which lie inside the part (a Technic ball's radius is 12.7 LDU). */
export const JOINT_OCCLUDE_SLACK = 16;
/** How many connections near the cursor are tried. */
export const MAX_TARGETS = 6;

/** Depth of a point along the ray. */
export function rayDepth(ray: Ray, p: readonly number[]): number {
  const { origin: o, dir: d } = ray;
  return (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1] + (p[2] - o[2]) * d[2];
}

/** Distance of a point from the ray, across it. */
function rayGap(ray: Ray, p: readonly number[], depth: number): number {
  const { origin: o, dir: d } = ray;
  return Math.hypot(p[0] - o[0] - d[0] * depth, p[1] - o[1] - d[1] * depth, p[2] - o[2] - d[2] * depth);
}

/** How far from the cursor a point looks: distance across the ray over depth (Infinity behind the camera). */
export function rayAngle(ray: Ray, p: readonly number[]): number {
  const depth = rayDepth(ray, p);
  return depth > 0 ? rayGap(ray, p, depth) / depth : Infinity;
}

/** Free connections the cursor is pointing at: near the ray, facing the camera, not hidden behind what it hits; nearest first. */
export function candidates(targets: readonly Target[], aim: Aim, max = MAX_TARGETS): Target[] {
  const { ray, hitDepth } = aim;
  const d = ray.dir;
  const near: { t: Target; angle: number }[] = [];
  for (const t of targets) {
    // a hinge pin turns in its hole from either side, a knuckle's axis is a line and a ball has
    // none: which way any of them faces does not matter. A knuckle's pivot or a ball's centre
    // sits inside the part, up to a ball's radius behind the surface the ray hits
    const joint = t.type === 'knuckle' || t.type === 'ball';
    const buried = t.type === 'hinge' || !!t.grip;
    if (t.type !== 'hinge' && !joint && t.axis[0] * -d[0] + t.axis[1] * -d[1] + t.axis[2] * -d[2] <= -0.05) continue;
    const depth = rayDepth(ray, t.pos);
    if (depth <= 0 || (hitDepth !== null && depth > hitDepth + (joint ? JOINT_OCCLUDE_SLACK : buried ? BURIED_SLACK : OCCLUDE_SLACK))) continue;
    if (rayGap(ray, t.pos, depth) > PICK_RADIUS) continue;
    // pointing at a piece's wall just under its top studs means "beside it", not "on top of it"
    const p = aim.hitPoint;
    if (p && !buried && !joint && t.gender === 'M' && (p[0] - t.pos[0]) * t.axis[0] + (p[1] - t.pos[1]) * t.axis[1] + (p[2] - t.pos[2]) * t.axis[2] < -WALL_SLACK) continue;
    near.push({ t, angle: rayAngle(ray, t.pos) });
  }
  return near.sort((a, b) => a.angle - b.angle).slice(0, max).map((x) => x.t);
}

/** An aim at a floor spot with nothing in front of it (paste beside the model): only the floor is used. */
export function floorAim(p: Vec3): Aim {
  return { ray: { origin: p, dir: [0, 1, 0] }, hitDepth: 0, floorPoint: p, hitPoint: null };
}

/** Where the ray hits (null when it hits nothing). */
export function aimPoint(aim: Aim): Vec3 | null {
  const { ray: { origin: o, dir: d }, hitDepth: t } = aim;
  return t === null ? null : [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
}
