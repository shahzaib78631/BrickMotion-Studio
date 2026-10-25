import * as THREE from 'three';
import { beforeAll, expect, test } from 'vitest';
import { assemble, transformBox, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import type { Plan, PlanItem } from '../../src/plan/types';
import { buildTimeline, poseAt } from '../../src/anim/timeline';
import { cameraAt, cameraFov, DEFAULT_CAMERA_SETTINGS } from '../../src/anim/camera';
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

const expectMatClose = (a: THREE.Matrix4, b: THREE.Matrix4, eps = 1e-3) => a.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], -Math.log10(eps)));

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

test('400 pieces retain safe dependencies even when the target must be exceeded', () => {
  const steps: PlanItem[][] = [];
  for (let s = 0; s < 40; s++) steps.push(Array.from({ length: 10 }, (_, i) => brick((i % 5) * 4, s * 3, Math.floor(i / 5) * 2)));
  const asm = assemble(plan(steps), metrics, fixtureColors);
  const tl = buildTimeline(asm, metrics, opts);
  expect(Number.isFinite(tl.duration)).toBe(true);
  expect(tl.duration).toBeGreaterThanOrEqual(opts.targetSeconds);
  for (const unit of tl.units) for (const parent of unit.dependsOn ?? []) {
    const dependency = tl.units[parent];
    expect(unit.start).toBeGreaterThanOrEqual(dependency.start + dependency.dur + 0.02999);
  }
  expect(tl.units.filter((u) => u.hidden)).toHaveLength(0); // no popping/disappearing pieces
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
    expect(c.fov).toBe(cameraFov(DEFAULT_CAMERA_SETTINGS, 9 / 16));
  }
});

test('a small model shows every piece on the floor at t=0', () => {
  const asm = assemble(
    plan([[brick(0, 0, 0), brick(4, 0, 0)], [brick(0, 3, 0), brick(4, 3, 0)], [brick(0, 6, 0), brick(4, 6, 0)], [brick(2, 9, 0)]]),
    metrics,
    fixtureColors,
  );
  const tl = buildTimeline(asm, metrics, opts);
  const at0 = poseAt(tl, 0);
  expect(asm.instances.filter((i) => !at0(i.key)).map((i) => i.key)).toEqual([]);
});

const twinTowers = () => {
  const steps: PlanItem[][] = [];
  for (let s = 0; s < 8; s++) steps.push([brick(0, s * 3, 0), brick(6, s * 3, 0)]);
  return assemble(plan(steps), metrics, fixtureColors);
};

const ndcExtent = (tl: ReturnType<typeof buildTimeline>, asm: ReturnType<typeof assemble>, t: number, only?: (key: string, m: THREE.Matrix4) => boolean) => {
  const pose = poseAt(tl, t);
  const c = cameraAt(tl, t, 9 / 16);
  const cam = new THREE.PerspectiveCamera(c.fov, 9 / 16, 0.1, 5000);
  cam.position.copy(c.position);
  cam.lookAt(c.target);
  cam.updateMatrixWorld();
  let max = 0;
  let width = 0;
  const xs: number[] = [];
  for (const i of asm.instances) {
    const m = pose(i.key);
    if (!m || (only && !only(i.key, m))) continue;
    const b = transformBox(metrics(i.part).body, m);
    for (const x of [b.min[0], b.max[0]])
      for (const y of [b.min[1], b.max[1]])
        for (const z of [b.min[2], b.max[2]]) {
          const p = new THREE.Vector3(x / 20, -y / 20, -z / 20).project(cam);
          max = Math.max(max, Math.abs(p.x), Math.abs(p.y));
          xs.push(p.x);
        }
  }
  width = Math.max(...xs) - Math.min(...xs);
  return { max, width, dist: c.position.distanceTo(c.target) };
};

/** Every piece is in the shot at the moment it lands, wherever it is being assembled. */
const expectLandingsInFrame = (tl: ReturnType<typeof buildTimeline>, asm: ReturnType<typeof assemble>) => {
  for (const u of tl.units) {
    const t = u.start + u.dur + 0.02;
    const keys = new Set(u.keys);
    expect(ndcExtent(tl, asm, t, (key) => keys.has(key) || [...keys].some((k) => key.startsWith(`${k}/`))).max, `${u.keys.join(',')} at t=${t.toFixed(2)}`).toBeLessThanOrEqual(1.0001);
  }
};

test('every piece is inside the 9:16 frame when it lands, and the built model stays in frame', () => {
  const asm = twinTowers();
  const tl = buildTimeline(asm, metrics, opts);
  expectLandingsInFrame(tl, asm);
  for (let t = 0; t <= tl.duration; t += 0.1) expect(ndcExtent(tl, asm, t, (key, m) => m.equals(tl.tracks.get(key)!.final)).max).toBeLessThanOrEqual(1.0001);
});

