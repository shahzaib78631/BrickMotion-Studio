/**
 * A rack on a swinging link rolling on a pinion (5590-style steering): a tie
 * rod between two parallel steering arms carries the rack, so the rack moves
 * on an arc. The rolling relation must stay exact, not the linear guess.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Assembly } from '../../src/model/assemble';
import { MechanismSolver } from '../../src/anim/motion/v4/mechanismSolver';
import { validateMechanismProgram, type MechanismProgram, type Vec3 } from '../../src/anim/motion/v4/mechanismProgram';

const asm = { instances: ['frame', 'armL', 'armR', 'rod', 'pinion', 'input'].map(key =>
  ({ key, part: 'x', world: new THREE.Matrix4(), worldBox: { min: [0, 0, 0], max: [0, 0, 0] } })) } as unknown as Assembly;

/** Arms 30 LDU long pivot at x=±40; the rod joins their tips. `armAxis` is the
 * pivot axis: Y swings the rod across the pinion shaft (parallel to it), Z
 * swings it toward and away from the pinion. Pinion (r=10, shaft along Z) sits
 * 10 LDU below the rack's pitch line at x=0. */
const steering = (armAxis: Vec3, extra: Partial<MechanismProgram> = {}, travel?: { min: number; max: number }): MechanismProgram => {
  const tip = armAxis[1] ? [0, 0, 30] : [0, 30, 0];
  const pivot = (x: number): Vec3 => [x - tip[0], -tip[1], 30 - tip[2]];
  return {
    mode: 'kinematic', duration: 1,
    joints: [
      { id: 'armL', body: 'armL', kind: 'revolute', axis: armAxis, pivot: pivot(-40) },
      { id: 'armR', body: 'armR', kind: 'revolute', axis: armAxis, pivot: pivot(40) },
      { id: 'rod', body: 'rod', parent: 'armL', kind: 'revolute', axis: armAxis, pivot: [-40, 0, 30] },
      { id: 'pinion', body: 'pinion', kind: 'revolute', axis: [0, 0, 1], pivot: [0, -10, 30] },
      ...(extra.joints ?? []),
    ],
    closures: [{ a: { body: 'rod', local: [40, 0, 30] }, b: { body: 'armR', local: [40, 0, 30] } }],
    // Turning the pinion +Z moves its top (the contact) toward -X: reversed.
    rackContacts: [{ id: 'rack', pinion: 'pinion', rack: 'rod', contact: [0, 0, 30], direction: [1, 0, 0],
      pitchRadiusLdu: 10, reversed: true, source: 'inferred', ...(travel ? { travel } : {}) }],
    driver: { joint: 'pinion', amplitude: .5 },
    ...(extra.transmissions ? { transmissions: extra.transmissions } : {}),
    ...(extra.driver ? { driver: extra.driver } : {}),
  };
};
const at = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixPosition(m);

describe('rack on a swinging tie rod', () => {
  it('is a valid program', () => expect(validateMechanismProgram(steering([0, 1, 0]))).toEqual([]));

  it('rolls exactly: rack travel = r x pinion angle, arms follow the true arc', () => {
    const solver = new MechanismSolver(asm, steering([0, 1, 0]));
    for (const phi of [0.3, 0.6, 0.9, 1.2]) {
      const f = solver.solve(phi);
      const rod = at(f.poses.get('rod')!);
      expect(rod.x).toBeCloseTo(-10 * phi, 2);
      // Exact arc, not the small-angle line: sin(arm) = travel / arm length.
      expect(f.joints.get('armL')!).toBeCloseTo(Math.asin(-10 * phi / 30), 3);
      expect(f.joints.get('armR')!).toBeCloseTo(f.joints.get('armL')!, 3);
      expect(rod.z).toBeCloseTo(30 * Math.cos(Math.asin(phi / 3)) - 30, 2);
      expect(f.rackContactErrorsLdu![0]).toBeLessThan(.1);
    }
    expect(Math.abs(Math.asin(-0.4) - -0.4)).toBeGreaterThan(.01); // the arc is measurably not linear
  });

  it('works through a gear transmission upstream (driven from an input shaft)', () => {
    const solver = new MechanismSolver(asm, steering([0, 1, 0], {
      joints: [{ id: 'input', body: 'input', kind: 'revolute', axis: [0, 0, 1], pivot: [0, -30, 30] }],
      transmissions: [{ id: 't', kind: 'gear', a: 'input', b: 'pinion', teethA: 8, teethB: 8, source: 'inferred' }],
      driver: { joint: 'input', amplitude: .5 },
    }));
    const f = solver.solve(0.3);
    expect(f.joints.get('pinion')!).toBeCloseTo(-0.3, 6);
    expect(at(f.poses.get('rod')!).x).toBeCloseTo(3, 2);
  });

  it('stops before the pinion runs off the end of the rack', () => {
    const solver = new MechanismSolver(asm, steering([0, 1, 0], {}, { min: -8, max: 8 }));
    expect(() => solver.solve(0.5)).not.toThrow();
    expect(() => solver.solve(1.2)).toThrow(/runs off the end/);
  });

  it('refuses a linkage that swings the rack into the pinion', () => {
    const solver = new MechanismSolver(asm, steering([0, 0, 1]));
    expect(() => solver.solve(0.1)).not.toThrow(); // 0.17 LDU: within allowance
    expect(() => solver.solve(1.2)).toThrow(/swings .* LDU (into|away from) its pinion/);
  });

  it('rejects a contact that is not on the pinion pitch circle', () => {
    const p = steering([0, 1, 0]);
    p.rackContacts![0].contact = [0, 3, 30];
    expect(() => new MechanismSolver(asm, p)).toThrow(/pitch circle/);
  });
});
