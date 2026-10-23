import type { Vec3 as Way } from '../ldraw/parse';

/** A bounded local contact tube, never an exemption for an entire part. */
export type JointContact = {
  origin: Way; axis: Way; length: number; radius: number;
  tolerance: number; normalRatio: number; minRadius?: number;
};
export type JointPair = { piece: JointContact; neighbour: JointContact };
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, k) => s + v * b[k], 0);
const unit = (v: number[]): Way => v.map((n) => n / Math.hypot(...v)) as Way;
const direction = (m: readonly number[], v: Way): Way => unit([
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
]);
const canonical = (id: string) => id.toLowerCase().replace(/\.dat$/, '').split('/').pop();
const validDirection = (v: readonly number[]) => v.length === 3 && v.every(Number.isFinite) && Math.hypot(...v) > 1e-8;
const validAffine = (m: readonly number[]) => m.length === 16 && m.every(Number.isFinite) &&
  [3,7,11].every((k) => Math.abs(m[k]) < 1e-8) && Math.abs(m[15]-1) < 1e-8 &&
  [0,4,8].every((c) => Math.abs(Math.hypot(m[c],m[c+1],m[c+2])-1) <= 0.06) &&
  [[0,4],[0,8],[4,8]].every(([a,b]) => Math.abs(m[a]*m[b]+m[a+1]*m[b+1]+m[a+2]*m[b+2]) <= 0.06);


/**
 * Recognise only a 3820 wrist post seated in the matching 3818/3819 bore.
 * The anchor and bore direction are in the arm's LDraw frame. This compensates
 * for bounded rounded-import contact at that joint, not bad placement elsewhere.
 * rel = inverse(arm.world) * hand.world; wayLocal is the withdrawal in arm space.
 */
export function wristContact(hand: string, arm: string, rel: readonly number[], wayLocal: Way): JointPair | null {
  if (canonical(hand) !== '3820' || !['3818', '3819'].includes(canonical(arm) ?? '')) return null;
  if (!validAffine(rel) || !validDirection(wayLocal)) return null;
  const origin: Way = [canonical(arm) === '3818' ? -5 : 5, 18.9, -9.9];
  const bore: Way = [0, -Math.SQRT1_2, Math.SQRT1_2];
  if (Math.hypot(rel[12] - origin[0], rel[13] - origin[1], rel[14] - origin[2]) > 0.3) return null;
  const post = direction(rel, [0, 0, 1]);
  // At most three degrees of import rounding; do not treat arbitrary bent pins
  // or scaled geometry as valid connectors.
  if (dot(post, bore) < Math.cos(Math.PI / 60)) return null;
  if (dot(unit(wayLocal), post) > -0.999) return null;
  for (const c of [0, 4, 8]) if (Math.abs(Math.hypot(rel[c], rel[c + 1], rel[c + 2]) - 1) > 0.06) return null;
  return {
    piece: { origin: [0, 0, 0], axis: [0, 0, 1], length: 13, radius: 3.3, tolerance: 0.7, normalRatio: 0.003 },
    neighbour: { origin, axis: bore, length: 15, radius: 3.3, tolerance: 0.7, normalRatio: 0.003 },
  };
}

/** A specific hair sleeve, only in its coaxial seated head frame. */
export function hairContact(hair: string, head: string, rel: readonly number[], wayLocal: Way): JointPair | null {
  if (canonical(hair) !== '4530' || !/^3626(?:[a-z]|$)/.test(canonical(head) ?? '')) return null;
  if (!validAffine(rel) || !validDirection(wayLocal) ||
      [0,1,2,4,5,6,8,9,10].some((k) => Math.abs(rel[k] - ([0,5,10].includes(k) ? 1 : 0)) > 0.005) ||
      Math.hypot(rel[12], rel[13], rel[14]) > 0.1 || dot(unit(wayLocal), [0,-1,0]) < 0.999) return null;
  const tube: JointContact = { origin: [0,1,0], axis: [0,1,0], length: 21, radius: 13.4, minRadius: 11.8,
    tolerance: 0.7, normalRatio: 0.1 };
  return {piece: tube, neighbour: tube};
}

