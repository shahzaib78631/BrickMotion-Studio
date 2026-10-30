/** Benchmark `function` checks: a named suggestion must move what the set's function moves. */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Assembly } from '../../src/model/assemble';
import type { LabReport } from '../../src/anim/motion/v4/mechanismLab';
import type { SuggestedMechanism } from '../../src/anim/motion/v4/autoMechanics';
import type { MechanismProgram } from '../../src/anim/motion/v4/mechanismProgram';
import { scoreMechanismBenchmark, type BenchmarkSpec, type ExpectedMechanism } from '../../src/anim/motion/benchmark/mechanismBenchmark';

const inst = (key: string, part: string, at: number[]) => ({ key, part: `${part}.dat`, world: new THREE.Matrix4(),
  worldBox: { min: at.map(v => v - 5), max: at.map(v => v + 5) } });
// A knob on a vertical shaft carries an arm; a frame stays put.
const asm = { instances: [inst('knob', '32270', [0, 0, 0]), inst('arm', '32524', [40, 0, 0]), inst('frame', '3700', [0, 30, 0])] } as unknown as Assembly;
const program: MechanismProgram = { duration: 2, mode: 'kinematic',
  joints: [{ id: 'turn', body: 'knob', kind: 'revolute', axis: [0, 1, 0], pivot: [0, 0, 0] }],
  rigidFollowers: [{ leader: 'knob', bodies: ['arm'] }], driver: { joint: 'turn', amplitude: Math.PI / 2 } };
const suggestion = (kind: string): SuggestedMechanism => ({ title: kind, program, evidence: 'ldcad-shadow', warnings: [], mechanism: { kind, name: kind } });
const report = (suggestions: SuggestedMechanism[]) => ({
  graph: { edges: [], rigidClusters: [['knob'], ['arm'], ['frame']] },
  detection: { gearMeshes: [], suggestions }, geometryCandidates: [],
}) as unknown as LabReport;
const ref = (part: string, at: number[]) => ({ part, at: at as [number, number, number] });
const mech = (over: Partial<ExpectedMechanism> & { stays?: ReturnType<typeof ref>[] } = {}): ExpectedMechanism => ({
  id: 'knob', title: 'knob', evidence: 'review', ...over,
  checks: [{ type: 'function', label: 'knob swings arm', kinds: ['steering'], driver: ref('32270', [0, 0, 0]),
    moves: [ref('32524', [40, 0, 0])], ...(over.stays ? { stays: over.stays } : {}) }],
});
const spec = (...mechanisms: ExpectedMechanism[]): BenchmarkSpec => ({ schema: 'brickmotion-mechanism-benchmark-1', model: { name: 't', file: 'x' }, mechanisms });

describe('benchmark function checks', () => {
  it("function check hits when a suggestion of a listed kind moves every 'moves' part", () => {
    const r = scoreMechanismBenchmark(spec(mech()), asm, report([suggestion('steering')]));
    expect(r.checks[0].status).toBe('hit');
    expect(r.checks[0].detail).toMatch(/steering/);
  });
  it("function check misses when a 'stays' part moves", () => {
    const r = scoreMechanismBenchmark(spec(mech({ stays: [ref('32524', [40, 0, 0])] })), asm, report([suggestion('steering')]));
    expect(r.checks[0].status).toBe('missing');
    expect(r.checks[0].detail).toMatch(/32524.*moved/);
  });
  it('function check misses on a suggestion of another kind', () => {
    const r = scoreMechanismBenchmark(spec(mech()), asm, report([suggestion('turntable')]));
    expect(r.checks[0].status).toBe('missing');
  });
  it('function check misses when the driver is not the driven body', () => {
    const r = scoreMechanismBenchmark(spec({ ...mech(), checks: [{ ...(mech().checks[0] as object), driver: ref('3700', [0, 30, 0]) } as ExpectedMechanism['checks'][0]] }),
      asm, report([suggestion('steering')]));
    expect(r.checks[0].status).toBe('missing');
  });
  it('phase 4 mechanisms are scored separately', () => {
    const r = scoreMechanismBenchmark(spec(mech(), { ...mech({ id: 'later' }), phase: 4 }), asm, report([]));
    expect(r.byPhase[3]).toEqual({ hit: 0, total: 1 });
    expect(r.byPhase[4]).toEqual({ hit: 0, total: 1 });
    const hit = scoreMechanismBenchmark(spec(mech(), { ...mech({ id: 'later' }), phase: 4 }), asm, report([suggestion('steering')]));
    expect(hit.byPhase[3]).toEqual({ hit: 1, total: 1 });
  });
});
