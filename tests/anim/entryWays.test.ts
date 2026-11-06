import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Snap } from '../../src/ldraw/shadow';
import { entryWays, hingeClipWays, mateAxes, worldSnaps } from '../../src/anim/snapMates';
import { buildTimeline } from '../../src/anim/timeline';
import { importLDraw } from '../../src/io/ldrawImport';
import { ensureIds } from '../../src/plan/ids';
import { partDataInstalled } from '../diagnostics/loadRealModel';
import { loadRealPlan } from '../diagnostics/loadRealPlan';

type V = [number, number, number];
const cyl = (gender: 'M' | 'F', start: V, axis: V, length: number, radius: number, shapes = ['R']): Snap =>
  ({ kind: 'cyl', gender, start, axis, length, radius, shapes, slide: false });
const fgr = (gender: 'M' | 'F', start: V, axis: V): Snap =>
  ({ kind: 'fgr', gender, start, axis, length: 20, radius: 4, shapes: ['FGR'], slide: false });
const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z).elements;
const box = (min: V, max: V) => ({ min, max });
const near = (a: readonly number[], b: readonly number[]) => a.every((v, k) => Math.abs(v - b[k]) < 1e-9);

// a stud on top of a part (axis up, out of the part) and the anti-stud of a plate 8 LDU above
// it (axis up, from its mouth into the plate)
const stud = cyl('M', [0, 0, 0], [0, -1, 0], 4, 6);
const socket = cyl('F', [0, 0, 0], [0, -1, 0], 4, 6);
const below = box([-10, 0, -10], [10, 8, 10]);
const above = box([-10, -8, -10], [10, 0, 10]);

describe('connector entry ways', () => {
  it('a round stud seats in the square socket of a 1-wide plate', () => {
    const square = cyl('F', [0, 0, 0], [0, -1, 0], 4, 6, ['S']);
    expect(mateAxes(worldSnaps([stud], at(0, 0, 0)), worldSnaps([square], at(0, 0, 0)))).toHaveLength(1);
    // still not an axle, nor a Technic pin
    expect(mateAxes(worldSnaps([cyl('M', [0, 0, 0], [0, -1, 0], 4, 6, ['A'])], at(0, 0, 0)), worldSnaps([square], at(0, 0, 0)))).toHaveLength(0);
    expect(mateAxes(worldSnaps([cyl('M', [0, 0, 0], [0, -1, 0], 20, 8)], at(0, 0, 0)), worldSnaps([square], at(0, 0, 0)))).toHaveLength(0);
  });

  it('have a side: a plate comes down onto a stud, and a stud comes up into a plate already built', () => {
    // the plate arrives: it starts above (entry way up, -Y)
    const plate = entryWays(worldSnaps([socket], at(0, 0, 0)), worldSnaps([stud], at(0, 0, 0)), above, below);
    expect(plate).toEqual([[0, -1, 0]]);
    // the studded part arrives under a plate already in place: from below only, never down
    // through the plate (the 99780 bracket under a 2x4 plate)
    const bracket = entryWays(worldSnaps([stud], at(0, 0, 0)), worldSnaps([socket], at(0, 0, 0)), below, above);
    expect(bracket).toHaveLength(1);
    expect(near(bracket[0], [0, 1, 0])).toBe(true);
  });

  it('a hole right through its part takes a pin from either face', () => {
    const hole = cyl('F', [0, 0, -10], [0, 0, 1], 20, 8);
    const pin = cyl('M', [0, 0, -10], [0, 0, 1], 20, 8);
    const ways = entryWays(worldSnaps([pin], at(0, 0, 0)), worldSnaps([hole], at(0, 0, 0)), box([-8, -8, -30], [8, 8, 10]), box([-10, -10, -10], [10, 10, 10]));
    expect(ways).toHaveLength(2);
    // a blind hole (half as deep as the part) only from its mouth
    const blind = cyl('F', [0, 0, -10], [0, 0, 1], 10, 8);
    expect(entryWays(worldSnaps([pin], at(0, 0, 0)), worldSnaps([blind], at(0, 0, 0)), box([-8, -8, -30], [8, 8, 10]), box([-10, -10, -10], [10, 10, 10])))
      .toEqual([[0, 0, -1]]);
  });

  it('hinge halves do not slide along the pin; they clip on from the side their body is on', () => {
    const a = worldSnaps([fgr('M', [0, 0, 0], [1, 0, 0])], at(0, 0, 0));
    const b = worldSnaps([fgr('F', [0, 0, 0], [1, 0, 0])], at(0, 0, 0));
    expect(mateAxes(a, b)).toHaveLength(1);
    expect(entryWays(a, b, box([-10, -20, -10], [10, 0, 10]), box([-10, 0, -10], [10, 20, 10]))).toEqual([]);
    const clip = hingeClipWays(a, b, [3, -10, 0]);
    expect(clip).toHaveLength(1);
    expect(near(clip[0], [0, -1, 0])).toBe(true);
    // a part centred on the pin has no side to come from
    expect(hingeClipWays(a, b, [5, 0, 0])).toEqual([]);
  });

  it('a hinge plate sticking out sideways clips on from the base\'s open side, not along its own plate', () => {
    // Hellboy's 6134 tops: the plate sticks out below and beside the pin, the 3937 base is on +Z
    const a = worldSnaps([fgr('M', [0, 0, 0], [1, 0, 0])], at(0, 0, 0));
    const b = worldSnaps([fgr('F', [0, 0, 0], [1, 0, 0])], at(0, 0, 0));
    const clip = hingeClipWays(a, b, [0, 8, -7], [0, 0, 3]);
    expect(clip).toHaveLength(1);
    expect(near(clip[0], [0, 0, -1])).toBe(true);
    // a base centred on the pin falls back to the moving half's own body
    expect(near(hingeClipWays(a, b, [3, -10, 0], [4, 0, 0])[0], [0, -1, 0])).toBe(true);
  });
});

