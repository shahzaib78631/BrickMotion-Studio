/**
 * Mechanism laws as equations on joint coordinates (the v6 "mechanics",
 * moved into the unified solver). Each law is f(x) = 0 over a few scalar
 * coordinates, scaled like the geometry (rotations x UNIT LDU per radian).
 * Stops, ratchets and backlash are inequalities handled by the solver's
 * active set instead of penalty residuals, so a joint rests exactly on its
 * stop and an undriven gear stays put inside its tooth clearance.
 */
import { UNIT } from '../mobility/screw';
import { sliderCrankTravel, scotchYokeTravel, camProfileTravel, intermittentIndexTravel, differentialDriveTravel } from '../v8/mechanismLaws';
import type { Coord } from './system';

/** v6/v7 authored mechanical relationships between hinge and slider coordinates. */
export type SpatialMechanic = (
  | { kind: 'gear'; input: string; output: string; inputTeeth: number; outputTeeth: number; internal?: boolean }
  | { kind: 'bevel-gear'; input: string; output: string; inputTeeth: number; outputTeeth: number; reversed?: boolean }
  | { kind: 'belt' | 'chain'; input: string; output: string; inputTeeth: number; outputTeeth: number; crossed?: boolean }
  | { kind: 'worm'; input: string; output: string; starts: number; wheelTeeth: number; reversed?: boolean }
  | { kind: 'cv-joint'; input: string; output: string; reversed?: boolean }
  | { kind: 'clutch'; input: string; output: string; engaged: boolean; reversed?: boolean }
  | { kind: 'universal-drive'; input: string; output: string; bendAngleRad: number; reversed?: boolean }
  | { kind: 'rack-pinion'; rotary: string; linear: string; pitchRadiusLdu: number; reversed?: boolean }
  | { kind: 'wheel-rolling'; rotary: string; linear: string; wheelRadiusLdu: number; reversed?: boolean }
  | { kind: 'screw'; rotary: string; linear: string; leadLduPerTurn: number; reversed?: boolean }
  | { kind: 'winch'; rotary: string; linear: string; drumRadiusLdu: number; supportedSegments: number; reversed?: boolean }
  | { kind: 'differential'; carrier: string; left: string; right: string }
  | { kind: 'ackermann-steering'; input: string; left: string; right: string; wheelbaseLdu: number; trackWidthLdu: number }
  | { kind: 'planetary'; sun: string; ring: string; carrier: string; sunTeeth: number; ringTeeth: number }
  | { kind: 'cam-follower'; cam: string; follower: string; liftLdu: number; lobes: number; phaseRad?: number; reversed?: boolean }
  | { kind: 'stop'; joint: string; min: number; max: number }
  | { kind: 'brake'; joint: string; engaged: boolean }
  | { kind: 'ratchet'; joint: string; direction: 'positive' | 'negative'; engaged?: boolean }
  | { kind: 'slider-crank'; crank: string; slider: string; crankRadiusLdu: number; rodLengthLdu: number; guideOffsetLdu?: number; reversed?: boolean }
  | { kind: 'scotch-yoke'; crank: string; slider: string; radiusLdu: number; phaseRad?: number; reversed?: boolean }
  | { kind: 'linear-coupler'; input: string; output: string; ratio: number }
  | { kind: 'hydraulic-pair'; first: string; second: string; areaFirst: number; areaSecond: number }
  | { kind: 'backlash-gear'; input: string; output: string; inputTeeth: number; outputTeeth: number; clearanceRad: number; internal?: boolean }
  | { kind: 'detent'; joint: string; pitch: number; engaged: boolean }
  | { kind: 'cam-profile'; cam: string; follower: string; profileLdu: number[]; lobes?: number; phaseRad?: number; reversed?: boolean }
  | { kind: 'intermittent-indexer'; input: string; output: string; slots: number; activeFraction: number; phaseRad?: number; reversed?: boolean }
  | { kind: 'differential-drive'; left: string; right: string; forward: string; yaw: string; wheelRadiusLdu: number; trackWidthLdu: number }
) & { id: string };

/** f(x) = 0 over `coords`; `grad` (rows x coords) when known in closed form; `rows` names each row (`id:name`). */
export type Law = { id: string; coords: Coord[]; f(x: readonly number[]): number[]; grad?(x: readonly number[]): number[][]; rows?: string[] };
/** lo <= a . x <= hi; `scale` converts the row to LDU. */
export type Inequality = { id: string; coords: Coord[]; a: number[]; lo: number; hi: number; scale: number };

export type LawContext = {
  coordOf(joint: string): Coord;
  isHinge(joint: string): boolean;
  /** Last accepted value of a joint (continuation). */
  accepted(joint: string): number;
  /** Commanded value of a joint in this solve, if driven. */
  drive(joint: string): number | undefined;
  /** Pawl position of a ratchet law. */
  ratchetStop(law: string): number;
};

