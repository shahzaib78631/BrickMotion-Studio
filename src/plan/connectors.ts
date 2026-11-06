import type { Box } from '../ldraw/flatten';
import type { Vec3 } from '../ldraw/parse';
import type { PartMetrics } from '../ldraw/metrics';
import type { ColorDef } from '../ldraw/colors';
import type { Snap } from '../ldraw/shadow';
import { bricknetJointSnaps, isBall } from '../data/bricknetJoints';
import { assemble, type Metrics } from '../model/assemble';
import { modelSteps } from './ops';
import { socketsOf } from './studSnap';
import { isHingePin } from './sockets';
import type { Plan, Step } from './types';

/**
 * A connection point, in LDU part (or submodel) space. `axis` points out of the connector,
 * toward where its mate comes from: a top stud points up (−Y), an underside socket points
 * down (+Y). A male and a female mate when their `pos` coincide, their axes are opposite
 * and they are of the same `type`, so a stud never seats in a Technic hole.
 */
export type ConnectorType = 'stud' | 'pin' | 'bar' | 'hinge' | 'knuckle' | 'ball';
export type Connector = {
  pos: Vec3;
  axis: Vec3;
  gender: 'M' | 'F';
  type: ConnectorType;
  /** a clip or a friction grip: the interface that says one part is *held* by the other */
  grip?: boolean;
  /** a finger hinge's knuckle run: both ends of one run share this key */
  joint?: string;
  /** the far end of a finger hinge's run: a seat there turns the other half round */
  flip?: boolean;
  /**
   * knuckle and ball only: what the mate must match — the snap group, or for an ungrouped
   * LDCad `match=size` ball its radius. Two joint halves with different keys never seat.
   */
  fit?: string;
};

/**
 * Joints seat by their own rule. A stud, pin, bar or hinge pin seats with the axes opposed.
 * A knuckle (a finger hinge's pivot, from the joint data) has a line for an axis, not a
 * direction, so its halves seat with the axes on one line either way round, at any angle
 * about it. A ball seats on its centre alone, in any orientation; its
 * `axis` carries no meaning.
 */
export const isJoint = (c: Pick<Connector, 'type'>) => c.type === 'knuckle' || c.type === 'ball';
const dot3 = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function connectorsMate(c: Connector, t: Connector): boolean {
  if (c.gender === t.gender || c.type !== t.type || c.fit !== t.fit) return false;
  if (Math.hypot(c.pos[0] - t.pos[0], c.pos[1] - t.pos[1], c.pos[2] - t.pos[2]) >= 1) return false;
  if (c.type === 'ball') return true;
  const d = dot3(c.axis, t.axis);
  return c.type === 'knuckle' ? Math.abs(d) > 0.999 : d < -0.999;
}

/**
 * a plain round stud (radius 6 LDU), or a round socket that takes one: an anti-stud, a hinge
 * tube such as a car door's, or the deep hollow of a tall brick (22885's runs 36 LDU). A
 * socket's depth does not matter, a stud only enters its open end.
 */
export const isStudSnap = (s: Snap) => s.kind === 'cyl' && s.length > 0 && (s.gender === 'F' || s.length <= 8) && s.shapes.length > 0
    // a round stud also seats in a square socket: the underside of 1-wide plates (4315) and special bases
    && s.shapes.every(x => x === 'R' || (s.gender === 'F' && x === 'S')) && Math.abs(s.radius - 6) <= .6;

/**
 * The family a shadow column belongs to, in LDU of radius: a stud (6), a Technic pin and the
 * hole it enters (8), or a minifig bar and the hole it goes in (4). Each family is one joint,
 * and they never mate across: a stud seats on a stud, a pin's shaft only goes into a pin
 * hole, a bar only into a bar hole. Anything else is not a connection this engine seats.
 *
 * The minifig-bar family also covers the two snaps LDCad uses for hand-held things, which are
 * not cylinders at all: `SNAP_CLP` is the clip a bar is pushed into (a hand, a bar holder) and
 * is always female, and `SNAP_FGR` is the friction grip a hand closes round — a blaster's
 * handle, a combat knife's shaft — and is the male half of the same joint.
 */
