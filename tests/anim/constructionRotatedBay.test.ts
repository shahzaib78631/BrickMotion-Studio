import { describe, expect, it } from 'vitest';
import type { ANode } from '../../src/model/assemblyTypes';
import type { Box } from '../../src/ldraw/flatten';
import type { PartMetrics } from '../../src/ldraw/metrics';
import type { Mat3, Vec3 } from '../../src/ldraw/parse';
import type { AssemblySpot } from '../../src/plan/types';
import { modelFromNodes } from '../../src/anim/construction/input';
import { planConstruction } from '../../src/anim/construction/planner';
import { compileConstruction } from '../../src/anim/construction/compile';
import { centre, identity, multiply, point } from '../../src/anim/construction/math';
import { fixedBayPose, turningSphere } from '../../src/anim/construction/rigidStaging';

/** Small, REAL triangle meshes: the suite runs without a downloaded LDraw pack.
 * Unlike checking the marker, it exercises V2 search, certification, forward
 * replay and encoded video tracks with actual solid geometry. */
const BODY: Box = { min: [-8, -8, -8], max: [8, 0, 8] };
const BASIS: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function cubeMesh(): Float32Array {
  const p = ([x, y, z]: [number, number, number]) => [x ? 8 : -8, y ? 0 : -8, z ? 8 : -8];
  const faces: [number, number, number][][] = [
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  ];
  return Float32Array.from(faces.flatMap(([a, b, c, d]) => [...p(a), ...p(b), ...p(c), ...p(a), ...p(c), ...p(d)]));
}
const CUBE: PartMetrics = { id: 'testbox', body: BODY, full: BODY, footprint: { w: 1, d: 1 }, heightPlates: 1,
  placeholder: false, mesh: cubeMesh(), studs: [] };
const metrics = (_: string): PartMetrics => CUBE;
const piece = (itemId: string, x: number, z: number): ANode => ({
  kind: 'piece', itemId, model: 'unit', step: 0, order: 0, part: 'testbox', color: 16,
  placeholder: false, grid: false, body: BODY, local: { pos: [x, 0, z], m: BASIS },
});
const group = (itemId: string, children: ANode[], spot: AssemblySpot | undefined): ANode => ({
  kind: 'sub', itemId, model: 'unit', submodel: itemId, step: 0, order: 0, body: BODY,
  local: { pos: [0, 0, 0], m: BASIS }, children,
  ...(spot ? { assembly: { buildSpot: spot } } : {}),
});
const eqMat = (actual: readonly number[], expected: readonly number[], precision = 6) =>
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], precision));
const make = (spot?: AssemblySpot) => modelFromNodes([
  group('wheel', [piece('a', 0, 0), piece('b', 36, 0)], spot),
  piece('chassis', 180, 80),
], metrics);
const run = (spot?: AssemblySpot) => {
  const model = make(spot);
  const construction = planConstruction(model, { mechanicalSubassemblies: false });
  const video = compileConstruction(construction, { targetSeconds: 20, heroOrbit: false });
  return { model, construction, video };
};

