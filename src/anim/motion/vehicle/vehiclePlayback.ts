/**
 * Vehicle playback (spec §5.2): with the steering held at one position, the
 * chassis is carried round the turning centre (or straight ahead), and each
 * wheel spins about its own steered axle by the distance its contact travels
 * along its heading over its rolling radius. Everything not a wheel, towed
 * units included, rides rigidly with the chassis.
 */
import * as THREE from 'three';
import type { Assembly } from '../../../model/assemble';
import type { MechanismSolver } from '../v4/mechanismSolver';
import { solveLabFrame } from '../v4/mechanismLab';
import type { SuggestedMechanism } from '../v4/autoMechanics';
import type { Vehicle } from './vehicle';
import { vehicleReport } from './vehicleReport';

/** Poses for every instance after `distance` LDU of travel of the reference point, steering held at `steer`. */
export function vehicleFrame(asm: Assembly, solver: MechanismSolver, steer: number, distance: number): Map<string, THREE.Matrix4> {
  const vehicle = solver.program.vehicle;
  if (!vehicle) throw Error('Not a vehicle program');
  const report = vehicleReport(vehicle, solver, steer);
  const frame = solveLabFrame(solver, steer);
  const forward = new THREE.Vector3(...vehicle.forward), ref = new THREE.Vector3(...vehicle.ref);

  // The chassis: a turn about the vertical through the ICR, sensed so the reference point moves forward.
  let chassis: THREE.Matrix4;
  if (!report.turn.icr) chassis = new THREE.Matrix4().makeTranslation(forward.x * distance, 0, forward.z * distance);
  else {
    const [cx, cz] = report.turn.icr, r = new THREE.Vector3(ref.x - cx, 0, ref.z - cz);
    // d/dφ of R_y(φ)·r at φ = 0 is (r.z, 0, −r.x).
    const sense = Math.sign(r.z * forward.x - r.x * forward.z) || 1;
    const angle = (sense * distance) / report.turn.radius;
    chassis = new THREE.Matrix4().makeTranslation(cx, 0, cz).multiply(new THREE.Matrix4().makeRotationY(angle)).multiply(new THREE.Matrix4().makeTranslation(-cx, 0, -cz));
  }

  const out = new Map<string, THREE.Matrix4>();
  for (const i of asm.instances) out.set(i.key, chassis.clone().multiply(frame.get(i.key) ?? i.world));
  vehicle.wheels.forEach((w, k) => {
    const rest = asm.instances.find(i => i.key === w.tyre)!.world;
    const delta = (frame.get(w.tyre) ?? rest).clone().multiply(rest.clone().invert());
    const centre = new THREE.Vector3(...w.centre).applyMatrix4(delta), axis = new THREE.Vector3(...w.axis).transformDirection(delta).normalize();
    // Spin sense: the bottom of the wheel moves backward against the heading.
    const heading = new THREE.Vector3(-axis.z, 0, axis.x).normalize();
    if (heading.dot(forward) < 0) heading.negate();
    const bottomMoves = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, w.radius, 0));
    const sense = bottomMoves.dot(heading) > 0 ? -1 : 1;
    const angle = sense * report.wheels[k].spinPerLdu * distance;
    const spin = new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(axis, angle)).multiply(new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z));
    for (const key of w.parts) {
      const base = frame.get(key) ?? asm.instances.find(i => i.key === key)!.world;
      out.set(key, chassis.clone().multiply(spin).multiply(base));
    }
  });
  return out;
}

/** The steering suggestion, driven as a vehicle: the slider steers, playback drives. */
export function vehicleSuggestion(vehicle: Vehicle, steering: SuggestedMechanism): SuggestedMechanism {
  const title = `Vehicle — drive a circle: ${vehicle.wheels.length} wheels on ${vehicle.axles.length} axles`;
  return {
    title, evidence: 'classified', mechanism: { kind: 'vehicle', name: title },
    program: { ...steering.program, vehicle },
    warnings: [
      `Steered by ${steering.title}; wheels from measured tyres, each rolling at its own speed.`,
      ...vehicle.warnings,
      'Tyre scrub and the turning centre are kinematic: no tyre forces, no suspension load.',
    ],
  };
}
