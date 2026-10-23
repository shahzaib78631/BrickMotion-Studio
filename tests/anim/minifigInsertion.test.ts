import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { buildTimeline, poseAt, slideAxis } from '../../src/anim/timeline';
import { importLDraw } from '../../src/io/ldrawImport';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { assemble, transformBox, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import { scopedPlan } from '../../src/state/useModel';
import type { Box } from '../../src/ldraw/flatten';
import * as THREE from 'three';
import { CLEAR, crossings, shapeOf, type Placed } from '../../src/anim/shapes';

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box => ({ min: [x0, y0, z0], max: [x1, y1, z1] });

test('a hand slides into the arm from the front; a stacked brick still goes on from above', () => {
  // real boxes of the 10001 minifig's right hand and arm (the hand sticks out in front, −z)
  expect(slideAxis(box(233, -121, 130, 247, -101, 161), [box(232, -133, 143, 256, -96, 175)])).toEqual([2, -1]);
  // an arm sticks out of the torso to the left (−x)
  expect(slideAxis(box(232, -133, 143, 256, -96, 175), [box(243, -140, 156, 281, -96, 176)])).toEqual([0, -1]);
  // a 2x4 brick on another, shifted by two studs, only grips by its studs
  expect(slideAxis(box(40, -48, 0, 120, -20, 40), [box(0, -24, 0, 80, 4, 40)])).toBeNull();
});

const root = join(__dirname, '..', '..', 'public', 'ldraw');
const set = join(__dirname, '..', '..', 'public', 'data', 'test-10001.mpd');
const hasLib = existsSync(join(root, 'parts', '3820.dat')) && existsSync(set);

test.skipIf(!hasLib)('every minifig piece goes on along a way its real shape allows', async () => {
  const plan = scopedPlan(ensureIds(importLDraw(readFileSync(set, 'utf8'), 'test-10001.mpd')), '10001 - minifig 2');
  const lib = new PartLibrary(async (name) => {
    for (const p of ['parts', 'p', '']) {
      const f = join(root, p, name);
      if (existsSync(f)) return readFileSync(f, 'utf8');
    }
    return null;
  });
  const map = new Map<string, PartMetrics>();
  for (const id of new Set(plan.steps.flatMap((s) => s.pieces.flatMap((p) => ('part' in p ? [p.part] : [])))))
    map.set(id, measurePart(await lib.loadPart(id), id));
  const metrics: Metrics = (id) => map.get(id)!;
  const asm = assemble(plan, metrics, new Map());
  const tl = buildTimeline(asm, metrics, { targetSeconds: 32, heroOrbit: true });
  for (const inst of asm.instances.filter((i) => ['3820', '3818', '3819'].includes(i.part))) {
    const unit = tl.units[tl.tracks.get(inst.key)!.moves[0].unit];
    // shortly before it lands, the piece is beside its spot, not above it
    const near = poseAt(tl, unit.start + unit.dur * 0.9)(inst.key)!.elements;
    const w = inst.world.elements;
    const off = [near[12] - w[12], near[13] - w[13], near[14] - w[14]];
    expect(Math.hypot(off[0], off[2]), `${inst.part} offset ${off.map((v) => v.toFixed(1))}`).toBeGreaterThan(Math.abs(off[1]));
  }
  // every piece's real final motion is one its shape can make without passing
  // through anything already built (checked on the actual part meshes)
  const scratch = { inv: new THREE.Matrix4(), rel: new THREE.Matrix4() };
  for (const inst of asm.instances) {
    const unit = tl.units[tl.tracks.get(inst.key)!.moves[0].unit];
    const end = unit.start + unit.dur;
    const before = poseAt(tl, end - unit.dur * 0.05)(inst.key)!.elements;
    const w = inst.world.elements;
    const d = [before[12] - w[12], before[13] - w[13], before[14] - w[14]];
    const len = Math.hypot(d[0], d[1], d[2]);
    expect(len, `${inst.part} still moving at the end`).toBeGreaterThan(0.01);
    const way = d.map((v) => v / len) as [number, number, number];
    const built = asm.instances.filter((o) => o !== inst && tl.units[tl.tracks.get(o.key)!.moves[0].unit].start + tl.units[tl.tracks.get(o.key)!.moves[0].unit].dur <= unit.start + 1e-6);
    const placed = (i: typeof inst): Placed => ({ shape: shapeOf(metrics(i.part).mesh!, metrics(i.part).meshTwoSidedFrom), world: i.world, box: transformBox(metrics(i.part).full, i.world) });
    const hits = crossings(placed(inst), built.map(placed), way, scratch);
    expect(hits, `${inst.part} comes in along ${way.map((v) => v.toFixed(2))} through a built piece`).toBeLessThanOrEqual(CLEAR);
  }
  // the torso, head and hair go on from above
  for (const inst of asm.instances.filter((i) => ['973p1d', '3626bp01', '3901'].includes(i.part))) {
    const unit = tl.units[tl.tracks.get(inst.key)!.moves[0].unit];
    const near = poseAt(tl, unit.start + unit.dur * 0.9)(inst.key)!.elements;
    const w = inst.world.elements;
    const off = [near[12] - w[12], near[13] - w[13], near[14] - w[14]];
    expect(-off[1], `${inst.part} offset ${off.map((v) => v.toFixed(1))}`).toBeGreaterThan(Math.hypot(off[0], off[2]));
  }
});
