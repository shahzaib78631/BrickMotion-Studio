/** Vehicle, scrub and bump-steer benchmark checks (spec §5) on a stubbed report. Own file: it loads a part table. */
import * as THREE from 'three';
import { afterAll, describe, expect, it } from 'vitest';
import type { Assembly } from '../../src/model/assemble';
import type { LabReport } from '../../src/anim/motion/v4/mechanismLab';
import type { MechanismProgram } from '../../src/anim/motion/v4/mechanismProgram';
import type { Vehicle } from '../../src/anim/motion/vehicle/vehicle';
import { loadPartFunctionTable, resetPartFunctions } from '../../src/anim/motion/parts/partFunctions';
import { scoreMechanismBenchmark, type BenchmarkCheck, type BenchmarkSpec } from '../../src/anim/motion/benchmark/mechanismBenchmark';

afterAll(resetPartFunctions);
loadPartFunctionTable({ format: 'brickmotion-part-functions', version: 1, library: 'test', scanned: 1,
  parts: { 'test-tyre': { teeth: [], bores: [], rods: [], seats: [{ gender: 'F', axis: [1, 0, 0], centre: [0, 0, 0], radius: 10, width: 10 }] } } });

type V3 = [number, number, number];
// The arms and upright are authored at the origin (as in suspensionSynthetic.test.ts); wheels where they stand.
const inst = (key: string, part: string, at: V3, world = new THREE.Matrix4().makeTranslation(...at)) => ({ key, part: `${part}.dat`, world,
  worldBox: { min: at.map(v => v - 5), max: at.map(v => v + 5) }, placeholder: false });
const norm = (x: number, z: number): V3 => { const l = Math.hypot(x, z); return [x / l, 0, z / l]; };
// A six-wheeler driving +z: tandem rear axles at z = ±30, a front axle at z = 200 steered toward a centre at (200, 0).
const at: V3[] = [[50, 0, -30], [-50, 0, -30], [50, 0, 30], [-50, 0, 30], [50, 0, 200], [-50, 0, 200]];
const axes: V3[] = [[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], norm(150, -200), norm(250, -200)];
const vehicle: Vehicle = {
  wheels: at.map((c, i) => ({ tyre: `w${i}`, parts: [`w${i}`], centre: c, axis: axes[i], radius: 20, axle: Math.floor(i / 2), steered: i >= 4 })),
  axles: [{ solid: false, steered: false }, { solid: false, steered: false }, { solid: false, steered: true }],
  groundY: 20, forward: [0, 0, 1], ref: [0, 20, 0], towed: [], warnings: [],
} as unknown as Vehicle;
// The parallelogram of suspensionSynthetic.test.ts, carrying a test tyre at (60, 10, 0).
const susp: MechanismProgram = { mode: 'kinematic', duration: 4,
  joints: [{ id: 'j1', body: 'arm1', kind: 'revolute', axis: [0, 0, 1], pivot: [0, 0, 0] }, { id: 'j2', body: 'arm2', kind: 'revolute', axis: [0, 0, 1], pivot: [0, 20, 0] },
    { id: 'j3', body: 'up', parent: 'arm1', kind: 'revolute', axis: [0, 0, 1], pivot: [40, 0, 0] }],
  closures: [{ a: { body: 'up', local: [40, 20, 0] }, b: { body: 'arm2', local: [40, 20, 0] } }],
  rigidFollowers: [{ leader: 'up', bodies: ['tyre'] }], driver: { joint: 'j2', amplitude: 0.3 } };
const asm = { instances: [...at.map((c, i) => inst(`w${i}`, '44771', c)), inst('arm1', 'arm', [0, 0, 0], new THREE.Matrix4()), inst('arm2', 'arm', [0, 20, 0], new THREE.Matrix4()),
  inst('up', 'up', [40, 10, 0], new THREE.Matrix4()), inst('tyre', 'test-tyre', [60, 10, 0])], nodes: [], problems: [], bounds: { min: [-100, -100, -100], max: [100, 100, 100] } } as unknown as Assembly;
const report = (v: Vehicle | null, suggestions: unknown[] = []) => ({ graph: { edges: [], rigidClusters: [] }, detection: { gearMeshes: [], suggestions },
  geometryCandidates: [], vehicle: v }) as unknown as LabReport;
const score = (checks: BenchmarkCheck[], r: LabReport) => scoreMechanismBenchmark({ schema: 'brickmotion-mechanism-benchmark-1', model: { name: 't', file: 'x' },
  toleranceLdu: 3, mechanisms: [{ id: 'v', title: 'v', evidence: 'review', phase: 5, checks }] } as BenchmarkSpec, asm, r).checks;
const tyre = (i: number) => ({ part: '44771', at: at[i] });

describe('vehicle benchmark checks', () => {
  it('scores wheels, axles and steered axles, and says what it found', () => {
    const c = score([{ type: 'vehicle', label: 'six', wheels: 6, axles: 3, steered: 1 }, { type: 'vehicle', label: 'four', wheels: 4, axles: 2, steered: 1 }], report(vehicle));
    expect(c.map(x => x.status)).toEqual(['hit', 'missing']);
    expect(c[1].detail).toBe('found 6 wheels on 3 axles (1 steered)');
    expect(score([{ type: 'vehicle', label: 'six', wheels: 6, axles: 3, steered: 1 }], report(null))[0]).toMatchObject({ status: 'missing', detail: 'no vehicle' });
  });
  it('scores each tandem axle\'s slip, as posed, in opposite senses', () => {
    const slip = (i: number, sign: 1 | -1, minDeg = 8.5, maxDeg = 9.5): BenchmarkCheck => ({ type: 'scrub', label: `axle ${i}`, axle: tyre(i), sign, minDeg, maxDeg });
    const c = score([slip(0, 1), slip(2, -1), slip(0, -1), slip(2, 1, 1, 2)], report(vehicle));
    expect(c.map(x => x.status)).toEqual(['hit', 'hit', 'missing', 'missing']);
    expect(c[2].detail).toMatch(/^slip 9\.\d\d° outside -9\.5\.\.-8\.5$/);
    expect(c[3].detail).toMatch(/^slip -9\.\d\d° outside 1\.\.2$/);
    expect(score([slip(0, 1)], report(null))[0].detail).toBe('no vehicle');
  });
  it('scores bump steer from a suspension carrying the wheel', () => {
    const t = { part: 'test-tyre', at: [60, 10, 0] as V3 };
    const s = { title: 'Suspension', evidence: 'classified', mechanism: { kind: 'suspension', name: 's' }, program: susp, warnings: [], wheel: 'tyre' };
    expect(score([{ type: 'bumpSteer', label: 'b', wheel: t, maxDeg: 0.5 }], report(vehicle, [s]))[0].status).toBe('hit');
    expect(score([{ type: 'bumpSteer', label: 'b', wheel: t, maxDeg: 0.5 }], report(vehicle, []))[0]).toMatchObject({ status: 'missing', detail: 'no suspension carries this wheel' });
  });
});
