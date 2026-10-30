/**
 * Ready-to-drive suggestions from named mechanisms (spec section E).
 *
 * Each named mechanism becomes a program for the mechanism solver:
 *
 *   - its bodies' joints form a tree grown out from the static frame (slides
 *     first, then hinges, then balls), and every joint left over closes a
 *     loop as a point closure;
 *   - its gear, bevel and rack meshes become transmissions, each turning
 *     the way its measured contact point says;
 *   - whatever a moving body carries on its own (a wheel on a hub, a CV
 *     axle on a drive shaft) follows it rigidly.
 *
 * The driver is the mechanism's input: a knob or steering wheel, the crank,
 * the wishbone a suspension's wheel hangs from, or a wheel for a drive train.
 * A suggestion is offered only after it is solved over its whole travel with
 * every loop closed and every mesh still engaged at every frame.
 */
import * as THREE from 'three';
import type { Assembly } from '../../../model/assemble';
import type { Recognition } from '../mobility/recognise';
import type { HigherPair } from '../pairs/higherPairs';
import { engaged } from '../pairs/higherPairs';
import type { Screw } from '../parts/actuators';
import { worldFeatures } from '../gears/gearTable';
import type { MechanismGraph } from '../v4/mechanismGraph';
import type { JointDrive, LoopClosure, MechanismProgram, TransmissionConstraint, Vec3 } from '../v4/mechanismProgram';
import { MechanismSolver } from '../v4/mechanismSolver';
import { provenSuggestion, MAX_HINGE_CARRIED, type SuggestedMechanism } from '../v4/autoMechanics';
import type { NamedMechanism } from './patterns';

type V3 = [number, number, number];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: readonly number[], b: readonly number[], s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: readonly number[]): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** Off the axis line by more than this (LDU), a point is not on it. */
const ON_LINE = 2.5;
/** Axes within 4 degrees are parallel. */
const PARALLEL = Math.cos((4 * Math.PI) / 180);
const parallel = (a: readonly number[], b: readonly number[]) => Math.abs(dot(unit(a), unit(b))) >= PARALLEL;
const offLine = (p: readonly number[], point: readonly number[], axis: readonly number[]) => {
  const d = sub(p, point), u = unit(axis);
  return len(add(d, u, -dot(d, u)));
};
/** Driver travel tried, largest first: radians for a hinge, LDU for a slide. */
const TURNS = [Math.PI / 2, Math.PI / 4, Math.PI / 8, Math.PI / 16, Math.PI / 32];
const SLIDES = [40, 20, 10, 5, 2];
const STATIC = -1;
/** A joint between two units (STATIC for the frame); `ka`/`kb` are the recognition bodies it joins. */
type Joint = { a: number; b: number; ka: number; kb: number; kind: 'revolute' | 'prismatic' | 'spherical'; axis?: V3; point?: V3; index: number };
/** One suggestion to build: which bodies move, which meshes couple them, what drives it, what turns as one. */
type Plan = {
  title: string; mechanism: { kind: string; name: string };
  bodies: number[]; pairs: HigherPair[]; driver: number; outputs: number[];
  /** Bodies that turn as one (a differential when the vehicle drives straight). */
  lock?: number[];
  /** The mechanism's own frame (a four-bar's fixed link, a turntable's base) when it is not the model's main body. */
  frame?: number;
  warnings: string[];
};

export function suggestMechanisms(asm: Assembly, graph: MechanismGraph, named: readonly NamedMechanism[],
  pairs: readonly HigherPair[], screws: readonly Screw[]): SuggestedMechanism[] {
  const rec = graph.recognition;
  if (!rec) return [];
  void screws; // Linear actuators with a known input and piston arrive as screw pairs.
  const byId = new Map(pairs.map(p => [p.id, p]));
  const out: SuggestedMechanism[] = [];
  for (const plan of plans(rec, named, byId)) {
    const s = build(asm, graph, rec, plan);
    if (s) out.push(s);
  }
  return sided(asm, out);
}