const snapFamily = (s: Snap): ConnectorType | null => {
  if (s.length <= 0 || !s.shapes.length) return null;
  // a hinge brick's pin and knuckle hole (3830 / 3831): wider than a stud and long. Checked
  // before the stud rule, which would take the hole for an anti-stud
  if (isHingePin(s)) return 'hinge';
  if (isStudSnap(s)) return 'stud';
  if (s.kind === 'clp') return s.gender === 'F' ? 'bar' : null;
  // a finger hinge (3937 / 3938, 4275 / 4276) is a friction grip with both halves described:
  // the knuckles of one take the other's
  if (s.kind === 'fgr') return 'bar';
  if (s.kind !== 'cyl') return null;
  // a pin's friction ridges are extra sections (`L_`, `_L`); its shaft is the round one,
  // and that is the part the 8 LDU hole takes
  if (!s.shapes.some((x) => x === 'R')) return null;
  if (Math.abs(s.radius - 8) <= 0.6) return 'pin';
  // a minifig bar is 3.2 mm, 4 LDU: a sword's grip, a scabbard's peg, a minifig hand's grip,
  // and the round hole in the end of a Technic pin that takes one. The 4 LDU hollow inside a
  // stud is only 4 long and is not a bar, so a bar column has to have some length.
  return Math.abs(s.radius - 4) <= 0.6 && s.length >= 8 ? 'bar' : null;
};

/**
 * Whether a bore runs the whole way through the part — a Technic pin's hole, a Technic
 * brick's axle hole. A through bore takes a bar or a pin from either end, so it needs a seat
 * at both; a blind one only where the library says it opens.
 */
function throughBore(body: Box, axis: readonly number[], length: number): boolean {
  const k = [0, 1, 2].reduce((best, i) => (Math.abs(axis[i]) > Math.abs(axis[best]) ? i : best), 0);
  return length >= body.max[k] - body.min[k] - 1;
}

const unit = (v: readonly number[]): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const same = (a: Connector, b: Connector) => a.gender === b.gender &&
  Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) <= 1 &&
  a.axis[0] * b.axis[0] + a.axis[1] * b.axis[1] + a.axis[2] * b.axis[2] > 0.999;

const cache = new WeakMap<PartMetrics, Connector[]>();

/** Every stud, anti-stud, pin shaft and Technic hole of a part, from its measured studs, its socket grid and its shadow snaps (deduped). */
export function partConnectors(m: PartMetrics): Connector[] {
  const hit = cache.get(m);
  if (hit) return hit;
  const out: Connector[] = [];
  const add = (c: Connector) => { if (!out.some((o) => same(o, c))) out.push(c); };
  for (const s of m.studs ?? []) add({ pos: [...s.base] as Vec3, axis: unit([s.tip[0] - s.base[0], s.tip[1] - s.base[1], s.tip[2] - s.base[2]]), gender: 'M', type: 'stud' });
  for (const p of socketsOf(m.body)) add({ pos: [p[0], p[1], p[2]], axis: [0, 1, 0], gender: 'F', type: 'stud' });
  // shadow snaps: a male's sections run out of the part, a female's run into it
  for (const s of m.snaps ?? []) {
    const type = snapFamily(s);
    if (!type) continue;
    const a = unit(s.axis);
    const grip = s.kind === 'clp' || s.kind === 'fgr';
    const joint = s.kind === 'fgr' ? `fgr:${s.start.map((v) => v.toFixed(2))}:${a.map((v) => v.toFixed(3))}` : undefined;
    add({ pos: [...s.start] as Vec3, axis: s.gender === 'M' ? a : [-a[0] || 0, -a[1] || 0, -a[2] || 0], gender: s.gender, type, ...(grip ? { grip } : {}), ...(joint ? { joint } : {}) });
    // the library describes a bore from one end; a through hole takes the column from either.
    // A finger hinge's far end turns the other half round: the engine only takes it when the
    // same-way seat on that hinge is blocked (see `flip`).
    if (s.gender === 'F' && type !== 'stud' && throughBore(m.body, a, s.length)) {
      add({
        pos: [s.start[0] + a[0] * s.length, s.start[1] + a[1] * s.length, s.start[2] + a[2] * s.length],
        axis: a, gender: 'F', type, ...(joint ? { joint, flip: true, grip } : {}),
      });
    }
  }
  cache.set(m, out);
  return out;
}

