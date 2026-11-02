import { describe, expect, it } from 'vitest';
import { partConnectors, submodelConnectors, worldConnectors, type Connector } from '../../src/plan/connectors';
import { itemPlacement } from '../../src/model/assemble';
import { placementMatrix } from '../../src/model/assemble';
import type { Plan } from '../../src/plan/types';
import { measureReal, realMetrics, realPartsReady as ready } from '../helpers/realParts';

const near = (a: readonly number[], b: readonly number[], eps = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const males = (c: Connector[]) => c.filter((x) => x.gender === 'M');
const females = (c: Connector[]) => c.filter((x) => x.gender === 'F');

describe('connector model', () => {
  it.skipIf(!ready)('gives a 2x4 brick 8 up studs and 8 down sockets', async () => {
    const m = await measureReal('3001');
    const c = partConnectors(m);
    expect(males(c)).toHaveLength(8);
    expect(females(c)).toHaveLength(8);
    expect(males(c).every((s) => near(s.axis, [0, -1, 0]))).toBe(true);
    expect(females(c).every((s) => near(s.axis, [0, 1, 0]) && Math.abs(s.pos[1] - m.body.max[1]) < 1e-3)).toBe(true);
  });

  it.skipIf(!ready)('gives a 1x2 jumper one centre stud', async () => {
    const c = partConnectors(await measureReal('3794b'));
    const up = males(c).filter((s) => near(s.axis, [0, -1, 0]));
    expect(up).toHaveLength(1);
    expect(near([up[0].pos[0], up[0].pos[2]], [0, 0])).toBe(true);
  });

  it.skipIf(!ready)('gives a SNOT brick a sideways stud', async () => {
    const c = partConnectors(await measureReal('87087'));
    expect(males(c).some((s) => near(s.axis, [0, 0, -1]) || near(s.axis, [1, 0, 0]) || near(s.axis, [-1, 0, 0]))).toBe(true);
  });

  it.skipIf(!ready)('gives a tall brick with side studs (22885) its deep underside sockets', async () => {
    const down = partConnectors(await measureReal('22885')).filter((c) => c.gender === 'F' && c.axis[1] > 0.9);
    expect(down.map((c) => c.pos[0]).sort((a, b) => a - b)).toEqual([-10, 0, 10]);
    expect(down.every((c) => c.pos[1] === 40)).toBe(true);
  });

  it.skipIf(!ready)('dedupes studs found by both metrics.studs and shadow snaps', async () => {
    for (const id of ['3001', '3023', '3794b', '87087']) {
      const c = partConnectors(await measureReal(id));
      for (let i = 0; i < c.length; i++)
        for (let j = i + 1; j < c.length; j++)
          if (c[i].gender === c[j].gender && near(c[i].axis, c[j].axis)) expect(Math.hypot(...c[i].pos.map((v, k) => v - c[j].pos[k]))).toBeGreaterThan(1);
    }
  });

  it.skipIf(!ready)('gives a Technic brick its side hole, and a pin its shaft, as their own family', async () => {
    // 3700's 8 LDU side hole and 4274's 8 LDU shaft are one joint, and never a stud's
    // the brick's hole is a through hole, so it takes a pin from either face
    const hole = partConnectors(await measureReal('3700')).filter((c) => c.type === 'pin');
    expect(hole).toHaveLength(2);
    expect(hole.map((c) => c.gender)).toEqual(['F', 'F']);
    expect(hole.map((c) => c.axis[2]).map(Math.round).sort()).toEqual([-1, 1]);
    const shaft = partConnectors(await measureReal('4274')).filter((c) => c.type === 'pin');
    expect(shaft.map((c) => c.gender)).toEqual(['M']);
    expect(near(shaft[0].axis, [1, 0, 0])).toBe(true);
    // the brick's studs stay studs: the families do not mate across
    expect(partConnectors(await measureReal('3001')).every((c) => c.type === 'stud')).toBe(true);
  });

  it.skipIf(!ready)('gives a minifig bar its own family: a sword grip, a scabbard peg, a pin’s bore', async () => {
    const grip = partConnectors(await measureReal('21459'));
    expect(grip.map((c) => [c.type, c.gender])).toEqual([['bar', 'M']]);
    const peg = partConnectors(await measureReal('19141'));
    expect(peg.map((c) => [c.type, c.gender])).toEqual([['bar', 'M']]);
    // the Technic pin keeps its pin connector and gains the bar-sized hole through it, open
    // at both ends, so a bar or a scabbard's peg goes in from either side
    const pin = partConnectors(await measureReal('4274'));
    expect(pin.filter((c) => c.type === 'pin').map((c) => c.gender)).toEqual(['M']);
    expect(pin.filter((c) => c.type === 'bar').map((c) => c.gender)).toEqual(['F', 'F']);
    expect(pin.filter((c) => c.type === 'bar').map((c) => Math.round(c.pos[0])).sort()).toEqual([-20, 4]);
  });

  it.skipIf(!ready)('takes a bar in a minifig hand, which the library records as a clip', async () => {
    // 3820's grip is `SNAP_CLP` (shape CLP, always female), not a cylinder: a bar goes in it
    const hand = partConnectors(await measureReal('3820'));
    const clip = hand.filter((c) => c.type === 'bar' && c.gender === 'F');
    expect(clip).toHaveLength(1);
    expect(clip[0].grip).toBe(true);
    expect(clip[0].pos.map((v) => Math.round(v))).toEqual([0, 5, -9]);
    expect(Math.abs(clip[0].pos[1] - 4.5)).toBeLessThan(0.1);
    // and the hand keeps the wrist stud that mounts it on the arm
    expect(hand.filter((c) => c.type === 'stud' && c.gender === 'M')).toHaveLength(1);
  });

  it.skipIf(!ready)('takes a friction grip, which the library records as `fgr`, as a bar', async () => {
    // 15403's blaster handle is `SNAP_FGR` (shape FGR, male, 3 LDU)
    const blaster = partConnectors(await measureReal('15403'));
    const grip = blaster.filter((c) => c.grip);
    expect(grip).toHaveLength(1);
    expect(grip[0].type).toBe('bar');
    expect(grip[0].gender).toBe('M');
    expect(near(grip[0].pos, [0, -16, -27])).toBe(true);
  });

  it.skipIf(!ready)('builds submodel connectors in the submodel frame', async () => {
    const metrics = await realMetrics(['3001']);
    const item = { id: 'b', part: '3001', color: 4, x: 1, y: 2, z: 0, rot: 90 as const };
    const plan = { steps: [], submodels: { s: { steps: [{ pieces: [item] }] } } } as unknown as Plan;
    const got = submodelConnectors(plan, 's', metrics, new Map());
    const want = worldConnectors(partConnectors(metrics('3001')), placementMatrix(itemPlacement(item, metrics('3001').body)).elements);
    expect(got).toHaveLength(16);
    for (const w of want) expect(got.some((g) => g.gender === w.gender && near(g.pos, w.pos) && near(g.axis, w.axis))).toBe(true);
  });
});