/** Values and gradient; laws without a closed-form gradient use central differences. */
export function evaluateLaw(law: Law, x: readonly number[]): { values: number[]; grad: number[][] } {
  const values = law.f(x);
  if (law.grad) return { values, grad: law.grad(x) };
  const grad = values.map(() => x.map(() => 0));
  x.forEach((xk, k) => {
    const h = 1e-6 * Math.max(1, Math.abs(xk)), up = [...x], dn = [...x];
    up[k] += h; dn[k] -= h;
    const a = law.f(up), b = law.f(dn);
    values.forEach((_, r) => { grad[r][k] = (a[r] - b[r]) / (2 * h); });
  });
  return { values, grad };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const sgn = (reversed?: boolean) => (reversed ? -1 : 1);

export function lawsFromMechanics(mechanics: readonly SpatialMechanic[], ctx: LawContext): { laws: Law[]; inequalities: Inequality[] } {
  const laws: Law[] = [], inequalities: Inequality[] = [];
  const c = ctx.coordOf;
  const unitOf = (joint: string) => (ctx.isHinge(joint) ? UNIT : 1);
  /** Linear law s * (sum k_i x_i) = 0. */
  const linear = (id: string, joints: string[], k: number[], s: number) =>
    laws.push({ id, coords: joints.map(c), f: x => [s * x.reduce((t, v, i) => t + k[i] * v, 0)], grad: () => [k.map(v => s * v)] });
  /** out = g(in), rotational or linear, with optional dg. */
  const follow = (id: string, input: string, output: string, s: number, g: (x: number) => number, dg?: (x: number) => number) =>
    laws.push({
      id, coords: [c(input), c(output)], f: x => [s * (x[1] - g(x[0]))],
      ...(dg ? { grad: (x: readonly number[]) => [[-s * dg(x[0]), s]] } : {}),
    });
  const ratio = (id: string, input: string, output: string, factor: number) =>
    linear(id, [input, output], [-factor, 1], UNIT / Math.max(1, Math.abs(factor)));

  for (const m of mechanics) {
    switch (m.kind) {
      case 'gear': ratio(m.id, m.input, m.output, (m.internal ? 1 : -1) * m.inputTeeth / m.outputTeeth); break;
      case 'bevel-gear': ratio(m.id, m.input, m.output, sgn(m.reversed) * m.inputTeeth / m.outputTeeth); break;
      case 'belt': case 'chain': ratio(m.id, m.input, m.output, (m.kind === 'belt' && m.crossed ? -1 : 1) * m.inputTeeth / m.outputTeeth); break;
      case 'worm': linear(m.id, [m.input, m.output], [-sgn(m.reversed) * m.starts / m.wheelTeeth, 1], UNIT); break;
      case 'cv-joint': linear(m.id, [m.input, m.output], [-sgn(m.reversed), 1], UNIT); break;
      case 'clutch': if (m.engaged) linear(m.id, [m.input, m.output], [-sgn(m.reversed), 1], UNIT); break;
      case 'universal-drive': {
        // Cardan shaft: tan(out) = cos(bend) tan(in), on the input's branch.
        const k = Math.cos(m.bendAngleRad), s = sgn(m.reversed);
        const g = (i: number) => { const e = Math.atan2(k * Math.sin(i), Math.cos(i)); return s * (e + 2 * Math.PI * Math.round((i - e) / (2 * Math.PI))); };
        follow(m.id, m.input, m.output, UNIT, g, i => s * k / (Math.cos(i) ** 2 + k * k * Math.sin(i) ** 2));
        break;
      }
      case 'rack-pinion': linear(m.id, [m.rotary, m.linear], [-sgn(m.reversed) * m.pitchRadiusLdu, 1], 1); break;
      case 'wheel-rolling': linear(m.id, [m.rotary, m.linear], [-sgn(m.reversed) * m.wheelRadiusLdu, 1], 1); break;
      case 'screw': linear(m.id, [m.rotary, m.linear], [-sgn(m.reversed) * m.leadLduPerTurn / (2 * Math.PI), 1], 1); break;
      case 'winch': linear(m.id, [m.rotary, m.linear], [-sgn(m.reversed) * m.drumRadiusLdu / m.supportedSegments, 1], 1); break;
      case 'differential': linear(m.id, [m.left, m.right, m.carrier], [1, 1, -2], UNIT / 2); break;
      case 'ackermann-steering': {
        // Ideal tangent-circle wheels; the input is the centre wheel's angle.
        const W = m.wheelbaseLdu, h = m.trackWidthLdu / 2;
        const side = (sign: number) => (s: number) => Math.atan2(W * Math.sin(s), W * Math.cos(s) + sign * h * Math.sin(s));
        const dside = (sign: number) => (s: number) => {
          const y = W * Math.sin(s), x = W * Math.cos(s) + sign * h * Math.sin(s);
          return (x * W * Math.cos(s) - y * (-W * Math.sin(s) + sign * h * Math.cos(s))) / (x * x + y * y);
        };
        const L = side(-1), R = side(1), dL = dside(-1), dR = dside(1);
        laws.push({
          id: m.id, coords: [c(m.input), c(m.left), c(m.right)], rows: ['left', 'right'],
          f: x => [UNIT * wrap(x[1] - L(x[0])), UNIT * wrap(x[2] - R(x[0]))],
          grad: x => [[-UNIT * dL(x[0]), UNIT, 0], [-UNIT * dR(x[0]), 0, UNIT]],
        });
        break;
      }
      case 'planetary': {
        const t = m.sunTeeth + m.ringTeeth;
        linear(m.id, [m.sun, m.ring, m.carrier], [m.sunTeeth, m.ringTeeth, -t], UNIT / t);
        break;
      }
      case 'cam-follower': {
        const ph = m.phaseRad ?? 0, s = sgn(m.reversed);
        follow(m.id, m.cam, m.follower, 1, a => s * m.liftLdu / 2 * (Math.cos(ph) - Math.cos(m.lobes * a + ph)),
          a => s * m.liftLdu / 2 * m.lobes * Math.sin(m.lobes * a + ph));
        break;
      }
      case 'stop': inequalities.push({ id: m.id, coords: [c(m.joint)], a: [1], lo: m.min, hi: m.max, scale: unitOf(m.joint) }); break;
      case 'brake': if (m.engaged) linear(m.id, [m.joint], [1], unitOf(m.joint)); break;
      case 'ratchet': {
        if (m.engaged === false) break;
        const stop = ctx.ratchetStop(m.id);
        inequalities.push({ id: m.id, coords: [c(m.joint)], a: [1], lo: m.direction === 'positive' ? stop : -Infinity, hi: m.direction === 'positive' ? Infinity : stop, scale: unitOf(m.joint) });
        break;
      }
      case 'slider-crank': {
        const r = m.crankRadiusLdu, L = m.rodLengthLdu, o = m.guideOffsetLdu ?? 0, s = sgn(m.reversed);
        follow(m.id, m.crank, m.slider, 1, a => s * sliderCrankTravel(a, r, L, o), a => {
          const q = o - r * Math.sin(a), root = Math.sqrt(Math.max(1e-12, L * L - q * q));
          return s * (-r * Math.sin(a) + q * r * Math.cos(a) / root);
        });
        break;
      }
      case 'scotch-yoke': {
        const ph = m.phaseRad ?? 0, s = sgn(m.reversed);
        follow(m.id, m.crank, m.slider, 1, a => s * scotchYokeTravel(a, m.radiusLdu, ph), a => s * m.radiusLdu * Math.cos(a + ph));
        break;
      }
      case 'linear-coupler': linear(m.id, [m.input, m.output], [-m.ratio, 1], 1); break;
      case 'hydraulic-pair': linear(m.id, [m.first, m.second], [m.areaFirst, m.areaSecond], 1 / Math.max(m.areaFirst, m.areaSecond)); break;
      case 'backlash-gear': {
        const factor = (m.internal ? 1 : -1) * m.inputTeeth / m.outputTeeth;
        inequalities.push({ id: m.id, coords: [c(m.input), c(m.output)], a: [-factor, 1], lo: -m.clearanceRad, hi: m.clearanceRad, scale: UNIT });
        break;
      }
      case 'detent': {
        if (!m.engaged) break;
        // The nearest click of the command (or of the last pose), not of the trial pose.
        const target = m.pitch * Math.round((ctx.drive(m.joint) ?? ctx.accepted(m.joint)) / m.pitch), s = unitOf(m.joint);
        laws.push({ id: m.id, coords: [c(m.joint)], f: x => [s * (x[0] - target)], grad: () => [[s]] });
        break;
      }
      case 'cam-profile': {
        const ph = m.phaseRad ?? 0, s = sgn(m.reversed);
        follow(m.id, m.cam, m.follower, 1, a => s * camProfileTravel(a, m.profileLdu, ph, m.lobes ?? 1));
        break;
      }
      case 'intermittent-indexer': {
        const ph = m.phaseRad ?? 0, s = sgn(m.reversed);
        follow(m.id, m.input, m.output, UNIT, a => s * intermittentIndexTravel(a, m.slots, m.activeFraction, ph));
        break;
      }
      case 'differential-drive': {
        const r = m.wheelRadiusLdu, w = m.trackWidthLdu;
        laws.push({
          id: m.id, coords: [c(m.left), c(m.right), c(m.forward), c(m.yaw)], rows: ['forward', 'yaw'],
          f: x => { const t = differentialDriveTravel(x[0], x[1], r, w); return [x[2] - t.forward, UNIT * (x[3] - t.yaw)]; },
          grad: () => [[-r / 2, -r / 2, 1, 0], [UNIT * r / w, -UNIT * r / w, 0, UNIT]],
        });
        break;
      }
    }
  }
  return { laws, inequalities };
}