// From the user's Hellboy project ("Hellboy (2) (3)"): a hinge top on its base, and a bracket
// whose studs go up into a 2x4 plate.
const HINGE = `0 hinge
1 0 30 40 0 1 0 0 0 1 0 0 0 1 3958.dat
0 STEP
1 4 24 -30 0 0 1 0 0 0 -1 -1 0 0 3937.dat
1 4 25.3397 -25 0 0 0.866 0.5 0 -0.5 0.866 1 0 0 6134.dat
`;
const BRACKET = `0 bracket
1 0 60 8 30 1 0 0 0 1 0 0 0 1 2431.dat
0 STEP
1 0 60 -32 40 1 0 0 0 1 0 0 0 1 3020.dat
1 320 60 -24 30 1 0 0 0 1 0 0 0 1 99780.dat
0 STEP
`;

const plan = async (text: string, edit?: (p: ReturnType<typeof importLDraw>) => void) => {
  const p = ensureIds(importLDraw(text, 'fixture.ldr'));
  edit?.(p);
  const { asm, metrics } = await loadRealPlan(p);
  const tl = buildTimeline(asm, metrics, { targetSeconds: 10, heroOrbit: false, mode: 'piece' });
  const entry = (part: string) => {
    const inst = asm.instances.find((i) => i.part.replace(/\.dat$/, '') === part)!;
    const move = tl.tracks.get(inst.key)!.moves.at(-1)!;
    return { entry: move.entry, uncertified: !!tl.units[move.unit].uncertified, unit: move.unit, inst };
  };
  return { asm, metrics, tl, entry };
};

describe.skipIf(!partDataInstalled())('legacy planner approach on real parts', () => {
  it('a 2x2 hinge top does not slide on along the hinge pin of its 1x2 base', async () => {
    const { entry, metrics } = await plan(HINGE);
    const top = entry('6134');
    const pin = worldSnaps(metrics('3937').snaps, entry('3937').inst.world.elements).find((s) => s.snap.kind === 'fgr')!;
    expect(pin).toBeTruthy();
    const len = Math.hypot(...top.entry);
    if (len > 0) {
      const along = Math.abs(top.entry[0] * pin.axis[0] + top.entry[1] * pin.axis[1] + top.entry[2] * pin.axis[2]) / len;
      expect(along).toBeLessThan(0.9);
    }
    expect(top.uncertified).toBe(false);
  });

  it('a bracket under a 2x4 plate goes on first, studs up into the plate', async () => {
    const { entry } = await plan(BRACKET);
    const bracket = entry('99780'), plate = entry('3020');
    expect(bracket.unit).toBeLessThan(plate.unit);
    expect(bracket.uncertified).toBe(false);
    expect(plate.uncertified).toBe(false);
  });

  it('with the plate forced first, the bracket is never certified coming down through it', async () => {
    const { entry } = await plan(BRACKET, (p) => {
      for (const step of p.steps) for (const piece of step.pieces) if ('part' in piece && piece.part.replace(/\.dat$/, '') === '3020') piece.assembly = { root: true };
    });
    const bracket = entry('99780');
    // from above (entry 0 or upward) would pass through the plate
    const fromAbove = bracket.entry.every((v) => v === 0) || bracket.entry[1] < -1;
    expect(!bracket.uncertified && fromAbove).toBe(false);
  });
});
