/**
 * Toothed features measured from LDraw geometry. Oracle values: our earlier
 * measured gear table (checked on LEGO 5590) and Kinebrick's corrections.ldr
 * (erik-larsen/kinebrick, CC BY-SA 4.0), used here only to check our numbers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PartLibrary } from '../../src/ldraw/library';
import { measureTeeth, type ToothedFeature } from '../../src/anim/motion/parts/teeth';

const LDRAW = join(__dirname, '..', '..', 'public', 'ldraw');
const installed = existsSync(join(LDRAW, 'parts', '3647.dat'));
const lib = new PartLibrary(async p => { const f = join(LDRAW, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; });
const teeth = async (id: string) => measureTeeth(await lib.loadPart(`${id}.dat`));
type V = [number, number, number];
const near = (a: readonly number[], b: readonly number[], tol = 1.5) => a.every((x, i) => Math.abs(x - b[i]) <= tol);
/** Axes compare as lines, within 4 degrees. */
const sameAxis = (a: readonly number[], b: readonly number[]) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) >= Math.cos(4 * Math.PI / 180);
const gears = (f: ToothedFeature[]) => f.filter(x => x.kind !== 'rack' && x.kind !== 'worm');
function expectGear(f: ToothedFeature[], want: { kind: ToothedFeature['kind']; teeth: number; centre?: V; axis?: V; tip?: V; tips?: [V, V] }) {
  const g = gears(f).find(x => x.teeth === want.teeth);
  expect(g, `a ${want.teeth} tooth feature among ${JSON.stringify(gears(f).map(x => [x.kind, x.teeth]))}`).toBeDefined();
  expect(g!.kind).toBe(want.kind);
  expect(g!.pitchRadius).toBeCloseTo(1.25 * want.teeth, 6);
  expect(sameAxis(g!.axis, want.axis ?? [0, 0, 1])).toBe(true);
  if (want.centre) expect(near(g!.centre, want.centre), `centre ${g!.centre}`).toBe(true);
  if (want.tip) expect(near(g!.tip!, want.tip), `tip ${g!.tip}`).toBe(true);
  if (want.tips) {
    const t = g!.tips!;
    expect(near(t[0], want.tips[0]) && near(t[1], want.tips[1]) || near(t[0], want.tips[1]) && near(t[1], want.tips[0]), `tips ${JSON.stringify(t)}`).toBe(true);
  }
  return g!;
}

describe.skipIf(!installed)('toothed features from LDraw geometry', () => {
  it('spur gears', async () => {
    for (const [id, n] of [['3647', 8], ['10928', 8], ['4019', 16], ['94925', 16], ['3648b', 24], ['3649', 40]] as const) {
      const f = await teeth(id);
      expect(gears(f), id).toHaveLength(1);
      expectGear(f, { kind: 'spur', teeth: n, centre: [0, 0, 0] });
    }
  });

  it('bevel gears: tooth count, facing side and cone tip', async () => {
    expectGear(await teeth('4143'), { kind: 'bevel', teeth: 14, tip: [0, 0, -17] });
    expectGear(await teeth('32198'), { kind: 'bevel', teeth: 20, tip: [0, 0, -28] });
    expectGear(await teeth('87407'), { kind: 'bevel', teeth: 20, tip: [0, 0, -30] });
    expectGear(await teeth('6589'), { kind: 'bevel', teeth: 12, tip: [0, 0, 17] });
    // Differential case: 28 tooth ring between z = 20 and 28, teeth facing -z, cone tip at z = -10.
    const ring = expectGear(await teeth('62821'), { kind: 'bevel', teeth: 28, tip: [0, 0, -10] });
    expect(ring.facing![2]).toBeLessThan(-0.99);
    expect(ring.centre[2]).toBeGreaterThan(19);
  });

  it('double bevels mesh as spur and as bevel on both sides', async () => {
    expectGear(await teeth('32270'), { kind: 'double-bevel', teeth: 12, centre: [0, 0, 0], tips: [[0, 0, 20], [0, 0, -20]] });
    expectGear(await teeth('32269'), { kind: 'double-bevel', teeth: 20, centre: [0, 0, 0], tips: [[0, 0, 30], [0, 0, -30]] });
    expectGear(await teeth('32498'), { kind: 'double-bevel', teeth: 36, centre: [0, 0, 0] });
  });

  it('finds both gears on 6573', async () => {
    const f = await teeth('6573');
    const big = expectGear(f, { kind: 'spur', teeth: 24 }), small = expectGear(f, { kind: 'spur', teeth: 16 });
    expect(big.centre[2]).toBeGreaterThan(25);
    expect(small.centre[2]).toBeLessThan(-25);
  });

  it('clutch gears keep their spur teeth', async () => {
    for (const [id, n] of [['6542b', 16], ['18946', 16], ['2471', 24]] as const) expectGear(await teeth(id), { kind: 'spur', teeth: n, centre: [0, 0, 0] });
  });

  it('rejects symmetric non-gears', async () => {
    for (const id of ['3713', '4265c', '44772', '3403', '32054', '6536', '3706', '6539', '2780']) {
      expect(gears(await teeth(id)), id).toEqual([]);
    }
  });
});
