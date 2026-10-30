/** Turning centre, Ackermann error and scrub from the solved steering (spec §5.3-5.4). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectMechanisms } from '../../../src/anim/motion/v4/mechanismLab';
import { MechanismSolver } from '../../../src/anim/motion/v4/mechanismSolver';
import { vehicleReport, steeringFor } from '../../../src/anim/motion/vehicle/vehicleReport';
import { loadRealModel, partDataInstalled } from '../../diagnostics/loadRealModel';

const M5590 = join(__dirname, '..', '..', '..', 'samples', '5590_-_whirl_n_wheel_super_truck.mpd');
const setup = async () => {
  const { asm, metrics } = await loadRealModel(M5590);
  const report = inspectMechanisms(asm, metrics), vehicle = report.vehicle!;
  const steering = steeringFor(vehicle, report.detection.suggestions)!;
  return { asm, vehicle, steering, solver: new MechanismSolver(asm, steering.program) };
};
const deg = (r: number) => (r * 180) / Math.PI;

describe.skipIf(!partDataInstalled() || !existsSync(M5590))('5590 vehicle report', () => {
  it('as posed, the truck turns about a centre beside it; parallel steering leaves an Ackermann error', async () => {
    const { vehicle, solver } = await setup();
    const r = vehicleReport(vehicle, solver, 0);
    expect(r.model).toBe('steering');
    expect(r.turn.icr).not.toBeNull();
    const front = vehicle.wheels.flatMap((w, i) => (w.steered ? [i] : []));
    expect(front).toHaveLength(2);
    const dist = (i: number) => Math.hypot(vehicle.wheels[i].centre[0] - r.turn.icr![0], vehicle.wheels[i].centre[2] - r.turn.icr![1]);
    // The tie rod is a parallelogram: both front wheels turn by the same angle (about 21° as posed), not Ackermann.
    const [inner, outer] = [...front].sort((a, b) => dist(a) - dist(b));
    expect(Math.abs(r.wheels[outer].steerDeg)).toBeGreaterThan(15);
    expect(r.wheels[inner].steerDeg).toBeCloseTo(r.wheels[outer].steerDeg, 3);
    expect(r.turn.ackermannError).toBeGreaterThan(1);
  }, 600_000);

  it('tandem rear axles scrub in opposite senses, about atan(60 / R) each', async () => {
    const { vehicle, solver } = await setup();
    const r = vehicleReport(vehicle, solver, 0);
    const axleSlip = (z: number) => {
      const ids = vehicle.wheels.flatMap((w, i) => (Math.abs(w.centre[2] - z) < 3 ? [i] : []));
      expect(ids).toHaveLength(4);
      return ids.reduce((s, i) => s + r.wheels[i].slipDeg, 0) / ids.length;
    };
    const a = axleSlip(140), b = axleSlip(260), expected = deg(Math.atan(60 / r.turn.radius));
    expect(Math.sign(a)).toBe(-Math.sign(b));
    for (const s of [a, b]) {
      expect(Math.abs(s)).toBeGreaterThan(0.75 * expected);
      expect(Math.abs(s)).toBeLessThan(1.25 * expected);
    }
  }, 600_000);

  it('with the front wheels straight the truck hardly yaws', async () => {
    const { vehicle, solver, steering } = await setup();
    const A = steering.program.driver.amplitude;
    let best = { steer: 0, front: Infinity };
    for (const end of [1, -1]) {
      solver.assembled();
      for (let i = 0; i <= 100; i++) {
        const steer = (end * A * i) / 100, r = vehicleReport(vehicle, solver, steer);
        const front = Math.max(...r.wheels.filter((_, k) => vehicle.wheels[k].steered).map(w => Math.abs(w.steerDeg)));
        if (front < best.front) best = { steer, front };
      }
    }
    solver.assembled();
    for (let i = 1; i <= 50; i++) vehicleReport(vehicle, solver, (best.steer * i) / 50);
    expect(Math.abs(vehicleReport(vehicle, solver, best.steer).yawPerLdu)).toBeLessThan(1e-3);
  }, 600_000);

  it('without a steering solver, a bicycle model turns at wheelbase / tan(steer)', async () => {
    const { vehicle } = await setup();
    const r = vehicleReport(vehicle, null, 0.2);
    expect(r.model).toBe('bicycle');
    const steered = vehicle.wheels.filter(w => w.steered);
    const mid = steered.reduce((s, w) => [s[0] + w.centre[0] / steered.length, s[1] + w.centre[2] / steered.length], [0, 0]);
    const wheelbase = Math.abs((mid[0] - vehicle.ref[0]) * vehicle.forward[0] + (mid[1] - vehicle.ref[2]) * vehicle.forward[2]);
    expect(r.turn.radius).toBeGreaterThan(0.99 * wheelbase / Math.tan(0.2));
    expect(r.turn.radius).toBeLessThan(1.01 * wheelbase / Math.tan(0.2));
  }, 600_000);
});
