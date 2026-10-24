import type * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyAssemblySpotTransform, buildTimeline, poseAt, rootSpotLayout, spotTransform } from '../../src/anim/timeline';
import type { Timeline } from '../../src/anim/timeline';
import { assemble, transformBox, unionBox, type Assembly, type Metrics } from '../../src/model/assemble';
import type { Box } from '../../src/ldraw/flatten';
import { centre2 } from '../../src/plan/assemblySpots';
import { ensureIds } from '../../src/plan/ids';
import type { Plan, PlanItem } from '../../src/plan/types';
import { setSubmodelBuildSpot } from '../../src/plan/pieceActions';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics(['3001', '3020']);
});

const opts = { targetSeconds: 15, heroOrbit: true };
const v2 = { ...opts, planner: 'construction-v2' as const };
const brick = (x: number, y: number, z: number): PlanItem => ({ part: '3001', color: 4, x, y, z, rot: 0 });
const plan = (steps: PlanItem[][], submodels?: Record<string, PlanItem[][]>): Plan =>
  ensureIds({
    format: 'brickmotion-plan',
    version: 1,
    name: 't',
    steps: steps.map((pieces) => ({ pieces })),
    ...(submodels ? { submodels: Object.fromEntries(Object.entries(submodels).map(([k, v]) => [k, { steps: v.map((pieces) => ({ pieces })) }])) } : {}),
  });
const tower = () => plan([[brick(0, 0, 0)], [brick(0, 3, 0)], [brick(0, 6, 0)]]);

const expectMat = (a: THREE.Matrix4, b: THREE.Matrix4, eps = 1e-3) =>
  a.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], -Math.log10(eps)));
const boxOf = (list: Assembly['instances'], pose: (key: string) => THREE.Matrix4 | null): Box | null => {
  let b: Box | null = null;
  for (const inst of list) {
    const m = pose(inst.key);
    if (!m) continue;
    b = unionBox(b, transformBox(metrics(inst.part).body, m));
  }
  return b;
};

describe('main spot, loose pieces follow on (after planning)', () => {
  for (const [name, options] of [['legacy', opts], ['construction-v2', v2]] as const) {
    it(`${name}: every final pose and box turns and moves with the model`, () => {
      const asm = assemble(tower(), metrics, fixtureColors);
      const plain = buildTimeline(asm, metrics, options);
      const spot = { x: 10, z: -5, angle: 90 };
      const S = spotTransform(spot, plain.modelBox);
      const moved = applyAssemblySpotTransform(plain, spot);

      for (const [key, tr] of plain.tracks) {
        expectMat(moved.tracks.get(key)!.final, S.clone().multiply(tr.final));
        expectMat(moved.tracks.get(key)!.floor, S.clone().multiply(tr.floor));
      }
      // the finished model's footprint centre lands on the spot
      expect(centre2(moved.modelBox)[0]).toBeCloseTo(spot.x * 20, 3);
      expect(centre2(moved.modelBox)[1]).toBeCloseTo(spot.z * 20, 3);
      // the camera keeps the whole moved model in the scene it frames
      for (const k of [0, 2] as const) {
        expect(moved.sceneBox.min[k]).toBeLessThanOrEqual(moved.modelBox.min[k] + 1e-6);
        expect(moved.sceneBox.max[k]).toBeGreaterThanOrEqual(moved.modelBox.max[k] - 1e-6);
      }
      // a spot at the model's own centre with no angle changes nothing
      const identity = applyAssemblySpotTransform(plain, { x: centre2(plain.modelBox)[0] / 20, z: centre2(plain.modelBox)[1] / 20, angle: 0 });
      for (const [key, tr] of plain.tracks) expectMat(identity.tracks.get(key)!.final, tr.final, 1e-6);
    });
  }

  it('turns the whole scene rigidly, so relative poses are kept', () => {
    const asm = assemble(tower(), metrics, fixtureColors);
    const plain = buildTimeline(asm, metrics, opts);
    const keys = [...plain.tracks.keys()];
    const moved = applyAssemblySpotTransform(plain, { x: 0, z: 0, angle: 180 });
    const rel = (t: Timeline, a: string, b: string) => t.tracks.get(a)!.final.clone().invert().multiply(t.tracks.get(b)!.final);
    expectMat(rel(moved, keys[0], keys[1]), rel(plain, keys[0], keys[1]));
    expect(centre2(moved.modelBox)[0]).toBeCloseTo(0, 3);
    expect(centre2(moved.modelBox)[1]).toBeCloseTo(0, 3);
  });
});