const GRIP_CENTER: Way = [0, -0.8229, -9.8948];
const GRIP_AXIS: Way = [0, 0.968148, 0.25038];
const point = (m: readonly number[], v: Way): Way => [
  m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12],
  m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13],
  m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14],
];

/** Known cylindrical cup handle. Recognition is geometric, not nearest-box guessing. */
export function cupGripFits(cup: readonly number[], hand: readonly number[]): boolean {
  if (!validAffine(cup) || !validAffine(hand)) return false;
  const c = point(hand, GRIP_CENTER), a = point(cup, [0,4,20]), b = point(cup, [0,18,20]);
  const delta = b.map((v,k) => v-a[k]), length = Math.hypot(...delta), axis = unit(delta);
  const t = dot(c.map((v,k) => v-a[k]), axis);
  return length > 12 && length < 16 && t >= 1 && t <= length-1 &&
    Math.abs(dot(direction(hand, GRIP_AXIS),axis)) > Math.cos(Math.PI/60) &&
    Math.hypot(...c.map((v,k) => v-a[k]-t*axis[k])) <= 0.8;
}

/** Small contact allowance only around a correctly fitted cup handle and grip. */
export function cupGripContact(part: string, hand: string, rel: readonly number[], wayLocal: Way): JointPair | null {
  if (canonical(part) !== '3899' || canonical(hand) !== '3820') return null;
  const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  if (!validDirection(wayLocal) || !cupGripFits(rel, identity) || Math.abs(dot(unit(wayLocal),direction(rel,[0,1,0]))) < 0.999) return null;
  return {
    piece: { origin:[0,4,20], axis:[0,1,0], length:14, radius:4.8, tolerance:0.7, normalRatio:0.003 },
    neighbour: { origin:GRIP_CENTER.map((v,k) => v - 6*GRIP_AXIS[k]) as Way, axis:unit(GRIP_AXIS), length:12, radius:4.8, tolerance:0.7, normalRatio:0.003 },
  };
}

/** Entire interval must stay in the local contact region, including its inner boundary. */
export function inJointContact(joint: JointContact, o: readonly number[], d: readonly number[], lo: number, hi: number): boolean {
  if (![...joint.origin, ...joint.axis, joint.length, joint.radius, joint.tolerance, joint.normalRatio,
        ...o, ...d, lo, hi, joint.minRadius ?? 0].every(Number.isFinite) || hi < lo || joint.radius <= 0 ||
      joint.length < 0 || joint.tolerance <= 0 || joint.normalRatio < 0 || joint.normalRatio > 0.1 ||
      (joint.minRadius ?? 0) < 0 || (joint.minRadius ?? 0) > joint.radius ||
      o.length !== 3 || d.length !== 3 || joint.axis.length !== 3 || joint.origin.length !== 3 ||
      Math.abs(dot(joint.axis, joint.axis) - 1) > 1e-6) return false;
  const radial = (t: number) => {
    const p = o.map((v, k) => v + d[k] * t - joint.origin[k]);
    const axial = dot(p, joint.axis);
    return {axial, r: p.map((v,k) => v - axial * joint.axis[k])};
  };
  const a = radial(lo), b = radial(hi);
  if (![a,b].every((p) => p.axial >= -0.3 && p.axial <= joint.length + 0.3 && dot(p.r,p.r) <= joint.radius ** 2)) return false;
  if (joint.minRadius) {
    const step = b.r.map((v,k) => v - a.r[k]), speed = dot(step,step);
    const t = speed > 1e-20 ? Math.max(0, Math.min(1, -dot(a.r,step) / speed)) : 0;
    const closest = a.r.map((v,k) => v + t * step[k]);
    if (dot(closest,closest) < joint.minRadius ** 2) return false;
  }
  return true;
}
