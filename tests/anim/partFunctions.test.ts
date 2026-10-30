/** Part functions: the packed table, the lazy cache, and the old gear table's values from measurement. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { PartLibrary } from '../../src/ldraw/library';
import { ensurePartFunctions, loadPartFunctionTable, measurePartFunctions, packPartFunctions, partFunctions, resetPartFunctions } from '../../src/anim/motion/parts/partFunctions';
import { hasMeasuredGear, worldFeatures, worldGear } from '../../src/anim/motion/gears/gearTable';

const LDRAW = join(__dirname, '..', '..', 'public', 'ldraw');
const installed = existsSync(join(LDRAW, 'parts', '3647.dat'));
const lib = new PartLibrary(async p => { const f = join(LDRAW, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; });
const flat = (id: string) => lib.loadPart(`${id}.dat`);
const near = (a: readonly number[], b: readonly number[], tol = 1.5) => a.every((x, i) => Math.abs(x - b[i]) <= tol);
const sameAxis = (a: readonly number[], b: readonly number[]) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) >= Math.cos(4 * Math.PI / 180);

/** The hand-measured table this replaces (gearTable.ts before Phase 3), placed at identity. */
const OLD = {
  spur: { '3647': 8, '10928': 8, '4019': 16, '94925': 16, '3648b': 24, '3649': 40 } as Record<string, number>,
  bevel: { '4143': [14, -17], '32198': [20, -28], '87407': [20, -30] } as Record<string, [number, number]>,
};

describe.skipIf(!installed)('part functions', () => {
  beforeAll(() => resetPartFunctions());

  it('gearTable parity: measured features give the old table values', async () => {
    const I = new THREE.Matrix4();
    for (const [id, teeth] of Object.entries(OLD.spur)) {
      ensurePartFunctions(id, await flat(id));
      const g = worldGear('k', `${id}.dat`, I)!;
      expect(g?.kind, id).toBe('spur');
      if (g.kind === 'rack') throw new Error(id);
      expect(g.teeth, id).toBe(teeth);
      expect(g.radius).toBeCloseTo(1.25 * teeth, 6);
      expect(near(g.centre, [0, 0, 0]) && sameAxis(g.axis, [0, 0, 1]), id).toBe(true);
    }
    for (const [id, [teeth, tip]] of Object.entries(OLD.bevel)) {
      ensurePartFunctions(id, await flat(id));
      const g = worldGear('k', id, I)!;
      if (g.kind === 'rack') throw new Error(id);
      expect([g.kind, g.teeth], id).toEqual(['bevel', teeth]);
      expect(near(g.tip!, [0, 0, tip]), `${id} tip ${g.tip}`).toBe(true);
      expect(g.facing![2], id).toBeLessThan(-0.99);
    }
    // Rack 1x4: pitch line from x = -40 to 40 at y = -4, teeth facing -y.
    ensurePartFunctions('3743', await flat('3743'));
    const r = worldGear('k', 'parts/3743.dat', I)!;
    if (r.kind !== 'rack') throw new Error('rack');
    expect([r.teeth, r.length]).toEqual([10, 80]);
    expect(near(r.centre, [0, -4, 0], 0.01) && sameAxis(r.direction, [1, 0, 0])).toBe(true);
    expect(r.face).toEqual([0, -1, 0]);
    expect(hasMeasuredGear('parts/3743.dat')).toBe(true);
  });

  it('world features follow the part matrix', async () => {
    ensurePartFunctions('32270', await flat('32270'));
    // Turned so its axle runs along x, moved to (100, -20, 40).
    const m = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(100, -20, 40);
    const [f] = worldFeatures('k', '32270.dat', m);
    expect(f.kind).toBe('double-bevel');
    expect(near(f.centre, [100, -20, 40], 1e-6) && sameAxis(f.axis, [1, 0, 0])).toBe(true);
    const xs = f.tips!.map(t => t[0]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(81, 0);
    expect(xs[1]).toBeCloseTo(119, 0);
    expect(worldGear('k', '3001.dat', m)).toBeNull();
  });

  it('lazy measure fills the cache once', async () => {
    resetPartFunctions();
    const f = await flat('6589');
    const first = ensurePartFunctions('6589', f);
    expect(first.teeth[0].kind).toBe('bevel');
    expect(ensurePartFunctions('6589', null)).toBe(first);
    expect(partFunctions('parts/6589.dat')).toBe(first);
  });

  it('packed table round-trips; a packed library leaves its other parts without functions', async () => {
    resetPartFunctions();
    const measured = { '4143': measurePartFunctions(await flat('4143')), '3001': measurePartFunctions(await flat('3001')) };
    const packed = JSON.parse(JSON.stringify(packPartFunctions(measured, { library: 'test', scanned: 2 })));
    expect(Object.keys(packed.parts)).toEqual(['4143']);
    resetPartFunctions();
    loadPartFunctionTable(packed);
    expect(partFunctions('4143')).toEqual(measured['4143']);
    // Covered by the table's scan and absent from it: known to have none, not measured again.
    expect(partFunctions('3001')).toBeUndefined();
    expect(ensurePartFunctions('3001', await flat('3001')).teeth).toEqual([]);
  });
});
