import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Assembly, Metrics } from '../../src/model/assemble';
import type { MechanismProgram } from '../../src/anim/motion/v4/mechanismProgram';
import { MechanismSolver } from '../../src/anim/motion/v4/mechanismSolver';
import { inspectMechanisms, mechanismReportDot, mechanismReportJson, previewAmplitude, solveLabFrame, MAX_LAB_PARTS } from '../../src/anim/motion/v4/mechanismLab';

const bounding = { min: [-1,-1,-1], max: [1,1,1] } as const;
const assembly = (): Assembly => ({
  instances: [
    { key: 'body', itemId: 'body', model: '', part: 'part1', color: 4, world: new THREE.Matrix4(), worldBox: bounding, placeholder: false, grid: false },
    { key: 'follower', itemId: 'follower', model: '', part: 'part2', color: 2, world: new THREE.Matrix4().makeTranslation(10,0,0),
      worldBox: { min: [9,-1,-1], max: [11,1,1] }, placeholder: false, grid: false },
  ], nodes: [], bounds: { min: [-1,-1,-1], max: [11,1,1] }, problems: [],
} as unknown as Assembly);
const metrics: Metrics = () => ({
  full: { min: [-1,-1,-1], max: [1,1,1] },
  body: { min: [-1,-1,-1], max: [1,1,1] },
  snaps: [],
} as unknown as ReturnType<Metrics>);
const program = (): MechanismProgram => ({
  mode: 'kinematic', duration: 3,
  joints: [{ id: 'hinge', body: 'body', kind: 'revolute', axis: [0,0,1], pivot: [0,0,0] }],
  rigidFollowers: [{ leader: 'body', bodies: ['follower'] }],
  driver: { joint: 'hinge', amplitude: 0.2 },
});

describe('Mechanism Lab (assembled model inspection)', () => {
  it('exports machine-readable diagnostic counts and a Graphviz graph', () => {
    const report = inspectMechanisms(assembly(), metrics);
    expect(report.detection.scanned).toBe(2);
    expect(report.missingMetadata).toBe(2);
    expect(report.detection.gearMeshes).toHaveLength(0);
    const json = JSON.parse(mechanismReportJson(report, 'test-model'));
    expect(json.counts.parts).toBe(2);
    expect(json.modelName).toBe('test-model');
    expect(json.disclaimer).toMatch(/not verified/i);
    expect(mechanismReportDot(report)).toMatch(/^graph BrickMotion/);
  });
  it('poses welded followers by the same world-space rigid delta', () => {
    const solver = new MechanismSolver(assembly(), program());
    solver.assembled();
    const poses = solveLabFrame(solver, Math.PI / 2);
    const leader = poses.get('body')!;
    const child = poses.get('follower')!;
    expect(leader.elements[0]).toBeCloseTo(0, 7);
    expect(child.elements[12]).toBeCloseTo(0, 7);
    expect(child.elements[13]).toBeCloseTo(10, 7);
  });
  it('chooses a conservative 15-degree rotation / 8-LDU sliding preview', () => {
    expect(previewAmplitude(program())).toBeCloseTo(Math.PI / 12);
    const slider = program(); slider.joints[0].kind = 'prismatic';
    expect(previewAmplitude(slider)).toBe(8);
  });
  it('limits main-thread inspection of giant scenes', () => {
    const large = assembly();
    large.instances = Array.from({ length: MAX_LAB_PARTS + 1 }, () => large.instances[0]);
    expect(() => inspectMechanisms(large, metrics)).toThrow(/limited to/i);
  });
});
