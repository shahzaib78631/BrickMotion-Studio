/** Suspension sweep on a synthetic parallelogram: the upright never tilts or turns (spec §5.6). Own file: it loads a part table. */
import * as THREE from 'three';
import { afterAll, expect, it } from 'vitest';
import type { Assembly } from '../../../src/model/assemble';
import type { MechanismProgram } from '../../../src/anim/motion/v4/mechanismProgram';
import { loadPartFunctionTable, resetPartFunctions } from '../../../src/anim/motion/parts/partFunctions';
import { shockStroke, sweepSuspension } from '../../../src/anim/motion/vehicle/suspension';

afterAll(resetPartFunctions);
loadPartFunctionTable({ format: 'brickmotion-part-functions', version: 1, library: 'test', scanned: 1,
  parts: { 'test-tyre': { teeth: [], bores: [], rods: [], seats: [{ gender: 'F', axis: [1, 0, 0], centre: [0, 0, 0], radius: 10, width: 10 }] } } });

const at = (x: number, y: number) => new THREE.Matrix4().makeTranslation(x, y, 0);
const instance = (key: string, part: string, m: THREE.Matrix4) => ({ key, part, world: m, worldBox: { min: [-1, -1, -1], max: [1, 1, 1] }, placeholder: false });
// Arms on the frame about z at y = 0 and y = 20 (LDraw +y is down), 40 LDU long; the upright joins their ends; the tyre on the upright.
const asm = { instances: [instance('arm1', 'arm.dat', new THREE.Matrix4()), instance('arm2', 'arm.dat', new THREE.Matrix4()),
  instance('up', 'up.dat', new THREE.Matrix4()), instance('tyre', 'test-tyre.dat', at(60, 10))], nodes: [], problems: [], bounds: { min: [-100, -100, -100], max: [100, 100, 100] } } as unknown as Assembly;
const program: MechanismProgram = {
  mode: 'kinematic', duration: 4,
  joints: [
    { id: 'j1', body: 'arm1', kind: 'revolute', axis: [0, 0, 1], pivot: [0, 0, 0] },
    { id: 'j2', body: 'arm2', kind: 'revolute', axis: [0, 0, 1], pivot: [0, 20, 0] },
    { id: 'j3', body: 'up', parent: 'arm1', kind: 'revolute', axis: [0, 0, 1], pivot: [40, 0, 0] },
  ],
  closures: [{ a: { body: 'up', local: [40, 20, 0] }, b: { body: 'arm2', local: [40, 20, 0] } }],
  rigidFollowers: [{ leader: 'up', bodies: ['tyre'] }],
  driver: { joint: 'j2', amplitude: 0.3 },
};

it('a parallelogram suspension keeps the wheel upright: no camber gain, no bump steer', () => {
  const s = sweepSuspension(asm, program, 'tyre');
  expect(s.travelLdu).toBeGreaterThan(10);
  expect(Math.abs(s.camberGainDegPerLdu)).toBeLessThan(1e-6);
  expect(s.bumpSteerDeg).toBeLessThan(1e-6);
  expect(s.strokeMeasured).toBe(false);
  expect(s.samples.length).toBeGreaterThan(8);
});

it('parts with no fitting rod and bore give no stroke', () => {
  expect(shockStroke(asm, 'arm1', 'arm2', [0, 1, 0])).toBeNull();
});
