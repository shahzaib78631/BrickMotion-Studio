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

  describe('gearbox checks', () => {
    // The two-speed box of tests/anim/gearbox/shiftModes.test.ts: body 0 input shaft, 3 output, 4 ring.
    const gasm = { instances: [inst('in', '3706', [0, 0, 0]), inst('out', '3706', [0, 0, 40]), inst('ring', '6539', [0, 0, 20]),
      inst('g1', '6542b', [0, 0, 10]), inst('g2', '6542b', [0, 0, 30])] } as unknown as Assembly;
    const ring = { ring: 'ring', ringBody: 4, shaftBody: 0, axis: [0, 0, 1], centre: [0, 0, 20], travel: [-12, 12], dogs: 4,
      couplings: [{ gear: 'g1', gearBody: 1, side: -1, engageAt: -2 }, { gear: 'g2', gearBody: 2, side: 1, engageAt: 2 }] };
    const greport = {
      graph: { edges: [], rigidClusters: [], recognition: { bodyOf: new Map([['in', 0], ['g1', 1], ['g2', 2], ['out', 3], ['ring', 4]]) } },
      detection: { gearMeshes: [], suggestions: [] }, geometryCandidates: [],
      gearbox: { shifts: [ring], network: { meshes: [{ a: 1, b: 3, teethA: 30, teethB: 10, pair: 'p1' }, { a: 2, b: 3, teethA: 10, teethB: 30, pair: 'p2' }], locks: [] } },
    } as unknown as LabReport;
    const IN = { part: '3706', at: [0, 0, 0] as [number, number, number] }, OUT = { part: '3706', at: [0, 0, 40] as [number, number, number] };
    const specWith = (checks: BenchmarkSpec['mechanisms'][0]['checks']): BenchmarkSpec => ({ ...spec, mechanisms: [{ id: 'g', title: 'g', evidence: 'review', checks }] });
    it('scores a gear ratio from the mode table and a neutral row', () => {
      const r = scoreMechanismBenchmark(specWith([
        { type: 'shiftMode', label: 'low', input: IN, output: OUT, ratio: 3 },
        { type: 'shiftMode', label: 'neutral', input: IN, output: OUT, ratio: null },
        { type: 'shiftMode', label: 'missing', input: IN, output: OUT, ratio: 2 }]), gasm, greport);
      expect(r.checks.map(c => c.status)).toEqual(['hit', 'hit', 'missing']);
      expect(r.checks[2].detail).toMatch(/3\.00.*0\.33/);
    });
    it('scores a recognised ring and its gears', () => {
      const ringRef = { part: '6539', at: [0, 0, 20] as [number, number, number] };
      const r = scoreMechanismBenchmark(specWith([
        { type: 'shifts', label: 'ring', ring: ringRef, gears: [{ part: '6542b', at: [0, 0, 10] }, { part: '6542b', at: [0, 0, 30] }] },
        { type: 'shifts', label: 'ring, wrong gear', ring: ringRef, gears: [{ part: '3706', at: [0, 0, 40] }] }]), gasm, greport);
      expect(r.checks.map(c => c.status)).toEqual(['hit', 'missing']);
    });
    it('says when there is no gearbox at all', () => {
      const r = scoreMechanismBenchmark(specWith([{ type: 'shiftMode', label: 'low', input: IN, output: OUT, ratio: 3 }]), gasm,
        { ...greport, gearbox: { shifts: [], network: { meshes: [], locks: [] } } } as LabReport);
      expect(r.checks[0]).toMatchObject({ status: 'missing', detail: 'no shift elements' });
    });
  });
});
