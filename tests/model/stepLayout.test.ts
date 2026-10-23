import { beforeAll, expect, test } from 'vitest';
import { assemble, transformBox, type Metrics } from '../../src/model/assemble';
import { stepPoses, timelineStep } from '../../src/model/stepLayout';
import { buildTimeline, poseAt } from '../../src/anim/timeline';
import { ensureIds } from '../../src/plan/ids';
import type { PlanItem } from '../../src/plan/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics();
});

const brick = (x: number, y: number, z: number): PlanItem => ({ part: '3001', color: 4, x, y, z, rot: 0 });
const asm = () =>
  assemble(
    ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [brick(0, 0, 0), brick(4, 0, 0)] }, { pieces: [brick(0, 3, 0), brick(2, 3, 0)] }] }),
    metrics,
    fixtureColors,
  );

test('separated: the step\'s new parts lie on the floor in front of the model, apart from it and each other', () => {
  const a = asm();
  const poses = stepPoses(a, 1, 'separated');
  const fresh = a.instances.filter((i) => a.nodes.find((n) => n.itemId === i.itemId)!.step === 1);
  expect([...poses.keys()].sort()).toEqual(fresh.map((i) => i.key).sort());
  const ground = a.bounds!.max[1];
  const boxes = fresh.map((i) => transformBox(metrics(i.part).body, poses.get(i.key)!));
  for (const b of boxes) {
    expect(b.max[1]).toBeCloseTo(ground, 3); // resting on the floor
    expect(b.max[2]).toBeLessThan(a.bounds!.min[2]); // in front of (not inside) the model
  }
  const [p, q] = boxes;
  const apart = [0, 2].some((k) => Math.min(p.max[k], q.max[k]) - Math.max(p.min[k], q.min[k]) <= 0);
  expect(apart).toBe(true);
});

test('exploded lifts the new parts straight up; assembled moves nothing', () => {
  const a = asm();
  const poses = stepPoses(a, 1, 'exploded');
  for (const [key, m] of poses) {
    const inst = a.instances.find((i) => i.key === key)!;
    expect(m.elements[12]).toBeCloseTo(inst.world.elements[12]);
    expect(m.elements[13]).toBeLessThan(inst.world.elements[13]); // LDraw −Y is up
  }
  expect(stepPoses(a, 1, 'assembled').size).toBe(0);
  expect(stepPoses(a, 0, 'separated').size).toBe(2);
});

test('the Build view lays a step out where the planned animation starts it', () => {
  const a = asm();
  const tl = buildTimeline(a, metrics, { targetSeconds: 15, heroOrbit: true });
  const s = timelineStep(a, 1, tl)!;
  expect(s).not.toBeNull();
  const fresh = a.instances.filter((i) => a.nodes.find((n) => n.itemId === i.itemId)!.step === 1);
  expect([...s.poses.keys()].sort()).toEqual(fresh.map((i) => i.key).sort());
  // waits away from its spot, and the build ends with it exactly in place
  const end = poseAt(tl, tl.duration);
  for (const i of fresh) {
    expect(s.poses.get(i.key)!.equals(i.world)).toBe(false);
    end(i.key)!.elements.forEach((v, k) => expect(v).toBeCloseTo(i.world.elements[k], 3));
  }
  // waiting parts rest on the floor (not mid-drop in the air)
  for (const i of fresh) expect(transformBox(metrics(i.part).body, s.poses.get(i.key)!).max[1]).toBeCloseTo(tl.ground, 3);
  // a timeline of another model (stale after an edit) is not used
  const other = assemble(ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [brick(0, 0, 0)] }, { pieces: [brick(8, 3, 0)] }] }), metrics, fixtureColors);
  expect(timelineStep(a, 1, buildTimeline(other, metrics, { targetSeconds: 15, heroOrbit: true }))).toBeNull();
});