/** Mirror-image mechanisms (left and right suspension) share a name: tell them apart by the side their driver is on. */
function sided(asm: Assembly, list: SuggestedMechanism[]): SuggestedMechanism[] {
  const mid = asm.instances.reduce((s, i) => s + i.world.elements[12], 0) / (asm.instances.length || 1);
  const x = (s: SuggestedMechanism) => {
    const j = s.program.joints.find(k => k.id === s.program.driver.joint)!;
    return asm.instances.find(i => i.key === j.body)!.world.elements[12];
  };
  const count = new Map<string, number>();
  for (const s of list) count.set(s.title, (count.get(s.title) ?? 0) + 1);
  const used = new Set<string>();
  return list.map(s => {
    if (count.get(s.title)! < 2) return s;
    let title = `${s.title} — ${x(s) < mid ? 'left' : 'right'}`;
    for (let n = 2; used.has(title); n++) title = `${s.title} — ${x(s) < mid ? 'left' : 'right'} ${n}`;
    used.add(title);
    return { ...s, title };
  });
}

/** What to build: drive trains joined up (engine, gears, differential), the rest one each. */
function plans(rec: Recognition, named: readonly NamedMechanism[], byId: ReadonlyMap<string, HigherPair>): Plan[] {
  const ground = groundOf(rec);
  const pairsOf = (m: NamedMechanism) => m.pairs.flatMap(id => byId.get(id) ?? []);
  // Drive trains: engines, gear trains and differentials that share a moving body.
  const drive = named.filter(m => m.kind === 'piston-engine' || m.kind === 'gear-train' || m.kind === 'differential');
  const group = drive.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i])));
  for (let i = 0; i < drive.length; i++) for (let k = i + 1; k < drive.length; k++)
    if (drive[i].bodies.some(b => b !== ground && drive[k].bodies.includes(b))) group[find(i)] = find(k);
  const joined = new Set<NamedMechanism>();
  const out: Plan[] = [];
  for (const root of new Set(drive.map((_, i) => find(i)))) {
    const members = drive.filter((_, i) => find(i) === root);
    const diff = members.find(m => m.kind === 'differential'), engine = members.find(m => m.kind === 'piston-engine');
    if (members.length < 2 || !diff) continue;
    members.forEach(m => joined.add(m));
    const what = engine ?? members.find(m => m.kind === 'gear-train')!;
    out.push({
      title: `Drive train — axle → differential → gears → ${engine ? engine.name.replace(/^Piston engine — /, 'piston engine, ') : what.name}`,
      mechanism: { kind: what.kind, name: what.name },
      bodies: [...new Set(members.flatMap(m => m.bodies))], pairs: [...new Set(members.flatMap(pairsOf))],
      driver: diff.outputs[0], outputs: engine ? engine.outputs : what.outputs,
      lock: diff.bodies.filter(b => b !== ground),
      warnings: ['Driven as a vehicle driving straight: both axles turn together, so the differential turns as one.'],
    });
  }
  for (const m of named) {
    if (joined.has(m) || m.kind === 'differential' || m.kind === 'worm-drive') continue;
    // An actuator with no input turning it is only a hinge on its mounting.
    if (m.kind === 'linear-actuator' && !m.drivers.length) continue;
    const driver = m.drivers[0] ?? m.bodies.find(b => b !== ground);
    if (driver === undefined) continue;
    const fixed = m.kind === 'turntable' ? m.bodies.find(b => b !== driver) : m.parts?.frame ? rec.bodyOf.get(m.parts.frame[0]) : undefined;
    out.push({ title: m.name, mechanism: { kind: m.kind, name: m.name }, bodies: m.bodies, pairs: pairsOf(m), driver, outputs: m.outputs,
      ...(fixed !== undefined && fixed !== ground ? { frame: fixed } : {}), warnings: [] });
  }
  return out;
}

const groundOf = (rec: Recognition) => rec.bodies.reduce((best, b, i) => (b.length > rec.bodies[best].length ? i : best), 0);

