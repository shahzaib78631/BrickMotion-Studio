import { beforeAll, expect, test } from 'vitest';
import * as THREE from 'three';
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
    ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [brick(0, 0, 0), brick(4, 0, 0)] }, { pieces: [brick(0, 3, 0), brick(4, 3, 0)] }] }),
    metrics,
    fixtureColors,
  );

test('separated: the step\'s new parts lie on the floor in front of the model, apart from it and each other', () => {
  const a = asm();
  const poses = stepPoses(a, 1, 'separated', metrics);
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
  const poses = stepPoses(a, 1, 'exploded', metrics);
  for (const [key, m] of poses) {
    const inst = a.instances.find((i) => i.key === key)!;
    expect(m.elements[12]).toBeCloseTo(inst.world.elements[12]);
    expect(m.elements[13]).toBeLessThan(inst.world.elements[13]); // LDraw −Y is up
  }
  expect(stepPoses(a, 1, 'assembled', metrics).size).toBe(0);
  expect(stepPoses(a, 0, 'separated', metrics).size).toBe(2);
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

test('laid out: every piece of the step, submodels taken apart, on the floor in front, none overlapping, by colour', () => {
  const piece = (part: string, color: number, x: number, y: number, z: number): PlanItem => ({ part, color, x, y, z, rot: 0 });
  // a submodel of six stacked pieces (they overlap in plan view where they stand)
  const a = assemble(
    ensureIds({
      format: 'brickmotion-plan', version: 1, name: 't',
      submodels: { tower: { steps: [{ pieces: [piece('3001', 4, 0, 0, 0), piece('3020', 1, 0, 3, 0), piece('3001', 4, 0, 4, 0), piece('3020', 1, 0, 7, 0), piece('3001', 4, 0, 8, 0), piece('3020', 1, 0, 11, 0)] }] } },
      steps: [{ pieces: [brick(0, 0, 0)] }, { pieces: [{ submodel: 'tower', ldu: [200, -24, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, brick(8, 0, 0)] }],
    }),
    metrics,
    fixtureColors,
  );
  const poses = stepPoses(a, 1, 'laidout', metrics);
  const fresh = a.instances.filter((i) => a.nodes.find((n) => n.itemId === i.key.split('/')[0])!.step === 1);
  expect(fresh).toHaveLength(7);
  expect([...poses.keys()].sort()).toEqual(fresh.map((i) => i.key).sort());
  const ground = a.bounds!.max[1];
  const boxes = fresh.map((i) => transformBox(metrics(i.part).body, poses.get(i.key)!));
  for (const b of boxes) {
    expect(b.max[1]).toBeCloseTo(ground, 3);
    expect(b.max[2]).toBeLessThan(a.bounds!.min[2]);
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const p = boxes[i], q = boxes[j];
      const apart = [0, 2].some((k) => Math.min(p.max[k], q.max[k]) - Math.max(p.min[k], q.min[k]) <= 0);
      expect(apart).toBe(true);
    }
  // one colour after the other: walking the rows, the colour changes once
  const order = fresh
    .map((i, k) => ({ c: i.color, z: -boxes[k].max[2], x: boxes[k].min[0] }))
    .sort((p, q) => p.z - q.z || p.x - q.x)
    .map((e) => e.c);
  expect(order.filter((c, i) => i > 0 && c !== order[i - 1]).length).toBe(1);
});

test('laid out, whole model: every piece of every step on the floor, none overlapping', () => {
  const a = asm();
  const poses = stepPoses(a, 'all', 'laidout', metrics);
  expect(poses.size).toBe(a.instances.length);
  const ground = a.bounds!.max[1];
  const boxes = a.instances.map((i) => transformBox(metrics(i.part).body, poses.get(i.key)!));
  for (const b of boxes) expect(b.max[1]).toBeCloseTo(ground, 3);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const p = boxes[i], q = boxes[j];
      expect([0, 2].some((k) => Math.min(p.max[k], q.max[k]) - Math.max(p.min[k], q.min[k]) <= 0)).toBe(true);
    }
});

test('laid out: a piece that is turned in the model is staged flat on the floor', () => {
  const straight: PlanItem = { part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 };
  const turned: PlanItem = { part: '3001', color: 4, x: 4, y: 0, z: 0, rot: 90 };
  const a = assemble(
    ensureIds({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [straight, turned] }] }),
    metrics,
    fixtureColors,
  );
  const poses = stepPoses(a, 'all', 'laidout', metrics);
  const ground = a.bounds!.max[1];
  const upright = new THREE.Matrix4().extractRotation(new THREE.Matrix4()); // identity
  for (const inst of a.instances) {
    const pose = poses.get(inst.key)!;
    // staged in the orientation the part is drawn in, whatever pose it has in the model
    expect(new THREE.Matrix4().extractRotation(pose).equals(upright)).toBe(true);
    // resting on its own body, not on the AABB of a tilted one
    expect(transformBox(metrics(inst.part).body, pose).max[1]).toBeCloseTo(ground, 3);
  }
  // the turned piece really is turned in the model, so flat staging changed it
  const turnedInst = a.instances.find((i) => !new THREE.Matrix4().extractRotation(i.world).equals(upright))!;
  expect(turnedInst).toBeDefined();
  expect(new THREE.Matrix4().extractRotation(poses.get(turnedInst.key)!).equals(upright)).toBe(true);
});
