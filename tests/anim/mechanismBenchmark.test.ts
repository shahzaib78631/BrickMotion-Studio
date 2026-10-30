import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Assembly } from '../../src/model/assemble';
import type { LabReport } from '../../src/anim/motion/v4/mechanismLab';
import { scoreMechanismBenchmark, type BenchmarkSpec } from '../../src/anim/motion/benchmark/mechanismBenchmark';

const inst = (key: string, part: string, at: number[]) => ({ key, part: `${part}.dat`, world: new THREE.Matrix4(),
  worldBox: { min: at.map(v => v - 5), max: at.map(v => v + 5) } });
const asm = { instances: [inst('shaft', '3706', [0, 0, 0]), inst('frame', '3700', [0, 20, 0]), inst('gear', '3647', [0, 0, 10]), inst('rack', '3743', [0, 12, 10])] } as unknown as Assembly;
const edge = (a: string, b: string, motion: string, axis: number[], type = 'pin-hole') => ({ id: `${a}-${b}`, a, b, motion, axis, type, centre: [0, 0, 0] });
const report = (edges: unknown[], extra: Partial<LabReport['detection']> = {}, geometryCandidates: unknown[] = []) => ({
  graph: { edges, rigidClusters: [['shaft'], ['frame'], ['gear'], ['rack']] },
  detection: { gearMeshes: [], suggestions: [], ...extra }, geometryCandidates,
}) as unknown as LabReport;
const spec: BenchmarkSpec = { schema: 'brickmotion-mechanism-benchmark-1', model: { name: 't', file: 'x' }, mechanisms: [{
  id: 'm', title: 'm', evidence: 'geometry', checks: [
    { type: 'rotates', label: 'shaft turns', part: { part: '3706', at: [1, 0, 0] }, axis: [0, 1, 0] },
    { type: 'rackPinion', label: 'rack', pinion: { part: '3647', at: [0, 0, 10] }, rack: { part: '3743', at: [0, 12, 10] } },
  ] }] };

describe('mechanism benchmark scorer', () => {
  it('accepts an opposite-direction axis and reports a hit', () => {
    const r = scoreMechanismBenchmark(spec, asm, report([edge('shaft', 'frame', 'revolute', [0, -1, 0])]));
    expect(r.checks[0].status).toBe('hit');
  });
  it('separates a wrong motion type from a missing joint', () => {
    expect(scoreMechanismBenchmark(spec, asm, report([edge('shaft', 'frame', 'sliding', [0, 1, 0])])).checks[0].status).toBe('wrong-motion');
    expect(scoreMechanismBenchmark(spec, asm, report([edge('shaft', 'frame', 'revolute', [1, 0, 0])])).checks[0].status).toBe('missing');
  });
  it('reports a rack-and-pinion the geometry screen turned down as rejected', () => {
    const geo = [{ kind: 'rack-pinion', a: 'gear', b: 'rack', status: 'rejected', reasons: ['too far'] }];
    expect(scoreMechanismBenchmark(spec, asm, report([], {}, geo)).checks[1].status).toBe('rejected');
  });
  it('flags a benchmark that points at a part that is not there', () => {
    const bad = { ...spec, mechanisms: [{ ...spec.mechanisms[0], checks: [{ ...spec.mechanisms[0].checks[0], part: { part: '3706', at: [100, 0, 0] } }] }] } as BenchmarkSpec;
    expect(scoreMechanismBenchmark(bad, asm, report([])).checks[0].status).toBe('unresolved');
  });
});
