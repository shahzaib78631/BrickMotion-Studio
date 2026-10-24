import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyAssemblySpotTransform, applyFloorShifts, buildTimeline, flightPose, poseAt, rootSpotLayout, spotTransform } from '../../src/anim/timeline';
import { decodeTimeline, encodeTimeline } from '../../src/anim/timelineCodec';
import { projectToJson, readProjectFile } from '../../src/io/projectFile';
import type { Timeline } from '../../src/anim/timeline';
import { assemble, placementMatrix, transformBox, unionBox, type Assembly, type Metrics } from '../../src/model/assemble';
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
      // Animation must transform *every frame*, not just its endpoints. This
      // catches stale V2 translationPath/posePath and legacy insertion vectors.
      for (const unit of plain.units) {
        for (const fraction of [0.15, 0.37, 0.68, 0.92]) {
          const t = unit.start + fraction * unit.dur;
          const original = poseAt(plain, t);
          const transformed = poseAt(moved, t);
          for (const key of unit.keys) {
            const a = original(key), b = transformed(key);
            if (a && b) expectMat(b, S.clone().multiply(a), 1e-2);
          }
        }
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

  it('legacy: a submodel built at its exact installed pose does not lift and return', () => {
    const original = plan([
      [{ id: 's1', submodel: 'wheel', x: 0, y: 0, z: 0, rot: 0 }],
      [brick(12, 0, 0)],
    ], { wheel: [[brick(0, 0, 0), brick(3, 0, 0)]] });
    const asm0 = assemble(original, metrics, fixtureColors);
    const node = asm0.nodes.find(n => n.itemId === 's1')!;
    const footprint = transformBox(node.body, placementMatrix(node.local));
    expect(footprint.max[1]).toBeCloseTo(asm0.bounds!.max[1], 4);
    const samePlace = { x: (footprint.min[0] + footprint.max[0]) / 40,
      z: (footprint.min[2] + footprint.max[2]) / 40, angle: 0 };
    const p = setSubmodelBuildSpot(original, '', 's1', samePlace);
    const tl = buildTimeline(assemble(p, metrics, fixtureColors), metrics, opts);
    const unitIndex = tl.units.findIndex(u => u.kind === 'attach' && u.keys.every(k => k.startsWith('s1/')));
    expect(unitIndex).toBeGreaterThanOrEqual(0);
    const unit = tl.units[unitIndex];
    for (const [key, track] of tl.tracks) {
      if (!key.startsWith('s1/')) continue;
      const move = track.moves.find(m => m.unit === unitIndex)!;
      expect(move.stationary).toBe(true);
      expectMat(move.from.clone().multiply(move.rel!), move.to.clone().multiply(move.rel!), 1e-6);
      for (const fraction of [0, 0.12, 0.33, 0.65, 0.98, 1])
        expectMat(poseAt(tl, unit.start + unit.dur * fraction)(key)!, track.final, 1e-5);
    }
    // An encoded/reopened timeline must keep the in-place behavior.
    const reopened = decodeTimeline(encodeTimeline(tl));
    for (const key of [...tl.tracks.keys()].filter(k => k.startsWith('s1/')))
      expectMat(poseAt(reopened, unit.start + unit.dur * 0.5)(key)!, reopened.tracks.get(key)!.final, 1e-5);
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

  it('construction-v2: a 30-degree submodel spot is built, carried rigidly, then attached', () => {
    const spot = { x: 14, z: -6, angle: 30 };
    const p = setSubmodelBuildSpot(sub(), '', 's1', spot);
    const asm = assemble(p, metrics, fixtureColors);
    const tl = buildTimeline(asm, metrics, v2);
    const attach = tl.units.find(u => u.operationId === 'construct:s1')!;
    const op = tl.construction!.operations.find(o => o.id === 'construct:s1')!;
    expect(op.rigidPath).toBeDefined();
    const delta = new THREE.Matrix4().fromArray(op.rigidPath![0]);
    const pieces = asm.instances.filter(i => i.model === 'wheel');
    const built = poseAt(tl, attach.start - 0.001);
    const footprint = boxOf(pieces, built)!;
    expect(centre2(footprint)[0]).toBeCloseTo(spot.x * 20, 1);
    expect(centre2(footprint)[1]).toBeCloseTo(spot.z * 20, 1);
    for (const inst of pieces) expectMat(built(inst.key)!, delta.clone().multiply(inst.world));
    // The member-to-member matrix MUST remain constant at intermediate frames.
    // Interpolating each brick's own yaw/position separately deforms the group.
    const a = pieces[0].key, b = pieces[1].key;
    const relative = (get: (key: string) => THREE.Matrix4 | null) => get(a)!.clone().invert().multiply(get(b)!);
    const finalRelative = pieces[0].world.clone().invert().multiply(pieces[1].world);
    for (const f of [0.1, 0.37, 0.5, 0.75, 0.9]) {
      const time = attach.start + f * attach.dur;
      expectMat(relative(poseAt(tl, time)), finalRelative, 1e-2);
    }
    const end = poseAt(tl, tl.duration);
    for (const inst of pieces) expectMat(end(inst.key)!, inst.world);
  });

  it('construction-v2: main-spot rotation and timeline codec preserve the turned flight at every frame', () => {
    const p = setSubmodelBuildSpot(sub(), '', 's1', { x: 14, z: -6, angle: 45 });
    const asm = assemble(p, metrics, fixtureColors);
    const tl = buildTimeline(asm, metrics, v2);
    const main = { x: -8, z: 9, angle: 90 };
    const S = spotTransform(main, tl.modelBox);
    const moved = applyAssemblySpotTransform(tl, main);
    const decoded = decodeTimeline(structuredClone(encodeTimeline(moved)));
    const saved = readProjectFile(projectToJson(p, [{ model: '', opts: 'rotated-v2', timeline: encodeTimeline(moved) }]));
    if (!saved.ok) throw new Error(saved.errors.join('; '));
    expect(saved.skipped).toBe(0);
    const reopened = decodeTimeline(saved.timelines[0].timeline);
    const op = tl.units.find(u => u.operationId === 'construct:s1')!;
    expect(op).toBeDefined();
    for (const fraction of [0, 0.05, 0.2, 0.39, 0.5, 0.7, 0.88, 0.999, 1]) {
      const t = op.start + fraction * op.dur;
      const before = poseAt(tl, t), after = poseAt(moved, t), roundTrip = poseAt(decoded, t), fromFile = poseAt(reopened, t);
      for (const key of op.keys) {
        const a = before(key), b = after(key), c = roundTrip(key);
        expect(b === null).toBe(a === null);
        if (a && b && c) {
          expectMat(b, S.clone().multiply(a), 1e-2);
          expectMat(c, b, 1e-3);
          expectMat(fromFile(key)!, b, 1e-3);
        }
      }
    }
  });

  it('construction-v2: dragging a loose part does not teleport when its rigid flight starts', () => {
    const p = setSubmodelBuildSpot(sub(), '', 's1', { x: 14, z: -6, angle: 30 });
    const asm = assemble(p, metrics, fixtureColors);
    const tl = buildTimeline(asm, metrics, v2);
    const key = asm.instances.find(i => i.model === 'wheel')!.key;
    const original = tl.tracks.get(key)!.moves[0];
    const shifted = applyFloorShifts(tl, new Map<string, [number, number]>([[key, [3, -2]]]));
    const moved = shifted.tracks.get(key)!.moves[0];
    expect(moved.rigidDeltas!.length).toBe(original.rigidDeltas!.length + 1);
    expectMat(moved.from, new THREE.Matrix4().makeTranslation(60, 0, -40).multiply(original.from));
    expectMat(flightPose(moved, 0.0001, new THREE.Matrix4()), moved.from, 1e-3);
    expectMat(flightPose(moved, 1, new THREE.Matrix4()), moved.to, 1e-6);
  });

  it('with no build spot the submodel keeps its automatic side spot', () => {
    const asm = assemble(sub(), metrics, fixtureColors);
    const tl = buildTimeline(asm, metrics, opts);
    const sb = tl.subBuilds[0];
    expect(centre2(sb.focus)[0]).toBeGreaterThan(asm.bounds!.max[0]);
  });
});
