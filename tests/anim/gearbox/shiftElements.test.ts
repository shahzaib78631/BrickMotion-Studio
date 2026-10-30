/** Driving rings and clutch gears, found from measured seats and rods. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Assembly } from '../../../src/model/assemble';
import { inspectMechanisms } from '../../../src/anim/motion/v4/mechanismLab';
import { dogOverlap, findShiftElements, ringTravel } from '../../../src/anim/motion/gearbox/shiftElements';
import { loadRealModel, partDataInstalled } from '../../diagnostics/loadRealModel';

const SAMPLES = join(__dirname, '..', '..', '..', 'samples');
const M8880 = join(SAMPLES, '8880-1.mpd'), M42000 = join(SAMPLES, '42000-1.mpd'), M5590 = join(SAMPLES, '5590_-_whirl_n_wheel_super_truck.mpd');

/** Rounded world-box centre of a part. */
const at = (asm: Assembly, key: string) => {
  const b = asm.instances.find(i => i.key === key)!.worldBox;
  return [0, 1, 2].map(n => Math.round((b.min[n] + b.max[n]) / 2));
};
const load = async (file: string) => {
  const { asm, metrics } = await loadRealModel(file);
  return { asm, rec: inspectMechanisms(asm, metrics).graph.recognition! };
};

describe('dog geometry', () => {
  it('overlap grows with travel and stops at the socket bottom', () => {
    expect(dogOverlap([-20, 20], [20, 32], 0)).toBe(0);
    expect(dogOverlap([-20, 20], [20, 32], 5)).toBe(5);
    expect(dogOverlap([-20, 20], [20, 32], 15)).toBe(12);
  });
  it('travel ends where the dogs bottom out, mirrored on an empty side', () => {
    expect(ringTravel([-20, 20], [[20, 32], [-32, -20]])).toEqual([-12, 12]);
    expect(ringTravel([-20, 20], [[20, 32]])).toEqual([-12, 12]);
  });
});

describe.skipIf(!partDataInstalled())('real gearboxes', () => {
  it.skipIf(!existsSync(M8880))('8880: two rings, each between two clutch gears, neutral at rest', async () => {
    const { asm, rec } = await load(M8880);
    const els = findShiftElements(asm, rec);
    expect(els.map(e => at(asm, e.ring))).toEqual(expect.arrayContaining([[-20, -54, 60], [20, -54, 60]]));
    expect(els).toHaveLength(2);
    for (const e of els) {
      expect(e.couplings.map(c => c.side).sort()).toEqual([-1, 1]);
      expect(e.travel[0]).toBeCloseTo(-12, 0); expect(e.travel[1]).toBeCloseTo(12, 0);
      for (const c of e.couplings) expect(Math.abs(c.engageAt)).toBeCloseTo(2, 0);
      const joiner = asm.instances.find(i => i.part.startsWith('6538a') && at(asm, i.key).join() === [Math.round(e.centre[0]), -54, 60].join())!;
      expect(rec.bodies[e.shaftBody]).toContain(joiner.key);
    }
  }, 600_000);
  it.skipIf(!existsSync(M42000))('42000: the function selector ring on 6538b couples both 6542b gears', async () => {
    const { asm, rec } = await load(M42000);
    const els = findShiftElements(asm, rec);
    expect(els).toHaveLength(1);
    expect(at(asm, els[0].ring)).toEqual([-100, -40, 450]);
    expect(els[0].couplings.map(c => at(asm, c.gear)).sort()).toEqual([[-130, -40, 450], [-70, -40, 450]]);
  }, 600_000);
  it.skipIf(!existsSync(M5590))('5590 has no shift elements', async () => {
    const { asm, rec } = await load(M5590);
    expect(findShiftElements(asm, rec)).toEqual([]);
  }, 600_000);
});
