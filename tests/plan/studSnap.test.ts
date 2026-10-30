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

describe('sideways parts on side studs (40859 Batman head)', () => {
  const shadowFile = join(__dirname, '..', '..', 'vendor', 'LDCadShadowLibrary', 'parts', '29120.dat');
  const sideReady = ready && existsSync(join(root, 'parts', '7302.dat')) && existsSync(shadowFile);
  /** A part placed at an LDraw position with an LDraw row-major rotation. */
  const placed = (m: PartMetrics, pos: number[], r: number[]): SnapPart => ({
    world: new THREE.Matrix4().set(r[0], r[1], r[2], pos[0], r[3], r[4], r[5], pos[1], r[6], r[7], r[8], pos[2], 0, 0, 0, 1).elements,
    body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh,
  });
  // studs point +X: the right side of the head
  const RIGHT = [0, -1, 0, 0, 0, 1, -1, 0, 0];
  const sideParts = async () => {
    const { shadowLookupFrom } = await import('../../src/ldraw/shadow');
    const meta = readFileSync(shadowFile, 'utf8').split(/\r?\n/).filter((l) => /SNAP_/i.test(l)).join('\n');
    const shadowLib = new PartLibrary(async (p) => {
      const f = join(root, p);
      return existsSync(f) ? readFileSync(f, 'utf8') : null;
    }, shadowLookupFrom({ '29120.dat': meta }));
    const load = async (id: string) => measurePart(await shadowLib.loadPart(id), id);
    // the 2x2 side plate: its top (stud bases) faces +X at x = 88, studs at y -134/-114, z 50/70
    const plate = placed(await load('3022'), [88, -124, 60], RIGHT);
    return { plate, slope: await load('7302'), ear: await load('29120') };
  };

  it.skipIf(!sideReady)('drags a 3x1 curved slope one stud in, onto the side plate', async () => {
    const { plate, slope } = await sideParts();
    // seated at x = 104; start one stud out, floating
    const snap = studSnapper([placed(slope, [124, -94, 70], RIGHT)], [plate]);
    expect(snap({ x: -0.9, z: 0.1 })).toEqual({ x: -1, y: 0, z: 0 });
  });

  it.skipIf(!sideReady)('pulls a sideways slope that floats part of a stud off the plate back onto it', async () => {
    const { plate, slope } = await sideParts();
    // 4 LDU too far out: a whole-stud grid can never reach x = 104
    const snap = studSnapper([placed(slope, [108, -94, 70], RIGHT)], [plate]);
    expect(snap({ x: 0.1, z: 0 })).toEqual({ x: -0.2, y: 0, z: 0 });
  });

  it.skipIf(!sideReady)('seats the cutout ear by its connector socket, a plate below its bottom face', async () => {
    const { plate, ear } = await sideParts();
    // the ear's socket is 8 LDU up inside it, so it seats with its origin at x = 80, not 88
    const snap = studSnapper([placed(ear, [88, -144, 50], RIGHT)], [plate]);
    expect(snap({ x: 0.2, z: 0 })).toEqual({ x: -0.4, y: 0, z: 0 });
    // dragged one stud in from there it would sink into the head; the seat wins instead
    expect(snap({ x: -0.7, z: 0 }).x).toBe(-0.4);
  });

  // the 3x1 slope with its thick end up (booklet step 24)
  const RIGHT_FLIPPED = [0, -1, 0, 0, 0, -1, 1, 0, 0];

  it.skipIf(!sideReady)('drops a sideways slope that sits between stud rows onto the nearest row', async () => {
    const { plate, slope } = await sideParts();
    // from the user's file: y = -118 is 4 LDU above the row that puts it on the plate's studs (-114 / -134)
    const snap = studSnapper([placed(slope, [104, -118, 70], RIGHT_FLIPPED)], [plate]);
    expect(snap.sideways).toBe(true);
    // half a plate down (plan y is plates, up positive)
    expect(snap({ x: 0, z: 0 })).toEqual({ x: 0, y: -0.5, z: 0 });
  });

  it.skipIf(!sideReady)('raises a sideways slope one stud row, not one plate', async () => {
    const { plate, slope } = await sideParts();
    const snap = studSnapper([placed(slope, [104, -94, 70], RIGHT_FLIPPED)], [plate]);
    // one stud up = 20 LDU = 2.5 plates, and it still lands on the plate studs
    expect(snap({ x: 0, z: 0, y: 1 })).toEqual({ x: 0, y: 2.5, z: 0 });
    // a gizmo drag of 1.3 studs is the same single row
    expect(snap({ x: 0, z: 0, y: 1.3 }).y).toBe(2.5);
  });

  it.skipIf(!sideReady)('seats a moving 1x1 plate whose stud goes up into the slope above it (arm cape, step 25)', async () => {
    const { slope } = await sideParts();
    const plate = await measure('3024');
    // the right-arm slope, thick end up, at x 96..112; its thick-end socket is at y -46
    const cape = placed(slope, [112, -26, 70], RIGHT_FLIPPED);
    // the 1x1 plate one stud too high and 4 LDU short of the thick end's socket
    const snap = studSnapper([placed(plate, [100, -66, 70], RIGHT)], [cape]);
    expect(snap.sideways).toBe(true);
    // seats at (104, -46): the thick-end socket is a plate above the slope's flat bottom (x 96),
    // so the stud base goes to x 104 — 4 LDU out (x +0.2 studs) — one stud row down (-2.5 plates)
    expect(snap({ x: 0, z: 0, y: -1 })).toEqual({ x: 0.2, y: -2.5, z: 0 });
  });

  it.skipIf(!sideReady)('pushes a 1x1 plate into the recess under the slope\'s thick end (user screenshot)', async () => {
    const { slope } = await sideParts();
    const plate = await measure('3024');
    // the slope's thick end is a one-plate tongue: its socket is a plate above the flat bottom (x = 88)
    const cape = placed(slope, [104, -26, 70], RIGHT_FLIPPED);
    // the plate lies against the flat bottom plane, so its stud stops a plate short of the tongue
    const snap = studSnapper([placed(plate, [88, -46, 70], RIGHT)], [cape]);
    expect(snap({ x: 0, z: 0 })).toEqual({ x: 0.4, y: 0, z: 0 });
  });

  it.skipIf(!sideReady)('a drag of about a stud toward the head lands on the seat, not inside (user file 5)', async () => {
    const { slope } = await sideParts();
    const brick = await measure('22885');
    const plate2 = await measure('3022');
    // the ear plate one row up (rows -154/-134) and the head's side studs at x = 80
    const earPlate = placed(plate2, [88, -144, 60], RIGHT);
    const upper = placed(brick, [70, -144, 60], [0, 0, -1, 0, 1, 0, 1, 0, 0]);
    const lower = placed(brick, [70, -104, 40], [0, 0, -1, 0, 1, 0, 1, 0, 0]);
    // the slope one plate too far out: its tongue should hook the ear plate, its body lie on the side studs
    const snap = studSnapper([placed(slope, [104, -114, 50], RIGHT_FLIPPED)], [earPlate, upper, lower]);
    for (const x of [-0.2, -0.8, -1.1]) expect(snap({ x, z: 0 })).toEqual({ x: -0.4, y: 0, z: 0 });
    // dragged well away it still moves freely
    expect(snap({ x: 2.2, z: 0 })).toEqual({ x: 2, y: 0, z: 0 });
  });

  it.skipIf(!sideReady)('never sinks a sideways part into the model (user file 6)', async () => {
    const { slope } = await sideParts();
    const brick = await measure('22885');
    const plate2 = await measure('3022');
    const tile = await measure('2431');
    const others = [
      placed(plate2, [88, -144, 60], RIGHT),
      placed(brick, [70, -144, 60], [0, 0, -1, 0, 1, 0, 1, 0, 0]),
      placed(brick, [70, -104, 40], [0, 0, -1, 0, 1, 0, 1, 0, 0]),
      // the shoulder tile right under the slope's thin end
      placed(tile, [88, -74, 40], RIGHT),
    ];
    // seated: pushing further into the head keeps it on its seat
    const seated = studSnapper([placed(slope, [96, -114, 50], RIGHT_FLIPPED)], others);
    for (const x of [-0.3, -0.9, -1.4]) expect(seated({ x, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    // a stud row too low it would sit in the tile: it goes to the real seat a row up
    const low = studSnapper([placed(slope, [116, -94, 50], RIGHT_FLIPPED)], others);
    for (const x of [-0.6, -1.2, -2.1]) expect(low({ x, z: 0 })).toEqual({ x: -1, y: 2.5, z: 0 });
  });

  it.skipIf(!sideReady)('leaves upright parts on plate heights', async () => {
    const { slope } = await sideParts();
    const snap = studSnapper([at(slope, 0, -16, 0)], []);
    expect(snap.sideways).toBe(false);
    expect(snap({ x: 1.2, z: 0, y: 3 })).toEqual({ x: 1, y: 0, z: 0 });
  });
});
