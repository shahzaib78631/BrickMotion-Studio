/** Driving the vehicle round its turning centre with every wheel rolling (spec §5.2). */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { inspectMechanisms } from '../../../src/anim/motion/v4/mechanismLab';
import { MechanismSolver } from '../../../src/anim/motion/v4/mechanismSolver';
import { validateMechanismProgram } from '../../../src/anim/motion/v4/mechanismProgram';
import { vehicleFrame } from '../../../src/anim/motion/vehicle/vehiclePlayback';
import { vehicleReport } from '../../../src/anim/motion/vehicle/vehicleReport';
import { loadRealModel, partDataInstalled } from '../../diagnostics/loadRealModel';

const M5590 = join(__dirname, '..', '..', '..', 'samples', '5590_-_whirl_n_wheel_super_truck.mpd');
const setup = async () => {
  const { asm, metrics } = await loadRealModel(M5590);
  const report = inspectMechanisms(asm, metrics);
  const s = report.detection.suggestions.find(x => x.mechanism?.kind === 'vehicle')!;
  return { asm, s, vehicle: s.program.vehicle!, solver: new MechanismSolver(asm, s.program) };
};

describe.skipIf(!partDataInstalled() || !existsSync(M5590))('5590 driving a circle', () => {
  it('is offered as a vehicle suggestion whose program validates; a zero-radius wheel is refused', async () => {
    const { s } = await setup();
    expect(s.title).toMatch(/^Vehicle — drive a circle: 10 wheels on 3 axles/);
    expect(validateMechanismProgram(s.program)).toEqual([]);
    const bad = { ...s.program, vehicle: { ...s.program.vehicle!, wheels: s.program.vehicle!.wheels.map((w, i) => (i ? w : { ...w, radius: 0 })) } };
    expect(validateMechanismProgram(bad)).toEqual([expect.stringMatching(/vehicle/i)]);
  }, 600_000);

  it('every wheel rolls: its contact point does not slide along its heading', async () => {
    const { asm, vehicle, solver } = await setup();
    const rest = new Map(asm.instances.map(i => [i.key, i.world]));
    const at = 150, h = 0.5;
    const now = vehicleFrame(asm, solver, 0, at), before = vehicleFrame(asm, solver, 0, at - h), after = vehicleFrame(asm, solver, 0, at + h);
    for (const w of vehicle.wheels) {
      const pose = now.get(w.tyre)!, delta = pose.clone().multiply(rest.get(w.tyre)!.clone().invert());
      const centre = new THREE.Vector3(...w.centre).applyMatrix4(delta), axis = new THREE.Vector3(...w.axis).transformDirection(delta);
      const contact = centre.clone().add(new THREE.Vector3(0, w.radius, 0));
      const local = contact.clone().applyMatrix4(pose.clone().invert());
      const v = local.clone().applyMatrix4(after.get(w.tyre)!).sub(local.clone().applyMatrix4(before.get(w.tyre)!)).divideScalar(2 * h);
      const heading = new THREE.Vector3(-axis.z, 0, axis.x).normalize();
      expect(Math.abs(v.dot(heading)), w.tyre).toBeLessThan(1e-3);
    }
  }, 600_000);

  it('a full circle brings the truck back where it started', async () => {
    const { asm, vehicle, solver } = await setup();
    const r = vehicleReport(vehicle, solver, 0);
    const frame = vehicleFrame(asm, solver, 0, 2 * Math.PI * r.turn.radius);
    const wheelParts = new Set(vehicle.wheels.flatMap(w => w.parts));
    let worst = 0;
    for (const i of asm.instances) {
      if (wheelParts.has(i.key)) continue;
      const p = new THREE.Vector3().setFromMatrixPosition(frame.get(i.key)!), q = new THREE.Vector3().setFromMatrixPosition(i.world);
      worst = Math.max(worst, p.distanceTo(q));
    }
    expect(worst).toBeLessThan(1e-6);
  }, 600_000);

  it('the outer wheel of an axle turns further than the inner one', async () => {
    const { asm, vehicle, solver } = await setup();
    const r = vehicleReport(vehicle, solver, 0), d = 60;
    const frame = vehicleFrame(asm, solver, 0, d);
    const chassisKey = asm.instances.find(i => !vehicle.wheels.some(w => w.parts.includes(i.key)) && !solver.program.joints.some(j => j.body === i.key)
      && !(solver.program.rigidFollowers ?? []).some(f => f.bodies.includes(i.key)))!.key;
    const rest = new Map(asm.instances.map(i => [i.key, i.world]));
    const M = frame.get(chassisKey)!.clone().multiply(rest.get(chassisKey)!.clone().invert());
    const turned = (tyre: string) => new THREE.Quaternion().setFromRotationMatrix(
      M.clone().invert().multiply(frame.get(tyre)!).multiply(rest.get(tyre)!.clone().invert())).angleTo(new THREE.Quaternion());
    const rear = vehicle.wheels.filter(w => Math.abs(w.centre[2] - 260) < 3);
    const dist = (w: typeof rear[number]) => Math.hypot(w.centre[0] - r.turn.icr![0], w.centre[2] - r.turn.icr![1]);
    rear.sort((a, b) => dist(a) - dist(b));
    expect(turned(rear[3].tyre)).toBeGreaterThan(turned(rear[0].tyre));
    expect(turned(rear[3].tyre)).toBeCloseTo((d * Math.abs(r.wheels[vehicle.wheels.indexOf(rear[3])].spinPerLdu)), 6);
  }, 600_000);
});
