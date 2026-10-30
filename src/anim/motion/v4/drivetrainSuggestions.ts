/**
 * Ready-to-drive rack steering, assembled from what the detector measured:
 *
 *   input shaft -> (spur/bevel gears, measured) -> pinion shaft -> rack
 *
 * where the rack is either on a straight guide (it slides) or on a tie rod
 * between two steering arms that pivot on a common frame (it swings on an
 * arc, a four-bar; e.g. LEGO 5590). Every stage must already be established:
 * a measured tooth mesh from the geometry screen, a bearing joint for every
 * shaft, and LDCad joints for the arms and tie rod. Nothing is guessed from
 * part names or boxes. The result is solved over its whole travel before it
 * is offered.
 */
import type { Assembly } from '../../../model/assemble';
import type { GeometryCandidate } from '../v6/geometryScreen';
import { rackMesh, type WorldGear } from '../gears/gearGeometry';
import { bodyGraph, carriedBodies, type BodyGraph, type BodyLink } from './bodyGraph';
import type { MechanismGraph } from './mechanismGraph';
import type { JointDrive, LoopClosure, MechanismProgram, RackContact, TransmissionConstraint, Vec3 } from './mechanismProgram';
import { provenSuggestion, type SuggestedMechanism } from './autoMechanics';

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaleAdd = (a: readonly number[], b: readonly number[], s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const parallel = (a: readonly number[], b: readonly number[]) => Math.abs(dot(a, b)) / (len(a) * len(b) || 1) > Math.cos(4 * Math.PI / 180);
const bare = (part: string) => part.toLowerCase().replace(/\.dat$/, '').replace(/^.*[\\/]/, '');

/** Most moving parts a single steering body may carry (wheels, hubs, knobs). */
const MAX_CARRIED = 80;
const MAX_SHAFTS = 6;

/**
 * A shaft: bodies locked in rotation about `axis` — a gear on a cross axle can
 * slide along it but not turn on it, so it is a separate rigid body that still
 * turns with the axle.
 */
function shaftGroup(g: BodyGraph, start: string, axis: readonly number[], blocked: ReadonlySet<string>): Set<string> {
  const group = new Set([start]), queue = [start];
  while (queue.length) for (const l of g.links(queue.pop()!))
    if (l.edge.motion === 'sliding' && parallel(l.edge.axis, axis) && !blocked.has(l.to) && !group.has(l.to)) { group.add(l.to); queue.push(l.to); }
  return group;
}
/** Bodies a shaft turns against about its axis (its bearings). */
const bearings = (g: BodyGraph, group: ReadonlySet<string>, axis: readonly number[]) =>
  new Set([...group].flatMap(b => g.links(b)).filter(l => l.edge.motion === 'revolute' && parallel(l.edge.axis, axis) && !group.has(l.to)).map(l => l.to));

type Arm = { body: string; connector?: string; pivot: BodyLink; pin: BodyLink };
type FourBar = { axis: Vec3; frame: string; arms: [Arm, Arm] };

/**
 * The rack's body is a coupler: joined (directly, or through one small
 * connector such as an axle pin) to two arms that both pivot on one frame
 * body, all about the same axis.
 */
function findFourBar(g: BodyGraph, coupler: string): FourBar | null {
  const turning = (l: BodyLink) => l.edge.motion !== 'fixed' && l.edge.motion !== 'ball';
  for (const first of g.links(coupler).filter(l => l.edge.motion === 'revolute')) {
    const axis = first.edge.axis;
    const onAxis = (l: BodyLink) => turning(l) && parallel(l.edge.axis, axis);
    // Arms reached from the coupler: direct, or via a connector touching only coupler + arm.
    const reach: Arm[] = [];
    for (const l of g.links(coupler).filter(onAxis)) {
      const near = g.links(l.to).filter(onAxis).filter(x => x.to !== coupler);
      const others = new Set(near.map(x => x.to));
      if (g.members(l.to).length <= 2 && others.size === 1) {
        const arm = [...others][0];
        if (!reach.some(r => r.body === arm)) reach.push({ body: arm, connector: l.to, pin: l, pivot: near[0] });
      } else if (!reach.some(r => r.body === l.to)) reach.push({ body: l.to, pin: l, pivot: l });
    }
    for (let i = 0; i < reach.length; i++) for (let j = i + 1; j < reach.length; j++) {
      const exclude = new Set([coupler, reach[i].body, reach[j].body, reach[i].connector, reach[j].connector]);
      const pivots = (arm: Arm) => g.links(arm.body).filter(l => l.edge.motion === 'revolute' && parallel(l.edge.axis, axis) && !exclude.has(l.to));
      const pi = pivots(reach[i]), pj = pivots(reach[j]);
      const frame = pi.map(l => l.to).find(f => pj.some(l => l.to === f));
      if (!frame) continue;
      const pin = (arm: Arm) => ({ ...arm, pivot: (arm === reach[i] ? pi : pj).find(l => l.to === frame)! });
      // Pins must be apart, or there is no loop to close.
      if (len(sub(reach[i].pin.edge.centre, reach[j].pin.edge.centre)) < 4) continue;
      return { axis: [...axis] as Vec3, frame, arms: [pin(reach[i]), pin(reach[j])] };
    }
  }
  return null;
}

type Shaft = { body: string; bodies: Set<string>; key: string; axis: Vec3; pivot: Vec3; depth: number; teethPerTurn: number };

export function suggestRackSteering(asm: Assembly, graph: MechanismGraph,
  candidates: readonly GeometryCandidate[], measured: ReadonlyMap<string, WorldGear>): SuggestedMechanism[] {
  const g = bodyGraph(graph);
  const partOf = new Map(asm.instances.map(i => [i.key, bare(i.part)]));
  const meshes = candidates.filter(c => c.status === 'plausible' && measured.has(c.a) && measured.has(c.b));
  const out: SuggestedMechanism[] = [];
  const used = new Set<string>();
  for (const rp of meshes.filter(c => c.kind === 'rack-pinion')) {
    const pinion = measured.get(rp.a)!, rack = measured.get(rp.b)!;
    if (pinion.kind !== 'spur' || rack.kind !== 'rack') continue;
    const P = g.of(rp.a), R = g.of(rp.b);
    if (P === R || used.has(R)) continue;
    // How the rack is carried.
    const fourBar = findFourBar(g, R);
    const guide = fourBar ? null : g.links(R).find(l => l.edge.motion === 'sliding' && parallel(l.edge.axis, rack.direction));
    if (!fourBar && !guide) continue;
    const blocked = new Set([R, ...(fourBar ? [fourBar.frame, ...fourBar.arms.flatMap(a => a.connector ? [a.body, a.connector] : [a.body])] : [guide!.to])]);
    const pinionShaft = shaftGroup(g, P, pinion.axis, blocked);
    const pinionBearings = bearings(g, pinionShaft, pinion.axis);
    if (!pinionBearings.size) continue;

    // Shafts upstream of the pinion, through measured gear meshes only.
    const shafts = new Map<string, Shaft>([[P, { body: P, bodies: pinionShaft, key: rp.a, axis: pinion.axis, pivot: pinion.centre, depth: 0, teethPerTurn: 1 }]]);
    const gearLinks: { cand: GeometryCandidate; a: string; b: string }[] = [];
    const frames = new Set(pinionBearings);
    const shaftOf = (body: string) => [...shafts.values()].find(s => s.bodies.has(body));
    for (let grew = true; grew && shafts.size < MAX_SHAFTS;) {
      grew = false;
      for (const c of meshes) {
        if ((c.kind !== 'gear' && c.kind !== 'bevel') || gearLinks.some(x => x.cand === c)) continue;
        const A = g.of(c.a), B = g.of(c.b), sa = shaftOf(A), sb = shaftOf(B);
        const [from, fresh, freshKey] = sa && !sb ? [sa, B, c.b] : sb && !sa ? [sb, A, c.a] : [];
        if (!from || !fresh || blocked.has(fresh)) continue;
        const gear = measured.get(freshKey!)!;
        if (gear.kind === 'rack') continue;
        const group = shaftGroup(g, fresh, gear.axis, new Set([...blocked, ...[...shafts.values()].flatMap(s => [...s.bodies])]));
        const held = bearings(g, group, gear.axis);
        if (!held.size) continue;
        const knownGear = measured.get(fresh === B ? c.a : c.b)!;
        shafts.set(fresh, { body: fresh, bodies: group, key: freshKey!, axis: gear.axis, pivot: gear.centre, depth: from.depth + 1,
          teethPerTurn: from.teethPerTurn * gear.teeth / knownGear.teeth });
        held.forEach(f => frames.add(f));
        gearLinks.push({ cand: c, a: from.body, b: fresh });
        grew = true;
      }
    }
    const driver = [...shafts.values()].sort((x, y) => y.depth - x.depth)[0];

    // Joints. Each body's joint sits on a key of that body.
    const joints: JointDrive[] = [];
    const jointOf = new Map<string, JointDrive>();
    const addJoint = (body: string, key: string, j: Omit<JointDrive, 'id' | 'body'>) => {
      const joint = { id: `steer-${joints.length + 1}`, body: key, ...j } as JointDrive;
      joints.push(joint); jointOf.set(body, joint);
      return joint;
    };
    for (const s of [...shafts.values()].sort((x, y) => y.depth - x.depth))
      addJoint(s.body, s.key, { kind: 'revolute', axis: s.axis, pivot: s.pivot });
    const transmissions: TransmissionConstraint[] = gearLinks.map(({ cand, a, b }, i) => {
      // a/b are the shafts in mesh order (known, fresh); match the gears to them.
      const aFirst = shafts.get(a)!.bodies.has(g.of(cand.a));
      const ja = jointOf.get(a)!, jb = jointOf.get(b)!;
      const ga = measured.get(aFirst ? cand.a : cand.b)!, gb = measured.get(aFirst ? cand.b : cand.a)!;
      if (ga.kind === 'rack' || gb.kind === 'rack') throw Error('unreachable');
      // The mesh direction is about each gear's own axis; joints may point the other way.
      const flip = Math.sign(dot(ja.axis, ga.axis)) * Math.sign(dot(jb.axis, gb.axis)) < 0;
      const reversed = Boolean(cand.draft?.reversed) !== flip;
      return { id: `steer-gear-${i + 1}`, kind: 'gear', a: ja.id, b: jb.id, teethA: ga.teeth, teethB: gb.teeth,
        ...(reversed ? { reversed: true } : {}), source: 'inferred' };
    });

    const pinionJoint = jointOf.get(P)!;
    const verdict = rackMesh(pinion, rack);
    if (!verdict.meshes) continue;
    const towards = sub(pinion.centre, rack.centre);
    const apart = scaleAdd(scaleAdd(towards, rack.direction, -dot(towards, rack.direction)), pinion.axis, -dot(towards, pinion.axis));
    const contact = scaleAdd(pinion.centre, apart, -pinion.radius / (len(apart) || 1));
    const along = dot(sub(contact, rack.centre), rack.direction);
    const travel = { min: Math.min(0, along - rack.length / 2), max: Math.max(0, along + rack.length / 2) };
    let reach = Math.min(-travel.min, travel.max);
    const closures: LoopClosure[] = [];
    const rackContacts: RackContact[] = [];
    const rackKey = rp.b;
    if (fourBar) {
      const [first, second] = fourBar.arms;
      for (const arm of fourBar.arms) {
        const key = g.members(arm.body)[0];
        addJoint(arm.body, key, { kind: 'revolute', axis: fourBar.axis, pivot: arm.pivot.edge.centre });
      }
      const pin1 = first.pin.edge.centre, pin2 = second.pin.edge.centre;
      addJoint(R, rackKey, { kind: 'revolute', axis: fourBar.axis, pivot: pin1, parent: jointOf.get(first.body)!.body });
      const local = (key: string, p: Vec3) => {
        const m = asm.instances.find(i => i.key === key)!.world.clone().invert();
        const e = m.elements;
        return [e[0] * p[0] + e[4] * p[1] + e[8] * p[2] + e[12], e[1] * p[0] + e[5] * p[1] + e[9] * p[2] + e[13],
          e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14]] as Vec3;
      };
      const armKey = jointOf.get(second.body)!.body;
      closures.push({ a: { body: rackKey, local: local(rackKey, pin2) }, b: { body: armKey, local: local(armKey, pin2) }, toleranceLdu: .1 });
      rackContacts.push({ id: 'steer-rack', pinion: pinionJoint.id, rack: rackKey, contact, direction: rack.direction,
        pitchRadiusLdu: pinion.radius, ...(verdict.sign === -1 ? { reversed: true } : {}), travel,
        engagementLdu: 1.5, source: 'inferred' });
      // Keep the arms well inside a quarter turn from where they are posed.
      const armLength = Math.min(...fourBar.arms.map(a => {
        const d = sub(a.pin.edge.centre, a.pivot.edge.centre);
        return len(scaleAdd(d, fourBar.axis, -dot(d, fourBar.axis) / (len(fourBar.axis) ** 2)));
      }));
      reach = Math.min(reach, armLength * 0.5);
    } else {
      const slide = addJoint(R, rackKey, { kind: 'prismatic', axis: rack.direction });
      transmissions.push({ id: 'steer-rack', kind: 'rack-pinion', a: pinionJoint.id, b: slide.id,
        pitchRadiusLdu: pinion.radius, ...(verdict.sign === -1 ? { reversed: true } : {}), source: 'inferred' });
      frames.add(guide!.to);
    }
    if (fourBar) frames.add(fourBar.frame);

    // What each moving body carries; nothing may also be held by a frame.
    const moving = [...jointOf.keys()];
    const shaftBodies = [...shafts.values()].flatMap(s => [...s.bodies]);
    const claimed = new Set([...moving, ...frames, ...shaftBodies]);
    const rigidFollowers: { leader: string; bodies: string[] }[] = [];
    let ok = true;
    for (const body of moving) {
      const own = shafts.get(body)?.bodies ?? new Set([body]);
      const stop = new Set([...claimed].filter(b => b === body || !own.has(b)));
      const axis = jointOf.get(body)!.axis;
      const carried = carriedBodies(g, body, stop, MAX_CARRIED);
      // A carried piece may sit in a frame only as a bearing on this body's axis.
      const held = (l: BodyLink) => frames.has(l.to) && !(l.edge.motion !== 'fixed' && parallel(l.edge.axis, axis));
      if (!carried || carried.loops.some(held)) { ok = false; break; }
      carried.bodies.forEach(b => claimed.add(b));
      const leader = jointOf.get(body)!.body;
      const followers = carried.parts.filter(k => k !== leader);
      if (followers.length) rigidFollowers.push({ leader, bodies: followers });
    }
    if (!ok) continue;

    const amplitude = 0.6 * reach / (pinion.radius * Math.abs(driver.teethPerTurn));
    const driverJoint = jointOf.get(driver.body)!;
    const program: MechanismProgram = { mode: 'kinematic', duration: 4, sampleHz: 60, joints,
      ...(transmissions.length ? { transmissions } : {}),
      ...(closures.length ? { closures } : {}),
      ...(rackContacts.length ? { rackContacts } : {}),
      ...(rigidFollowers.length ? { rigidFollowers } : {}),
      driver: { joint: driverJoint.id, amplitude, cycles: 1 } };
    if (!provenSuggestion(asm, graph, program)) continue;
    used.add(R);
    const chain = [...shafts.values()].sort((x, y) => y.depth - x.depth).map(s => partOf.get(s.key)).join(' → ');
    out.push({
      title: `Rack steering — ${chain} → ${partOf.get(rackKey)}${fourBar ? ' on a four-bar tie rod' : ' on a slide'}`,
      program, evidence: 'measured-gear-train',
      warnings: [
        `Gear meshes are measured tooth geometry; ${fourBar ? 'the tie rod swings on the steering arms and the rack rolls on the pinion along that arc' : 'the rack slides on its guide'}.`,
        `Travel is limited to ±${(amplitude * pinion.radius * Math.abs(driver.teethPerTurn)).toFixed(0)} LDU of rack movement — an illustration, not the measured steering lock.`,
        'Clearance and forces are not verified; review the collision verdict before export.',
      ],
    });
  }
  return out;
}