describe('Construction V2 independently rotated build bays', () => {
  it.each([15, 30, 45, 90, 135, 180, -45, 270])('assembles and transports a submodel at %d degrees', angle => {
    const spot = { x: 14, z: -6, angle };
    const { model, construction, video } = run(spot);
    const node = model.nodes[0];
    const attach = construction.operations.find(o => o.id === 'construct:wheel')!;
    expect(attach.rigidPath).toBeDefined();
    const expected = fixedBayPose(node.bounds, spot, model.bounds.max[1]);
    eqMat(attach.rigidPath![0], expected);
    eqMat(attach.rigidPath!.at(-1)!, identity());
    const centreAtBay = point(attach.rigidPath![0], centre(node.bounds));
    expect(centreAtBay[0]).toBeCloseTo(spot.x * 20, 6);
    expect(centreAtBay[2]).toBeCloseTo(spot.z * 20, 6);
    expect(video.subBuilds.find(s => s.key === 'wheel')).toBeDefined();
    const focus = video.subBuilds.find(s => s.key === 'wheel')!.focus;
    expect((focus.min[0] + focus.max[0]) / 2).toBeCloseTo(spot.x * 20, 6);
    expect((focus.min[2] + focus.max[2]) / 2).toBeCloseTo(spot.z * 20, 6);
    for (const part of construction.parts.filter(p => p.key.startsWith('wheel/'))) {
      const preceding = construction.operations.filter(op => op.keys.includes(part.key) && op !== attach).at(-1)!;
      expect(preceding).toBeDefined();
      const source = model.parts.get(part.key)!.matrix;
      const lastPose = preceding.rigidPath?.at(-1) ?? (() => { const m = identity(); m.splice(12, 3, ...preceding.path.at(-1)!); return m; })();
      eqMat(multiply(lastPose, source), multiply(expected, source));
    }
    // Only the first operation for each piece starts at its inventory slot;
    // the finished car pose must be the original model, not the turned bay.
    for (const part of construction.parts) eqMat(part.final, model.parts.get(part.key)!.matrix);
    expect(video.units.filter(u => u.uncertified)).toEqual([]);
  });

  it('keeps the previous translation-only plan when no spot is requested', () => {
    const { construction } = run();
    expect(construction.operations.every(o => !o.rigidPath)).toBe(true);
  });

  it('treats 360 degrees as the same facing as zero', () => {
    const { construction } = run({ x: 14, z: -6, angle: 360 });
    expect(construction.operations.every(o => !o.rigidPath)).toBe(true);
  });

  it('supports independent nested bays without inheriting their parent angle', () => {
    const innerSpot = { x: -14, z: 8, angle: -90 };
    const outerSpot = { x: 17, z: -10, angle: 30 };
    const model = modelFromNodes([
      group('outer', [group('inner', [piece('one', 0, 0), piece('two', 32, 0)], innerSpot), piece('extra', -48, 0)], outerSpot),
      piece('chassis', 180, 80),
    ], metrics);
    const construction = planConstruction(model, { mechanicalSubassemblies: false });
    compileConstruction(construction, { targetSeconds: 20, heroOrbit: false });
    const inner = model.nodes[0].children![0];
    const innerAttach = construction.operations.find(o => o.id === 'construct:outer/inner')!;
    const outerAttach = construction.operations.find(o => o.id === 'construct:outer')!;
    eqMat(innerAttach.rigidPath![0], fixedBayPose(inner.bounds, innerSpot, model.bounds.max[1]));
    eqMat(innerAttach.rigidPath!.at(-1)!, fixedBayPose(model.nodes[0].bounds, outerSpot, model.bounds.max[1]));
    eqMat(outerAttach.rigidPath!.at(-1)!, identity());
  });

  it('rejects an invalid angle with a named input error', () => {
    const model = make({ x: 14, z: -6, angle: Number.NaN });
    expect(() => planConstruction(model)).toThrow(/invalid coordinates or angle.*wheel/i);
  });

  it('the continuous yaw envelope encloses every corner at intermediate angles', () => {
    const bounds: Box = { min: [-22, -8, -11], max: [34, 0, 11] };
    const pivot: Vec3 = centre(bounds);
    const sphere = turningSphere(bounds, fixedBayPose(bounds, { x: 8, z: -6, angle: 30 }, 0));
    for (const degrees of Array.from({ length: 25 }, (_, i) => i * 15)) {
      const m = fixedBayPose(bounds, { x: 8, z: -6, angle: degrees }, 0);
      for (const x of [bounds.min[0], bounds.max[0]])
        for (const y of [bounds.min[1], bounds.max[1]])
          for (const z of [bounds.min[2], bounds.max[2]]) {
            const p = point(m, [x, y, z]);
            // All fixedBayPose angles have the same world centre.
            expect(p.every((v, k) => v >= sphere.min[k] - 1e-7 && v <= sphere.max[k] + 1e-7)).toBe(true);
          }
    }
    expect(pivot).toHaveLength(3);
  });
});
