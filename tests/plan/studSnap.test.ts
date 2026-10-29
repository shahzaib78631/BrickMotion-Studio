import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { socketsOf, studSnapper, type SnapPart } from '../../src/plan/studSnap';
import { moveItems } from '../../src/plan/ops';
import { gridToPlacement } from '../../src/plan/placement';
import type { Plan } from '../../src/plan/types';

const root = join(__dirname, '..', '..', 'public', 'ldraw');
const ready = existsSync(join(root, 'parts', '3794b.dat'));
const lib = new PartLibrary(async (p) => {
  const f = join(root, p);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
});
const measure = async (id: string): Promise<PartMetrics> => measurePart(await lib.loadPart(id), id);
/** A part placed upright at an LDraw position. */
const at = (m: PartMetrics, x: number, y: number, z: number): SnapPart => ({
  world: new THREE.Matrix4().makeTranslation(x, y, z).elements, body: m.body, studs: m.studs,
});

describe('half-stud snapping', () => {
  it('finds one socket per stud cell of a standard footprint', () => {
    expect(socketsOf({ min: [-20, 0, -10], max: [20, 8, 10] })).toEqual([[-10, 8, 0], [10, 8, 0]]);
    expect(socketsOf({ min: [-10, 0, -10], max: [10, 8, 10] })).toEqual([[0, 8, 0]]);
    expect(socketsOf({ min: [-7, 0, -7], max: [7, 8, 7] })).toEqual([]);
  });

  it.skipIf(!ready)('seats a 1x1 round plate on the centre stud of a 1x2 jumper', async () => {
    const jumper = await measure('3794b');
    const round = await measure('4073');
    // the jumper sits with its top at y = 0; its single stud is at its centre
    const base = at(jumper, 0, -jumper.body.min[1], 0);
    // the round plate rests on top, one stud cell off-grid from the centre stud
    const plate = at(round, -10, -round.body.max[1], 0);
    const snap = studSnapper([plate], [base]);
    // a drag of about half a stud lands on the stud, not on the whole-stud spot beside it
    expect(snap({ x: 0.4, z: 0.1 })).toEqual({ x: 0.5, y: 0, z: 0 });
    expect(snap({ x: 0.6, z: -0.2 })).toEqual({ x: 0.5, y: 0, z: 0 });
    // far from the stud the drag stays in whole studs
    expect(snap({ x: 2.3, z: 1.2 })).toEqual({ x: 2, y: 0, z: 1 });
  });

  it.skipIf(!ready)('keeps ordinary plates on whole studs', async () => {
    const plate = await measure('3023');
    const below = at(plate, 0, -plate.body.min[1], 0);
    const above = at(plate, 0, -plate.body.max[1], 40);
    const snap = studSnapper([above], [below]);
    expect(snap({ x: 0.4, z: 1.8 })).toEqual({ x: 0, y: 0, z: 2 });
  });

  it('turns a grid piece into an exact placement for a half-stud move', () => {
    const body = { min: [-10, 0, -10], max: [10, 8, 10] } as const;
    const plan: Plan = { steps: [{ pieces: [{ id: 'a', part: '4073', color: 1, x: 2, y: 1, z: 3, rot: 0 }] }] } as Plan;
    const before = gridToPlacement({ x: 2, y: 1, z: 3, rot: 0 }, { min: [...body.min], max: [...body.max] });
    const moved = moveItems(plan, '', ['a'], { x: 0.5, y: 0, z: 0 }, () => ({ min: [...body.min], max: [...body.max] }));
    const piece = moved.steps[0].pieces[0] as { ldu: number[]; matrix: number[]; x?: number };
    expect(piece.x).toBeUndefined();
    expect(piece.ldu).toEqual([before.pos[0] + 10, before.pos[1], before.pos[2]]);
    expect(piece.matrix).toEqual(before.m);
    // whole-stud moves keep the grid form
    const whole = moveItems(plan, '', ['a'], { x: 1, y: 0, z: 0 }, () => undefined).steps[0].pieces[0] as { x: number };
    expect(whole.x).toBe(3);
  });
});

describe('the user-reported jumper set', () => {
  it.skipIf(!ready)('seats the sunken round plate on the jumper stud, fixing its height too', async () => {
    const jumper = await measure('15573');
    const round = await measure('6141');
    // from "Untitled set (1).mpd": 15573 at (20, -56, -90), 6141 at (10, -59, -70)
    const base = at(jumper, 20, -56, -90);
    const plate = at(round, 10, -59, -70);
    const snap = studSnapper([plate], [base]);
    // the stud is +0.5 stud in x and -1 stud in z away
    const d = snap({ x: 0.45, z: -0.9 });
    expect(d.x).toBe(0.5);
    expect(d.z).toBe(-1);
    // the plate's underside rises to the stud base (y = -56 - jumper top)
    const socketY = -59 + round.body.max[1] - d.y * 8;
    expect(socketY).toBeCloseTo(-56 + jumper.body.min[1]);
  });
});

describe('covered studs', () => {
  it.skipIf(!ready)('ignores a stud hidden inside the jumper above it', async () => {
    const jumper = await measure('15573');
    const brick = await measure('3005');
    const round = await measure('6141');
    // from the user's file: the 1x1 brick's stud at x=30 is inside the jumper
    const snap = studSnapper([at(round, 10, -59, -70)], [at(jumper, 20, -56, -90), at(brick, 30, -48, -90)]);
    expect(snap({ x: 0.9, z: -1.1 })).toEqual({ x: 0.5, y: 0.625, z: -1 });
  });
});
