/**
 * The vehicle (spec §5.1): wheels from measured tyre geometry standing on the
 * lowest plane, the axles they form, the chassis they hang from, and which of
 * them the steering mechanism turns. Wheels on a unit hinged to the chassis
 * about a vertical axis that is not steering (a trailer) are towed, not driven.
 */
import * as THREE from 'three';
import type { Assembly, Metrics } from '../../../model/assemble';
import type { Recognition } from '../mobility/recognise';
import type { NamedMechanism } from '../classify/patterns';
import { isTyre } from '../parts/libraryConnectors';
import { partFunctions } from '../parts/partFunctions';
import type { Vec3 } from '../v4/mechanismProgram';

export type VehicleWheel = {
  /** Tyre part key. */
  tyre: string;
  /** Every part that spins with the tyre (its recognition body). */
  parts: string[];
  /** World, at rest; axis unit and horizontal. */
  centre: Vec3; axis: Vec3;
  /** Rolling radius, LDU. */
  radius: number;
  axle: number;
  steered: boolean;
};
export type Vehicle = {
  wheels: VehicleWheel[];
  axles: { solid: boolean; steered: boolean }[];
  groundY: number;
  /** Unit, horizontal: from `ref` toward the steered axle. */
  forward: Vec3;
  /** Centre of the non-steered axles (all axles if none), on the ground. */
  ref: Vec3;
  /** Ground tyres on a towed unit (a trailer), left out. */
  towed: string[];
  /** Name of the steering mechanism. */
  steering?: string;
  warnings: string[];
};

/** A tyre stands on the ground when its bottom is within this of the lowest tyre bottom (LDU). */
const GROUND = 2;
/** A horizontal axle: within 10 degrees of level. */
const LEVEL = Math.sin((10 * Math.PI) / 180);
const PARALLEL = Math.cos((4 * Math.PI) / 180);
/** Wheels share an axle line within 4 LDU; a tyre turns on a joint within 2.5 LDU of its centre. */
const AXLE_LINE = 4, ON_LINE = 2.5;
/** A kingpin or hitch is within 30 degrees of vertical (LDraw −Y is up). */
const VERTICAL = Math.cos((30 * Math.PI) / 180);
/** Steered wheels within this distance along the chassis form one axle (their axle lines splay when steered). */
const STEERED_AXLE = 30;

type V = THREE.Vector3;
const v3 = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);
const arr = (a: V): Vec3 => [a.x, a.y, a.z];
const at = (p: V) => `(${p.toArray().map(x => Math.round(x)).join(',')})`;