/**
 * The joint key a hinge or ball snap mates by, as LDCad: the same group, or with no group on
 * either side `match=size` and the same radius. null: nothing would mate it.
 */
const fitOf = (s: Snap): string | null =>
  s.group ? `g:${s.group.toLowerCase()}` : s.match?.toLowerCase() === 'size' ? `r:${s.radius.toFixed(1)}` : null;

/** The centre of a joint snap: a ball's centre, a hinge's pivot (the middle of its span). */
export const jointCentre = (s: Snap): Vec3 =>
  [s.start[0] + s.axis[0] * s.length / 2, s.start[1] + s.axis[1] * s.length / 2, s.start[2] + s.axis[2] * s.length / 2];

/**
 * A part's joint snaps for placement and its collision allowance: its LDCad balls, and the
 * BrickNet fallback hinges and balls (`bricknetJoints.ts`) where LDCad has none. LDCad
 * fingers stay what they are in the placement engine (a hand's grip, `bar`): their halves
 * carry no consistent gender.
 */
export function jointSnaps(part: string, snaps: readonly Snap[] | undefined): Snap[] {
  return [...(snaps ?? []).filter(isBall), ...bricknetJointSnaps(part, snaps)];
}

const jointCache = new WeakMap<PartMetrics, Connector[]>();
/** The hinges and balls a part can be placed by or onto (part space). */
export function jointConnectors(m: PartMetrics): Connector[] {
  const hit = jointCache.get(m);
  if (hit) return hit;
  const out: Connector[] = [];
  for (const s of jointSnaps(m.id, m.snaps)) {
    const fit = fitOf(s);
    if (!fit) continue;
    out.push({ pos: jointCentre(s), axis: unit(s.axis), gender: s.gender, type: s.kind === 'fgr' ? 'knuckle' : 'ball', fit });
  }
  jointCache.set(m, out);
  return out;
}

const placeCache = new WeakMap<PartMetrics, Connector[]>();
/**
 * What drag placement seats a part by: its studs, pins and bars, plus its hinges and balls.
 * The other users of `partConnectors` (fit, attachments, build order) keep to the first three.
 */
export function placementConnectors(m: PartMetrics): Connector[] {
  const hit = placeCache.get(m);
  if (hit) return hit;
  const joints = jointConnectors(m);
  const out = joints.length ? [...partConnectors(m), ...joints] : partConnectors(m);
  placeCache.set(m, out);
  return out;
}

/** Connectors moved by a column-major 4x4 (LDU). */
export function worldConnectors(list: readonly Connector[], e: ArrayLike<number>): Connector[] {
  return list.map((c) => {
    const p = c.pos, a = c.axis;
    return {
      ...c,
      pos: [e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12], e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13], e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]],
      axis: unit([e[0] * a[0] + e[4] * a[1] + e[8] * a[2], e[1] * a[0] + e[5] * a[1] + e[9] * a[2], e[2] * a[0] + e[6] * a[1] + e[10] * a[2]]),
    };
  });
}

const subCache = new WeakMap<Step[], Connector[]>();

/** Connectors of a submodel's parts, in the submodel frame; cached per version of its steps. */
export function submodelConnectors(plan: Plan, name: string, metrics: Metrics, colors: Map<number, ColorDef>): Connector[] {
  const steps = modelSteps(plan, name);
  const hit = subCache.get(steps);
  if (hit) return hit;
  const view = assemble({ ...plan, steps }, metrics, colors);
  const out = view.instances.filter((i) => !i.placeholder).flatMap((i) => worldConnectors(partConnectors(metrics(i.part)), i.world.elements));
  subCache.set(steps, out);
  return out;
}