describe('main spot, loose pieces follow off (before planning)', () => {
  const spot = { x: 12, z: -6, angle: 30 };

  const run = (p: Plan, asm: Assembly): { tl: Timeline; moved: Assembly; layoutBox: Box | null } => {
    const { asm: moved, layoutBox } = rootSpotLayout(asm, p);
    return { tl: buildTimeline(moved, metrics, opts, undefined, layoutBox), moved, layoutBox };
  };

  it('moves the model but leaves the automatic floor where it was', () => {
    const base = tower();
    const asm = assemble(base, metrics, fixtureColors);
    const plain = buildTimeline(asm, metrics, opts);
    const { tl, moved, layoutBox } = run({ ...base, assemblySpot: spot, loosePiecesFollow: false }, asm);
    expect(layoutBox).not.toBeNull();
    expect(moved.bounds).not.toBeNull();

    const S = spotTransform(spot, asm.bounds!);
    for (const inst of asm.instances) expectMat(tl.tracks.get(inst.key)!.final, S.clone().multiply(inst.world));

    // the floor pieces still start exactly where the no-spot run put them
    const at0 = poseAt(tl, 0);
    const plain0 = poseAt(plain, 0);
    for (const inst of asm.instances) {
      const a = at0(inst.key), b = plain0(inst.key);
      if (!a || !b) {
        expect(a).toBe(b);
        continue;
      }
      expectMat(a, b);
    }
  });

  it('does nothing when the switch is on', () => {
    const base = tower();
    const asm = assemble(base, metrics, fixtureColors);
    const { layoutBox, asm: moved } = rootSpotLayout(asm, { ...base, assemblySpot: spot });
    expect(layoutBox).toBeNull();
    expect(moved).toBe(asm);
  });
});

describe('submodel build spot', () => {
  const sub = () => plan([[{ id: 's1', submodel: 'wheel', x: 0, y: 3, z: 0, rot: 0 }, brick(0, 0, 0)]], { wheel: [[{ part: '3020', color: 72, x: 0, y: 0, z: 0, rot: 0 }], [brick(0, 1, 0)]] });

  it('legacy: the submodel is built at the spot and still lands in its place', () => {
    const p = setSubmodelBuildSpot(sub(), '', 's1', { x: 14, z: -6, angle: 0 });
    const asm = assemble(p, metrics, fixtureColors);
    const tl = buildTimeline(asm, metrics, opts);
    const sb = tl.subBuilds.find((s) => s.key === 's1')!;
    expect(sb).toBeDefined();
    const pieces = asm.instances.filter((i) => i.model === 'wheel');
    const built = boxOf(pieces, poseAt(tl, sb.attachStart - 1e-3))!;
    expect(centre2(built)[0]).toBeCloseTo(14 * 20, 2);
    expect(centre2(built)[1]).toBeCloseTo(-6 * 20, 2);
    // the finished submodel still attaches exactly where it belongs
    const end = poseAt(tl, tl.duration);
    for (const inst of pieces) expectMat(end(inst.key)!, inst.world);
  });

  it('construction-v2: the submodel is staged at the spot', () => {
    const p = setSubmodelBuildSpot(sub(), '', 's1', { x: 14, z: -6, angle: 0 });
    const asm = assemble(p, metrics, fixtureColors);
    const tl = buildTimeline(asm, metrics, v2);
    const sb = tl.subBuilds.find((s) => s.key === 's1')!;
    expect(sb).toBeDefined();
    expect(centre2(sb.focus)[0]).toBeCloseTo(14 * 20, 0);
    expect(centre2(sb.focus)[1]).toBeCloseTo(-6 * 20, 0);
    const end = poseAt(tl, tl.duration);
    for (const inst of asm.instances.filter((i) => i.model === 'wheel')) expectMat(end(inst.key)!, inst.world);
  });

  it('with no build spot the submodel keeps its automatic side spot', () => {
    const asm = assemble(sub(), metrics, fixtureColors);
    const tl = buildTimeline(asm, metrics, opts);
    const sb = tl.subBuilds[0];
    expect(centre2(sb.focus)[0]).toBeGreaterThan(asm.bounds!.max[0]);
  });
});
