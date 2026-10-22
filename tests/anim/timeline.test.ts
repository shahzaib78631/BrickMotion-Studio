import * as THREE from 'three';
import { beforeAll, expect, test } from 'vitest';
import { assemble, transformBox, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import type { Plan, PlanItem } from '../../src/plan/types';
import { buildTimeline, poseAt } from '../../src/anim/timeline';
import { cameraAt } from '../../src/anim/camera';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

let metrics: Metrics;
beforeAll(async () => {
  metrics = await fixtureMetrics();
});

const plan = (steps: PlanItem[][], submodels?: Record<string, PlanItem[][]>): Plan =>
  ensureIds({
    format: 'brickmotion-plan',
    version: 1,
    name: 't',
    steps: steps.map((pieces) => ({ pieces })),
    submodels: submodels && Object.fromEntries(Object.entries(submodels).map(([k, v]) => [k, { steps: v.map((pieces) => ({ pieces })) }])),
  });
const opts = { targetSeconds: 15, heroOrbit: true };
const brick = (x: number, y: number, z: number): PlanItem => ({ part: '3001', color: 4, x, y, z, rot: 0 });

const expectMatClose = (a: THREE.Matrix4, b: THREE.Matrix4, eps = 1e-3) =>
  a.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], -Math.log10(eps)));

test('3-piece model: floor at t=0, final at the end, 15 s', () => {
  const asm = assemble(plan([[brick(0, 0, 0)], [brick(0, 3, 0)], [brick(0, 6, 0)]]), metrics, fixtureColors);
  const tl = buildTimeline(asm, metrics, opts);
  expect(Math.abs(tl.duration - 15)).toBeLessThanOrEqual(0.05);
  expect(tl.pacing.mode).toBe('piece');
  const ground = Math.max(...asm.instances.map((i) => i.worldBox.max[1]));
  const fp = asm.bounds!;
  const at0 = poseAt(tl, 0);
  for (const inst of asm.instances) {
    const m = at0(inst.key);
    expect(m).not.toBeNull();
    const b = transformBox(metrics(inst.part).body, m!);
    expect(Math.abs(b.max[1] - ground)).toBeLessThanOrEqual(0.5);
    const overlapsFootprint = b.min[0] < fp.max[0] && b.max[0] > fp.min[0] && b.min[2] < fp.max[2] && b.max[2] > fp.min[2];
    expect(overlapsFootprint).toBe(false);
  }
  const atEnd = poseAt(tl, tl.duration);
  for (const inst of asm.instances) expectMatClose(atEnd(inst.key)!, inst.world);
  const starts = tl.units.map((u) => u.start);
  for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1]);
  // flights never spill into the outro
  const buildEnd = tl.duration - tl.pacing.outro;
  for (const u of tl.units) expect(u.start + u.dur).toBeLessThanOrEqual(buildEnd + 1e-6);
});

test('submodel is built at the side spot, then attached', () => {
  const asm = assemble(
    plan([[{ submodel: 'engine', x: 0, y: 3, z: 0, rot: 90 }, brick(0, 0, 0)]], {
      engine: [[{ part: '3020', color: 72, x: 0, y: 0, z: 0, rot: 0 }], [brick(0, 1, 0)]],
    }),
    metrics,
    fixtureColors,
  );
  const tl = buildTimeline(asm, metrics, opts);
  expect(tl.subBuilds).toHaveLength(1);
  const sb = tl.subBuilds[0];
  const eng = asm.instances.filter((i) => i.model === 'engine');
  expect(eng).toHaveLength(2);
  const before = poseAt(tl, sb.attachStart - 1e-3);
  const [a, b] = eng.map((i) => before(i.key)!);
  const rel = a.clone().invert().multiply(b);
  const relFinal = eng[0].world.clone().invert().multiply(eng[1].world);
  expectMatClose(rel, relFinal);
  // side spot is to the right (+X) of the model
  const ab = transformBox(metrics('3020').body, a);
  expect(ab.min[0]).toBeGreaterThan(asm.bounds!.max[0]);
  const end = poseAt(tl, tl.duration);
  for (const i of eng) expectMatClose(end(i.key)!, i.world);
});

test('empty model lasts intro + outro', () => {
  const tl = buildTimeline(assemble(plan([[]]), metrics, fixtureColors), metrics, opts);
  expect(tl.duration).toBeCloseTo(4.0, 5);
});

test('400 pieces still fit the target', () => {
  const steps: PlanItem[][] = [];
  for (let s = 0; s < 40; s++) steps.push(Array.from({ length: 10 }, (_, i) => brick((i % 5) * 4, s * 3, Math.floor(i / 5) * 2)));
  const asm = assemble(plan(steps), metrics, fixtureColors);
  const tl = buildTimeline(asm, metrics, opts);
  expect(tl.duration).toBeLessThanOrEqual(15.05);
  const end = poseAt(tl, tl.duration);
  for (const inst of asm.instances.slice(0, 20)) expectMatClose(end(inst.key)!, inst.world);
  // later-window pieces are hidden at t=0 when the floor overflows, never stacked on top of each other
  const at0 = poseAt(tl, 0);
  const visible = asm.instances.filter((i) => at0(i.key));
  expect(visible.length).toBeGreaterThan(0);
});

test('camera pose is finite throughout', () => {
  const asm = assemble(plan([[brick(0, 0, 0)], [brick(0, 3, 0)]]), metrics, fixtureColors);
  const tl = buildTimeline(asm, metrics, opts);
  for (let t = 0; t <= tl.duration; t += 0.25) {
    const c = cameraAt(tl, t, 9 / 16);
    expect(Number.isFinite(c.position.x + c.position.y + c.position.z)).toBe(true);
    expect(c.fov).toBe(30);
  }
});

test('a small model shows every piece on the floor at t=0', () => {
  const asm = assemble(
    plan([
      [brick(0, 0, 0), brick(4, 0, 0)],
      [brick(0, 3, 0), brick(4, 3, 0)],
      [brick(0, 6, 0), brick(4, 6, 0)],
      [brick(2, 9, 0)],
    ]),
    metrics,
    fixtureColors,
  );
  const tl = buildTimeline(asm, metrics, opts);
  const at0 = poseAt(tl, 0);
  expect(asm.instances.filter((i) => !at0(i.key)).map((i) => i.key)).toEqual([]);
});