export function recognizeVehicle(asm: Assembly, rec: Recognition, named: readonly NamedMechanism[], metrics: Metrics): Vehicle | null {
  const warnings: string[] = [];
  const chassis = rec.bodies.reduce((best, b, i) => (b.length > rec.bodies[best].length ? i : best), 0);
  const steering = named.find(m => m.kind === 'rack-steering' || m.kind === 'steering');
  const steeredTyres = new Set(steering?.parts?.wheels ?? []);
  const steeringBodies = new Set(steering?.bodies ?? []);

  // Tyres with a horizontal axle, and how low each reaches.
  const tyres = asm.instances.filter(i => isTyre(i.part, metrics)).flatMap(i => {
    const seat = partFunctions(i.part)?.seats.find(s => s.gender === 'F');
    if (!seat) return [];
    const axis = v3(seat.axis).transformDirection(i.world).normalize();
    if (Math.abs(axis.y) > LEVEL) return [];
    const centre = v3(seat.centre).applyMatrix4(i.world);
    return [{ key: i.key, part: i.part.replace(/\.dat$/i, ''), axis, centre, bottom: i.worldBox.max[1], radius: (i.worldBox.max[1] - i.worldBox.min[1]) / 2 }];
  });
  if (!tyres.length) return null;
  const groundY = Math.max(...tyres.map(t => t.bottom));
  const onGround = tyres.filter(t => groundY - t.bottom <= GROUND);

  // Path from a body to the chassis: a vertical hinge on it that is not part of the steering means a towed unit.
  const around = new Map<number, { to: number; j: number }[]>();
  rec.joints.forEach(({ a, b }, j) => { around.set(a, [...(around.get(a) ?? []), { to: b, j }]); around.set(b, [...(around.get(b) ?? []), { to: a, j }]); });
  const towedBody = (start: number): boolean | null => {
    // Breadth-first, recording the joint each body was reached by.
    const via = new Map<number, number>([[start, -1]]), queue = [start];
    while (queue.length && !via.has(chassis)) for (const e of around.get(queue.shift()!) ?? []) if (!via.has(e.to)) { via.set(e.to, e.j); queue.push(e.to); }
    if (!via.has(chassis)) return null;
    for (let x = chassis; x !== start;) {
      const { a, b, joint } = rec.joints[via.get(x)!], from = a === x ? b : a;
      const hinge = joint.kind === 'revolute' && joint.axis && Math.abs(joint.axis[1]) / Math.hypot(...joint.axis) >= VERTICAL;
      // A kingpin turns a steering body (the hub) on whatever carries it (frame, or a suspension arm).
      if (hinge && !steeringBodies.has(a) && !steeringBodies.has(b)) return true;
      x = from;
    }
    return false;
  };

  const towed: string[] = [];
  const wheels: (Omit<VehicleWheel, 'axle'> & { body: number })[] = [];
  for (const t of onGround) {
    const body = rec.bodyOf.get(t.key);
    if (body === undefined || body === chassis) { warnings.push(`${t.part} at ${at(t.centre)} does not turn on its own axle`); continue; }
    // A hinge on the tyre's line, or a ball joint (which also lets it spin) on that line.
    const offAxle = (p: readonly number[]) => { const d = v3(p).sub(t.centre); return d.addScaledVector(t.axis, -d.dot(t.axis)).length(); };
    const spins = rec.joints.some(({ a, b, joint: j }) => (a === body || b === body) && j.point && offAxle(j.point) <= ON_LINE
      && (j.kind === 'spherical' || (j.kind === 'revolute' && !!j.axis && Math.abs(v3(j.axis).normalize().dot(t.axis)) >= PARALLEL)));
    if (!spins) { warnings.push(`${t.part} at ${at(t.centre)} does not turn on its own axle`); continue; }
    if (towedBody(body)) { towed.push(t.key); continue; }
    wheels.push({ tyre: t.key, parts: [...rec.bodies[body]], centre: arr(t.centre), axis: arr(t.axis), radius: t.radius, steered: steeredTyres.has(t.key), body });
  }
  if (towed.length) warnings.push(`${towed.length} trailer wheels are towed, not driven (articulation is not modelled)`);

  // Axles: non-steered wheels by shared line; steered wheels by position along the chassis.
  const axleOf: number[] = new Array(wheels.length).fill(-1), groups: number[][] = [];
  const sameLine = (i: number, j: number) => {
    const ai = v3(wheels[i].axis), d = v3(wheels[j].centre).sub(v3(wheels[i].centre));
    return Math.abs(ai.dot(v3(wheels[j].axis))) >= PARALLEL && d.addScaledVector(ai, -d.dot(ai)).length() <= AXLE_LINE;
  };
  wheels.forEach((w, i) => {
    if (w.steered || axleOf[i] >= 0) return;
    axleOf[i] = groups.length; groups.push([i]);
    wheels.forEach((x, j) => { if (!x.steered && axleOf[j] < 0 && sameLine(i, j)) { axleOf[j] = axleOf[i]; groups[axleOf[i]].push(j); } });
  });
  const plain = groups.flat();
  // Lengthwise: square to the non-steered axles (or to the steered wheels' mean axis).
  const meanAxis = (ids: number[]) => ids.reduce((s, i) => { const a = v3(wheels[i].axis); return s.add(a.dot(v3(wheels[ids[0]].axis)) < 0 ? a.negate() : a); }, new THREE.Vector3()).setY(0).normalize();
  const all = wheels.map((_, i) => i);
  const side = meanAxis(plain.length ? plain : all), length = new THREE.Vector3(side.z, 0, -side.x);
  wheels.forEach((w, i) => {
    if (!w.steered || axleOf[i] >= 0) return;
    axleOf[i] = groups.length; groups.push([i]);
    wheels.forEach((x, j) => { if (x.steered && axleOf[j] < 0 && Math.abs(v3(x.centre).sub(v3(w.centre)).dot(length)) <= STEERED_AXLE) { axleOf[j] = axleOf[i]; groups[axleOf[i]].push(j); } });
  });
  if (wheels.length < 3 || groups.length < 2) return null;

  const centroid = (ids: number[]) => ids.reduce((s, i) => s.add(v3(wheels[i].centre)), new THREE.Vector3()).divideScalar(ids.length);
  const ref = centroid(plain.length ? plain : all).setY(groundY);
  const steeredIds = wheels.flatMap((w, i) => (w.steered ? [i] : []));
  // Forward points at the steered axle, else at the axle farthest from the reference.
  const target = steeredIds.length ? centroid(steeredIds)
    : groups.map(g => centroid(g)).reduce((f, c) => (c.clone().setY(groundY).distanceTo(ref) > f.clone().setY(groundY).distanceTo(ref) ? c : f));
  const forward = target.clone().sub(ref).dot(length) < 0 ? length.clone().negate() : length.clone();

  return {
    wheels: wheels.map(({ body: _body, ...w }, i) => ({ ...w, axle: axleOf[i] })),
    axles: groups.map(g => ({ solid: new Set(g.map(i => wheels[i].body)).size < g.length, steered: g.some(i => wheels[i].steered) })),
    groundY, forward: arr(forward), ref: arr(ref), towed, ...(steering ? { steering: steering.name } : {}), warnings,
  };
}