test('the camera frames the model being built, not the floor, and the model fills the frame at the end of the build', () => {
  const asm = twinTowers();
  const tl = buildTimeline(asm, metrics, opts);
  const start = ndcExtent(tl, asm, tl.intro);
  const end = ndcExtent(tl, asm, tl.buildEnd - 0.05);
  expect(start.dist).toBeLessThanOrEqual(end.dist * 1.001);
  expect(start.max).toBeGreaterThan(1); // floor pieces may lie outside the shot
  expect(end.width).toBeGreaterThan(0.6);
});

const hangar = () =>
  assemble(
    plan(
      [
        [brick(0, 0, 0), brick(4, 0, 0), brick(8, 0, 0)],
        [
          { submodel: 'engine', x: 0, y: 3, z: 0, rot: 0 },
          { submodel: 'engine', x: 4, y: 3, z: 0, rot: 0 },
          { submodel: 'engine', x: 8, y: 3, z: 0, rot: 0 },
        ],
        [brick(0, 7, 0), brick(8, 7, 0)],
      ],
      { engine: [[{ part: '3020', color: 72, x: 0, y: 0, z: 0, rot: 0 }], [brick(0, 1, 0)]] },
    ),
    metrics,
    fixtureColors,
  );

test('sibling submodels each attach before the next one is built at the side spot', () => {
  const tl = buildTimeline(hangar(), metrics, opts);
  const subs = [...tl.subBuilds].sort((a, b) => a.start - b.start);
  expect(subs).toHaveLength(3);
  for (let i = 1; i < subs.length; i++) expect(subs[i].start).toBeGreaterThanOrEqual(subs[i - 1].attachEnd - 1e-6);
});

test('with submodels, every piece is in frame where it lands: at the side spot or on the model', () => {
  const asm = hangar();
  const tl = buildTimeline(asm, metrics, opts);
  expectLandingsInFrame(tl, asm);
});

test('while a submodel is built the camera stays on it', () => {
  const asm = hangar();
  const tl = buildTimeline(asm, metrics, opts);
  for (const sb of tl.subBuilds)
    for (let t = sb.start + 0.9; t < sb.attachStart; t += 0.05) {
      const landed = new Set(tl.units.filter((u) => u.kind === 'piece' && u.start + u.dur <= t).flatMap((u) => u.keys));
      const built = (key: string) => key.startsWith(`${sb.key}/`) && landed.has(key);
      expect(ndcExtent(tl, asm, t, built).max, `${sb.key} t=${t.toFixed(2)}`).toBeLessThanOrEqual(1.0001);
    }
});

test('the camera zooms in and out once per submodel build, not for every piece', () => {
  const asm = hangar();
  const tl = buildTimeline(asm, metrics, opts);
  let reversals = 0;
  let dir = 0;
  let last = 0;
  for (let t = 0; t <= tl.buildEnd; t += 1 / 30) {
    const d = ndcExtent(tl, asm, t).dist;
    const nd = last ? (d > last * 1.002 ? 1 : d < last / 1.002 ? -1 : 0) : 0;
    if (nd && dir && nd !== dir) reversals++;
    if (nd) dir = nd;
    last = d;
  }
  expect(reversals).toBeLessThanOrEqual(2 * tl.subBuilds.length + 2);
});

test('a long chain of submodels makes the video longer instead of rushing the flights', () => {
  const tl = buildTimeline(hangar(), metrics, { targetSeconds: 5, heroOrbit: true });
  expect(tl.duration).toBeGreaterThan(5.05);
  for (const u of tl.units) {
    expect(u.dur).toBeCloseTo(tl.pacing.flight, 6);
    expect(u.start + u.dur).toBeLessThanOrEqual(tl.buildEnd + 1e-6); // nothing flies during the hero orbit
  }
  expect(tl.duration - tl.buildEnd).toBeCloseTo(tl.pacing.outro, 6);
});

test('pieces lying on the floor never overlap, even for several copies of one submodel', () => {
  const asm = hangar();
  const tl = buildTimeline(asm, metrics, opts);
  const overlap = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) =>
    [0, 1, 2].every((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) > 2);
  for (let t = 0; t <= tl.duration; t += 0.1) {
    const pose = poseAt(tl, t);
    const resting = asm.instances.flatMap((i) => {
      const m = pose(i.key);
      const tr = tl.tracks.get(i.key);
      return m && tr && m.equals(tr.floor) ? [{ key: i.key, box: transformBox(metrics(i.part).body, m) }] : [];
    });
    for (let a = 0; a < resting.length; a++)
      for (let b = a + 1; b < resting.length; b++)
        expect(overlap(resting[a].box, resting[b].box), `${resting[a].key} / ${resting[b].key} at t=${t.toFixed(1)}`).toBe(false);
  }
});

