/**
 * The vehicle at one steering position (spec §5.3-5.4): wheel headings read
 * from the solved steering mechanism, then the turning centre, Ackermann
 * error, slip and spin from the plane geometry. With no steering solver, a
 * kinematic bicycle model stands in: the steered axle is turned to an ideal
 * Ackermann about wheelbase / tan(steer).
 */
import * as THREE from 'three';
import type { MechanismSolver } from '../v4/mechanismSolver';
import { solveLabFrame } from '../v4/mechanismLab';
import type { SuggestedMechanism } from '../v4/autoMechanics';
import type { Vehicle } from './vehicle';
import { bicycle, rolling, type P2, type Turn, type WheelPose } from './rolling';

export type WheelReport = { tyre: string; steerDeg: number; slipDeg: number; spinPerLdu: number; longitudinalScrub: number };
export type VehicleReport = { model: 'steering' | 'bicycle' | 'straight'; turn: Turn; yawPerLdu: number; wheels: WheelReport[] };

const deg = (r: number) => (r * 180) / Math.PI;
const flat = (v: THREE.Vector3): P2 => [v.x, v.z];

/** The steering suggestion that moves every steered wheel of the vehicle. */
export function steeringFor(vehicle: Vehicle, suggestions: readonly SuggestedMechanism[]): SuggestedMechanism | undefined {
  const steered = vehicle.wheels.filter(w => w.steered).map(w => w.tyre);
  if (!steered.length) return undefined;
  return suggestions.find(s => (s.mechanism?.kind === 'rack-steering' || s.mechanism?.kind === 'steering') && steered.every(t =>
    s.program.joints.some(j => j.body === t) || (s.program.rigidFollowers ?? []).some(f => f.bodies.includes(t))));
}

/** Each wheel's contact and heading (square to its axle, toward `forward`) after `delta` moves it. */
function poses(vehicle: Vehicle, delta: (tyre: string) => THREE.Matrix4 | null): WheelPose[] {
  const fwd: P2 = [vehicle.forward[0], vehicle.forward[2]];
  return vehicle.wheels.map(w => {
    const m = delta(w.tyre), axis = new THREE.Vector3(...w.axis), centre = new THREE.Vector3(...w.centre);
    if (m) { axis.transformDirection(m); centre.applyMatrix4(m); }
    const n = Math.hypot(axis.x, axis.z);
    let h: P2 = [-axis.z / n, axis.x / n];
    if (h[0] * fwd[0] + h[1] * fwd[1] < 0) h = [-h[0], -h[1]];
    return { contact: flat(centre), heading: h, radius: w.radius, axle: w.axle };
  });
}

export function vehicleReport(vehicle: Vehicle, solver: MechanismSolver | null, steer: number): VehicleReport {
  const ref: P2 = [vehicle.ref[0], vehicle.ref[2]], fwd: P2 = [vehicle.forward[0], vehicle.forward[2]];
  const solid = new Set(vehicle.axles.flatMap((a, i) => (a.solid ? [i] : [])));
  let wheels: WheelPose[], model: VehicleReport['model'];
  if (solver) {
    const frame = solveLabFrame(solver, steer);
    wheels = poses(vehicle, tyre => {
      const pose = frame.get(tyre), rest = solver.rest.get(tyre);
      return pose && rest ? pose.clone().multiply(rest.clone().invert()) : null;
    });
    model = 'steering';
  } else {
    wheels = poses(vehicle, () => null);
    const steered = wheels.filter((_, i) => vehicle.wheels[i].steered);
    if (!steered.length || steer === 0) model = 'straight';
    else {
      // Bicycle: the steered axle's middle turns by `steer`, each steered wheel set square to the line from that centre.
      const mid = steered.reduce((s, w) => [s[0] + w.contact[0] / steered.length, s[1] + w.contact[1] / steered.length] as P2, [0, 0] as P2);
      const wheelbase = Math.abs((mid[0] - ref[0]) * fwd[0] + (mid[1] - ref[1]) * fwd[1]);
      const { radius } = bicycle(wheelbase, steer), side: P2 = [-fwd[1] * Math.sign(steer), fwd[0] * Math.sign(steer)];
      const icr: P2 = [ref[0] + side[0] * radius, ref[1] + side[1] * radius];
      wheels = wheels.map((w, i) => {
        if (!vehicle.wheels[i].steered) return w;
        const d: P2 = [w.contact[0] - icr[0], w.contact[1] - icr[1]], n = Math.hypot(...d);
        let h: P2 = [-d[1] / n, d[0] / n];
        if (h[0] * fwd[0] + h[1] * fwd[1] < 0) h = [-h[0], -h[1]];
        return { ...w, heading: h };
      });
      model = 'bicycle';
    }
  }
  const r = rolling(wheels, ref, solid);
  return {
    model, turn: r.turn, yawPerLdu: r.yawPerLdu,
    wheels: wheels.map((w, i) => ({
      tyre: vehicle.wheels[i].tyre,
      steerDeg: deg(Math.atan2(fwd[0] * w.heading[1] - fwd[1] * w.heading[0], fwd[0] * w.heading[0] + fwd[1] * w.heading[1])),
      slipDeg: deg(r.wheels[i].slip), spinPerLdu: r.wheels[i].spinPerLdu, longitudinalScrub: r.wheels[i].longitudinalScrub,
    })),
  };
}