function build(asm: Assembly, graph: MechanismGraph, rec: Recognition, plan: Plan): SuggestedMechanism | null {
  const ground = groundOf(rec);
  const instance = new Map(asm.instances.map(i => [i.key, i]));
  const warnings = [...plan.warnings];

  // --- Units: recognition bodies, with locked groups merged.
  const unitOf = rec.bodies.map((_, i) => i);
  for (const b of plan.lock ?? []) unitOf[b] = Math.min(...(plan.lock ?? []));
  const moving = new Set(plan.bodies.filter(b => b !== ground && b !== plan.frame).map(b => unitOf[b]));
  if (!moving.size) return null;
  const inMoving = (b: number) => moving.has(unitOf[b]);
  // A body hanging off one other moving body, with no mesh on it (a wheel on its hub), would spin
  // freely with nothing to drive it: it is carried by that body instead.
  const meshed = new Set(plan.pairs.flatMap(p => [p.a, p.b]).flatMap(k => { const b = rec.bodyOf.get(k); return b === undefined ? [] : [unitOf[b]]; }));
  const carrier = new Map<number, number>();
  for (let pruned = true; pruned;) {
    pruned = false;
    for (const u of moving) {
      if (meshed.has(u) || moving.size < 2) continue;
      const next = new Set<number>();
      for (const j of rec.joints) {
        const [x, y] = unitOf[j.a] === u ? [j.a, j.b] : unitOf[j.b] === u ? [j.b, j.a] : [-1, -1];
        if (x >= 0 && unitOf[y] !== u) next.add(inMoving(y) ? unitOf[y] : -1 - y);
      }
      const [only] = next;
      if (next.size !== 1 || only < 0) continue;
      moving.delete(u); carrier.set(u, only); pruned = true;
    }
  }
  const carriedTo = (u: number): number => (carrier.has(u) ? carriedTo(carrier.get(u)!) : u);

  // --- Everything else: carried by one moving unit, or static.
  const carriedBy = new Map<number, number>();
  const around = rec.bodies.map(() => [] as number[]);
  rec.joints.forEach((j, e) => { around[j.a].push(e); around[j.b].push(e); });
  const seen = new Set<number>();
  for (let start = 0; start < rec.bodies.length; start++) {
    if (seen.has(start) || inMoving(start)) continue;
    const comp = [start], touches = new Set<number>();
    seen.add(start);
    let hasGround = false, parts = 0;
    for (let i = 0; i < comp.length; i++) {
      const x = comp[i];
      if (x === ground) hasGround = true;
      parts += rec.bodies[x].length;
      for (const e of around[x]) {
        const y = rec.joints[e].a === x ? rec.joints[e].b : rec.joints[e].a;
        if (inMoving(y)) { touches.add(unitOf[y]); continue; }
        if (!seen.has(y)) { seen.add(y); comp.push(y); }
      }
    }
    if (!hasGround && touches.size === 1 && parts <= MAX_HINGE_CARRIED) for (const x of comp) carriedBy.set(x, [...touches][0]);
  }
  const node = (b: number) => (inMoving(b) ? unitOf[b] : carriedBy.has(b) ? null : STATIC);

  // --- Joints between units (or a unit and the frame).
  const joints: Joint[] = [];
  rec.joints.forEach((j, index) => {
    const a = node(j.a), b = node(j.b);
    if (a === null || b === null || a === b || (a === STATIC && b === STATIC)) return;
    const kind = j.joint.kind === 'revolute' || j.joint.kind === 'prismatic' || j.joint.kind === 'spherical' ? j.joint.kind : null;
    if (!kind) { joints.push({ a, b, ka: j.a, kb: j.b, kind: 'spherical', index: -1 }); return; } // unusable: fails below if needed
    joints.push({ a, b, ka: j.a, kb: j.b, kind, axis: j.joint.axis, point: j.joint.point, index });
  });
  // A rack held only by its tie rods slides in a guide the connector data misses: along its teeth.
  for (const p of plan.pairs) {
    if (p.kind !== 'rack') continue;
    const R = rec.bodyOf.get(p.b);
    if (R === undefined || !inMoving(R) || joints.some(j => j.kind === 'prismatic' && (j.a === unitOf[R] || j.b === unitOf[R]))) continue;
    const rack = instance.get(p.b), f = rack && worldFeatures(p.b, rack.part, rack.world)[p.featureB];
    if (!f || f.kind !== 'rack') return null;
    joints.push({ a: unitOf[R], b: STATIC, ka: R, kb: ground, kind: 'prismatic', axis: f.axis, index: Infinity });
    warnings.push('The rack\'s guide is not in the connector data; it is taken to slide along its teeth.');
  }

  // --- The driver: the planned input if it turns on the frame; else the lowest arm on the frame it hangs
  // from (a wheel hub is driven at its lower wishbone, where the road pushes); else the nearest body toward
  // the outputs that turns on the frame.
  const onFrame = (u: number) => joints.find(j => (j.a === u || j.b === u) && (j.a === STATIC || j.b === STATIC) && j.kind !== 'spherical');
  let driver = carriedTo(unitOf[plan.driver]);
  if (!moving.has(driver)) return null;
  const arms = joints.filter(j => j.a === driver || j.b === driver).map(j => (j.a === driver ? j.b : j.a))
    .filter(u => u !== STATIC && onFrame(u)?.point).map(u => ({ u, joint: onFrame(u)! }))
    .sort((p, q) => q.joint.point![1] - p.joint.point![1] || p.joint.index - q.joint.index);
  if (!onFrame(driver) && arms.length) driver = arms[0].u;
  else if (!onFrame(driver)) {
    const goal = new Set(plan.outputs.map(b => unitOf[b]));
    const via = new Map<number, number>([[driver, -2]]), queue = [driver];
    let found: number | null = null;
    while (queue.length && found === null) {
      const x = queue.shift()!;
      for (const j of joints) {
        const y = j.a === x ? j.b : j.b === x ? j.a : null;
        if (y === null || y === STATIC || via.has(y)) continue;
        via.set(y, x); queue.push(y);
        if (goal.has(y)) { found = y; break; }
      }
    }
    if (found === null) return null;
    const path: number[] = [];
    for (let x = found; x !== -2; x = via.get(x)!) path.unshift(x);
    const first = path.find(u => onFrame(u));
    if (first === undefined) return null;
    driver = first;
  }
  const driverEdge = onFrame(driver)!;

  // --- The tree: grown out from the frame, the driver's own bearing first, then slides, hinges, balls.
  const ball = (j: Joint) => j.kind === 'spherical';
  const pinned = (j: Joint) => ball(j) && joints.some(k => k !== j && k.kind === 'revolute' && k.axis && k.point && j.point
    && [j.a, j.b].some(u => u !== STATIC && (k.a === u || k.b === u)) && offLine(j.point, k.point, k.axis) <= ON_LINE);
  const order = (j: Joint) => (j === driverEdge ? 0 : j.kind === 'prismatic' ? 1 : j.kind === 'revolute' ? 2 : pinned(j) ? 3 : 4);
  const parentOf = new Map<number, { joint: Joint; parent: number }>();
  const inTree = new Set<number>([STATIC]), used = new Set<Joint>();
  for (;;) {
    let best: Joint | null = null;
    for (const j of joints) {
      if (used.has(j) || j.index < 0 || inTree.has(j.a) === inTree.has(j.b)) continue;
      if (!best || order(j) < order(best) || (order(j) === order(best) && j.index < best.index)) best = j;
    }
    if (!best) break;
    const [parent, child] = inTree.has(best.a) ? [best.a, best.b] : [best.b, best.a];
    parentOf.set(child, { joint: best, parent });
    inTree.add(child); used.add(best);
  }
  if ([...moving].some(u => !inTree.has(u))) return null;
  if (parentOf.get(driver)?.joint !== driverEdge) return null;

  // --- Program joints.
  const key = (b: number) => rec.bodies[b][0];
  const leader = (u: number) => key(u);
  const local = (k: string, p: readonly number[]): Vec3 =>
    new THREE.Vector3(...p).applyMatrix4(instance.get(k)!.world.clone().invert()).toArray() as Vec3;
  const program: JointDrive[] = [];
  const jointOf = new Map<number, JointDrive>();
  const depth = (u: number): number => (u === STATIC ? 0 : 1 + depth(parentOf.get(u)!.parent));
  for (const u of [...moving].sort((x, y) => depth(x) - depth(y) || x - y)) {
    const { joint: j, parent } = parentOf.get(u)!;
    let axis = j.axis, kind: 'revolute' | 'prismatic' = j.kind === 'prismatic' ? 'prismatic' : 'revolute';
    if (j.kind === 'spherical') {
      axis = ballAxis(j, u, parent) ?? undefined;
      if (!axis) return null;
      kind = 'revolute';
    }
    if (!axis || (kind === 'revolute' && !j.point)) return null;
    const drive: JointDrive = { id: `named-${program.length + 1}`, body: leader(u), kind, axis: unit(axis) as Vec3,
      ...(kind === 'revolute' ? { pivot: [...j.point!] as Vec3 } : {}), ...(parent === STATIC ? {} : { parent: leader(parent) }) };
    program.push(drive); jointOf.set(u, drive);
  }
  /** A ball in the tree turns as a hinge: square to its pin and the link (a ball on a pin is a universal joint), or about its planar loop's axis. */
  function ballAxis(j: Joint, child: number, parent: number): V3 | null {
    const up = parentOf.get(parent)?.joint;
    if (parent !== STATIC && up?.kind === 'revolute' && up.axis && up.point && j.point && offLine(j.point, up.point, up.axis) <= ON_LINE) {
      const far = joints.find(k => k !== j && (k.a === child || k.b === child) && k.point && len(sub(k.point, j.point!)) > 4)?.point;
      if (!far) return null;
      const n = cross(up.axis, sub(far, j.point));
      return len(n) > 1e-3 * len(sub(far, j.point)) ? unit(n) : null;
    }
    // Planar loop: every hinge between the two ends (not through this ball) turns about one axis.
    const via = new Map<number, Joint | null>([[parent, null]]), queue = [parent];
    while (queue.length && !via.has(child)) {
      const x = queue.shift()!;
      for (const k of joints) {
        if (k === j || k.index < 0) continue;
        const y = k.a === x ? k.b : k.b === x ? k.a : null;
        if (y === null || via.has(y)) continue;
        via.set(y, k); queue.push(y);
      }
    }
    if (!via.has(child)) return null;
    const axes: V3[] = [];
    for (let x = child; x !== parent;) { const k = via.get(x)!; if (k.kind === 'revolute' && k.axis) axes.push(k.axis); x = k.a === x ? k.b : k.a; }
    return axes.length && axes.every(a => parallel(a, axes[0])) ? unit(axes[0]) : null;
  }

  // --- Closures for the joints left over (a bearing on the same line as the tree's own is not a loop).
  const closures: LoopClosure[] = [];
  const sameLine = (j: Joint, k: Joint) => j.kind === k.kind && j.axis && k.axis && parallel(j.axis, k.axis)
    && (j.kind === 'prismatic' || (j.point && k.point && offLine(j.point, k.point, k.axis) <= ON_LINE));
  const bodyKey = (u: number, b: number) => (u === STATIC ? key(b) : leader(u));
  for (const j of joints) {
    if (used.has(j)) continue;
    if (j.index < 0) return null;
    const redundant = [[j.a, j.b], [j.b, j.a]].some(([x, y]) => x !== STATIC && parentOf.get(x)!.parent === y && sameLine(parentOf.get(x)!.joint, j));
    if (redundant) continue;
    if (j.kind === 'prismatic' || !j.point) return null;
    const ka = bodyKey(j.a, j.ka), kb = bodyKey(j.b, j.kb);
    const points = j.kind === 'revolute' && j.axis ? [j.point, add(j.point, unit(j.axis), 20)] : [j.point];
    for (const p of points) closures.push({ a: { body: ka, local: local(ka, p) }, b: { body: kb, local: local(kb, p) }, toleranceLdu: 0.1 });
  }

  // --- Meshes: a law between the two shafts' joints, turning the way the contact point says.
  const transmissions: TransmissionConstraint[] = [];
  const meshes: HigherPair[] = [];
  for (const p of plan.pairs) {
    const A = rec.bodyOf.get(p.a), B = rec.bodyOf.get(p.b);
    if (A === undefined || B === undefined || unitOf[A] === unitOf[B]) continue;
    const ua = inMoving(A) ? unitOf[A] : null, ub = inMoving(B) ? unitOf[B] : null;
    if (ua === null || ub === null) return null;
    const ja = jointOf.get(ua)!, jb = jointOf.get(ub)!;
    if (ja.parent || jb.parent) return null;
    const ia = instance.get(p.a)!, ib = instance.get(p.b)!;
    const fa = worldFeatures(p.a, ia.part, ia.world)[p.featureA], fb = worldFeatures(p.b, ib.part, ib.world)[p.featureB];
    if (!fa || !fb || fa.kind === 'rack' || ja.kind !== 'revolute' || !ja.pivot) return null;
    if (!parallel(fa.axis, ja.axis) || offLine(fa.centre, ja.pivot, ja.axis) > ON_LINE) return null;
    const turnA = (c: V3) => cross(ja.axis, sub(c, ja.pivot!));
    if (p.kind === 'rack') {
      if (fb.kind !== 'rack' || jb.kind !== 'prismatic' || !parallel(fb.axis, jb.axis)) return null;
      const towards = sub(fb.centre, fa.centre);
      const across = add(add(towards, fb.axis, -dot(towards, fb.axis)), fa.axis, -dot(towards, unit(fa.axis)));
      const v = dot(turnA(add(fa.centre, unit(across), fa.pitchRadius)), unit(jb.axis));
      if (Math.abs(v) < 1e-6) return null;
      transmissions.push({ id: p.id, kind: 'rack-pinion', a: ja.id, b: jb.id, pitchRadiusLdu: p.pitchRadius ?? fa.pitchRadius, ...(v < 0 ? { reversed: true } : {}), source: 'inferred' });
    } else if (p.kind === 'spur' || p.kind === 'bevel' || p.kind === 'crown' || p.kind === 'clutch') {
      if (fb.kind === 'rack' || jb.kind !== 'revolute' || !jb.pivot) return null;
      if (!parallel(fb.axis, jb.axis) || offLine(fb.centre, jb.pivot, jb.axis) > ON_LINE) return null;
      // The pitch point, seen from each gear toward the other, averaged.
      const toward = (from: typeof fa, to: typeof fb) => { const d = sub(to.centre, from.centre); return add(from.centre, unit(add(d, from.axis, -dot(d, unit(from.axis)))), from.pitchRadius); };
      const c = add(toward(fa, fb), sub(toward(fb, fa), toward(fa, fb)), 0.5);
      const t = unit(turnA(c)), v = dot(cross(jb.axis, sub(c, jb.pivot)), t);
      if (Math.abs(v) < 1e-6) return null;
      transmissions.push({ id: p.id, kind: 'gear', a: ja.id, b: jb.id, teethA: p.teethA ?? fa.teeth, teethB: p.teethB ?? fb.teeth, ...(v > 0 ? { reversed: true } : {}), source: 'inferred' });
    } else return null;
    meshes.push(p);
  }

  // --- Followers: the rest of each unit, and everything it carries.
  const rigidFollowers: { leader: string; bodies: string[] }[] = [];
  for (const u of moving) {
    const parts = rec.bodies.flatMap((b, i) => ((inMoving(i) ? unitOf[i] === u : carriedBy.get(i) === u) ? b : []));
    const rest = parts.filter(k => k !== leader(u));
    if (rest.length) rigidFollowers.push({ leader: leader(u), bodies: rest });
  }

  // --- Prove it over the largest travel that works.
  const driverJoint = jointOf.get(driver)!;
  for (const amplitude of driverJoint.kind === 'revolute' ? TURNS : SLIDES) {
    const p: MechanismProgram = { mode: 'kinematic', duration: 4, sampleHz: 60, joints: program,
      ...(transmissions.length ? { transmissions } : {}), ...(closures.length ? { closures } : {}),
      ...(rigidFollowers.length ? { rigidFollowers } : {}), driver: { joint: driverJoint.id, amplitude, cycles: 1 } };
    if (!provenSuggestion(asm, graph, p) || !meshesHold(asm, p, meshes)) continue;
    const travel = driverJoint.kind === 'revolute' ? `±${Math.round(amplitude * 180 / Math.PI)}°` : `±${amplitude} LDU`;
    return {
      title: plan.title, program: p, evidence: 'classified', mechanism: plan.mechanism,
      warnings: [
        `Built from the named mechanism's joints${meshes.length ? ' and measured meshes' : ''}; solved over ${travel} of its input with every loop closed${meshes.length ? ' and every mesh engaged' : ''}.`,
        ...warnings,
        'The travel is an illustration, not a measured stop. Clearance and forces are not verified; review the collision verdict before export.',
      ],
    };
  }
  return null;
}

/** Every mesh still engaged at every frame, driving to both ends. */
function meshesHold(asm: Assembly, p: MechanismProgram, meshes: readonly HigherPair[]): boolean {
  if (!meshes.length) return true;
  try {
    const solver = new MechanismSolver(asm, p);
    const leaderOf = new Map((p.rigidFollowers ?? []).flatMap(f => f.bodies.map(b => [b, f.leader] as [string, string])));
    const pose = (frame: ReadonlyMap<string, THREE.Matrix4>, k: string) => {
      const l = leaderOf.get(k) ?? k, moved = frame.get(l), rest = solver.rest.get(l)!;
      return moved ? moved.clone().multiply(rest.clone().invert()).multiply(solver.rest.get(k)!) : solver.rest.get(k)!;
    };
    for (const end of [1, -1]) {
      solver.assembled();
      for (let i = 1; i <= 8; i++) {
        const frame = solver.solve(end * p.driver.amplitude * i / 8).poses;
        if (!meshes.every(m => engaged(m, pose(frame, m.a), pose(frame, m.b)).ok)) return false;
      }
    }
    return true;
  } catch { return false; }
}