test('the timeline lists when each step and each submodel build plays', () => {
  const tl = buildTimeline(hangar(), metrics, opts);
  const main = tl.steps.filter((s) => s.model === '');
  expect([...new Set(main.map((s) => s.index))]).toEqual([0, 1, 2]);
  expect(tl.steps.filter((s) => s.model === 'engine').map((s) => s.index)).toEqual([0, 1, 0, 1, 0, 1]);
  for (const s of tl.steps) expect(s.end).toBeGreaterThan(s.start);
  for (let i = 1; i < tl.steps.length; i++) expect(tl.steps[i].start).toBeGreaterThanOrEqual(tl.steps[i - 1].start - 1e-6);
  expect(tl.subBuilds.map((b) => b.name)).toEqual(['engine', 'engine', 'engine']);
});

const camDist = (tl: ReturnType<typeof buildTimeline>, t: number) => {
  const c = cameraAt(tl, t, 9 / 16);
  return c.position.distanceTo(c.target);
};
const minDist = (tl: ReturnType<typeof buildTimeline>, a: number, b: number) => {
  let m = Infinity;
  for (let t = a; t <= b; t += 1 / 30) m = Math.min(m, camDist(tl, t));
  return m;
};

const firstBuild = (tl: ReturnType<typeof buildTimeline>) => [...tl.subBuilds].sort((a, b) => a.start - b.start)[0];

test('the camera moves in close while a submodel is first built', () => {
  const tl = buildTimeline(hangar(), metrics, opts);
  const sb = firstBuild(tl);
  expect(minDist(tl, sb.start, sb.attachStart)).toBeLessThan(camDist(tl, sb.start - 1) * 0.8);
});

test('the camera does not leave a submodel before its last piece has landed', () => {
  const tl = buildTimeline(hangar(), metrics, opts);
  const sb = firstBuild(tl);
  const last = Math.max(...tl.units.filter((u) => u.kind === 'piece' && u.keys.every((k) => k.startsWith(`${sb.key}/`))).map((u) => u.start + u.dur));
  expect(camDist(tl, last)).toBeLessThan(camDist(tl, sb.start - 1) * 0.9);
});

test('the camera holds still through a close-up until its last piece has landed', () => {
  // a submodel of three pieces built fast, like the undersides of an imported car
  const tl = buildTimeline(hangar(), metrics, { ...opts, targetSeconds: 8 });
  for (const sb of tl.subBuilds.filter((b) => b.closeUp)) {
    const own = tl.units.filter((u) => u.kind === 'piece' && u.keys.every((k) => k.startsWith(`${sb.key}/`)));
    if (!own.length) continue;
    const first = Math.min(...own.map((u) => u.start)), last = Math.max(...own.map((u) => u.start + u.dur));
    const ref = cameraAt(tl, first, 9 / 16);
    const d0 = ref.position.distanceTo(ref.target);
    for (let t = first; t <= last + 1e-9; t += 1 / 30) {
      const c = cameraAt(tl, t, 9 / 16);
      expect(c.target.distanceTo(ref.target)).toBeLessThan(d0 * 0.01);
      expect(Math.abs(c.position.distanceTo(c.target) - d0)).toBeLessThan(d0 * 0.02);
    }
  }
});

test('only the first build of each top-level submodel gets a close-up', () => {
  const tl = buildTimeline(hangar(), metrics, opts);
  expect([...tl.subBuilds].sort((a, b) => a.start - b.start).map((b) => b.closeUp)).toEqual([true, false, false]);
});

test('a close-up waits until earlier flights have landed and the camera has moved in', () => {
  const tl = buildTimeline(hangar(), metrics, opts);
  for (const sb of tl.subBuilds.filter((b) => b.closeUp)) {
    const before = tl.units.filter((u) => u.start < sb.start - 1e-9);
    for (const u of before) expect(u.start + u.dur).toBeLessThanOrEqual(sb.start - 0.6 + 1e-6);
  }
});


/** Checks motion, not just resting poses, at a 120 FPS export cadence. */
const assertNoIntersections = (tl: ReturnType<typeof buildTimeline>, asm: ReturnType<typeof assemble>, rate = 120) => {
  const instances = asm.instances;
  const overlaps = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) =>
    [0, 1, 2].every((axis) => Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]) > 2);
  for (let f = 0; f <= Math.ceil(tl.buildEnd * rate); f++) {
    const t = f / rate;
    const pose = poseAt(tl, t);
    const visible = instances.flatMap((inst) => {
      const m = pose(inst.key);
      return m ? [{ key: inst.key, box: transformBox(metrics(inst.part).body, m) }] : [];
    });
    for (let i = 0; i < visible.length; i++)
      for (let j = i + 1; j < visible.length; j++)
        expect(overlaps(visible[i].box, visible[j].box), `${visible[i].key} vs ${visible[j].key} at ${t.toFixed(4)}s`).toBe(false);
  }
};

test('pieces do not pass through each other while flying in batches', () => {
  const asm = assemble(
    plan([
      [brick(0, 0, 0), brick(6, 0, 0), brick(12, 0, 0)],
      [brick(0, 3, 0), brick(6, 3, 0), brick(12, 3, 0)],
      [brick(0, 6, 0), brick(6, 6, 0), brick(12, 6, 0)],
    ]), metrics, fixtureColors,
  );
  const tl = buildTimeline(asm, metrics, { targetSeconds: 8, heroOrbit: true, mode: 'batch' });
  assertNoIntersections(tl, asm);
});

test('repeated side staging areas clear before the next submodel appears', () => {
  const asm = hangar();
  const tl = buildTimeline(asm, metrics, opts);
  const subs = [...tl.subBuilds].sort((a, b) => a.start - b.start);
  for (let i = 1; i < subs.length; i++) {
    const nextPieces = [...tl.tracks.entries()].filter(([key]) => key.startsWith(`${subs[i].key}/`));
    for (const [, tr] of nextPieces) expect(tr.appear).toBeGreaterThanOrEqual(subs[i - 1].attachEnd - 1e-6);
  }
  assertNoIntersections(tl, asm);
});

test('camera has no jump at a framing key in the MP4 sequence', () => {
  const asm = twinTowers();
  const tl = buildTimeline(asm, metrics, opts);
  for (let t = 1; t < tl.buildEnd - 1; t += 0.2) {
    const h = 1 / 120;
    const before = cameraAt(tl, t - h, 9 / 16).position;
    const mid = cameraAt(tl, t, 9 / 16).position;
    const after = cameraAt(tl, t + h, 9 / 16).position;
    // The speed either side of a camera key should change gradually, not snap.
    expect(before.clone().add(after).addScaledVector(mid, -2).length()).toBeLessThan(0.5);
  }
});

test('within a step a piece flies in after the piece it rests on, and a blocked file order is repaired', () => {
  // the top brick is listed first
  const asm = assemble(plan([[brick(0, 3, 0), brick(0, 0, 0)]]), metrics, fixtureColors);
  const [top, bottom] = asm.instances;
  expect(top.worldBox.max[1]).toBeLessThan(bottom.worldBox.max[1]);
  const firstFlight = (tl: ReturnType<typeof buildTimeline>, key: string) => tl.units[tl.tracks.get(key)!.moves[0].unit].start;
  const tl = buildTimeline(asm, metrics, opts);
  expect(firstFlight(tl, bottom.key)).toBeLessThan(firstFlight(tl, top.key));
  // Bottom-up off keeps the editorial order and does not infer support...
  const asListed = buildTimeline(asm, metrics, { ...opts, bottomUp: false, accessSearchAttempts: 0, accessSearchWork: 0 });
  expect(firstFlight(asListed, top.key)).toBeLessThan(firstFlight(asListed, bottom.key));
  // ...but this stack cannot be entered without passing through the brick below,
  // so the access search repairs the order instead of shipping an uncertified flight.
  const repaired = buildTimeline(asm, metrics, { ...opts, bottomUp: false });
  expect(firstFlight(repaired, bottom.key)).toBeLessThan(firstFlight(repaired, top.key));
  expect(repaired.units.every((u) => !u.uncertified)).toBe(true);
});

test('one by one: only one piece is ever in the air, even when that outruns the target length', () => {
  // 40 bricks side by side would need ~0.3 s each in 12 s; one-at-a-time flights take longer
  const row = Array.from({ length: 40 }, (_, i) => brick((i % 8) * 4, 0, Math.floor(i / 8) * 2));
  const asm = assemble(plan([row]), metrics, fixtureColors);
  const tl = buildTimeline(asm, metrics, { targetSeconds: 15, heroOrbit: true, mode: 'piece' });
  expect(tl.pacing.sequential).toBe(true);
  const flights = [...tl.units].sort((a, b) => a.start - b.start);
  for (let i = 1; i < flights.length; i++) expect(flights[i].start).toBeGreaterThanOrEqual(flights[i - 1].start + flights[i - 1].dur - 1e-6);
  expect(tl.duration).toBeGreaterThan(15);
  // Auto may overlap flights to keep to the requested length
  const auto = buildTimeline(asm, metrics, { targetSeconds: 15, heroOrbit: true });
  expect(auto.pacing.sequential).toBeFalsy();
});
