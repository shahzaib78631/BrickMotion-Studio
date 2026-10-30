/**
 * Gear, bevel and rack meshes between placed parts, from measured features,
 * and whether they stay engaged as the parts move. The 42000 meshes follow
 * Kinebrick's 42000 analysis (erik-larsen/kinebrick, CC BY-SA 4.0), used only
 * as an oracle.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Assembly } from '../../src/model/assemble';
import { engaged, findHigherPairs, type HigherPair } from '../../src/anim/motion/pairs/higherPairs';
import { loadRealModel, partDataInstalled } from '../diagnostics/loadRealModel';

const SAMPLES = join(__dirname, '..', '..', 'samples');
const M42000 = join(SAMPLES, '42000-1.mpd'), M5590 = join(SAMPLES, '5590_-_whirl_n_wheel_super_truck.mpd');

function finder(asm: Assembly) {
  return (part: string, x: number, y: number, z: number) => {
    const i = asm.instances.find(i => i.part.replace(/\.dat$/, '') === part && Math.hypot(i.world.elements[12] - x, i.world.elements[13] - y, i.world.elements[14] - z) < 3);
    if (!i) throw new Error(`no ${part} at ${x},${y},${z}`);
    return i.key;
  };
}
const pairOf = (pairs: HigherPair[], a: string, b: string) => pairs.find(p => (p.a === a && p.b === b) || (p.a === b && p.b === a));

describe.skipIf(!partDataInstalled() || !existsSync(M42000))('42000 higher pairs', () => {
  let asm: Assembly, pairs: HigherPair[], at: ReturnType<typeof finder>;
  beforeAll(async () => {
    ({ asm } = await loadRealModel(M42000));
    at = finder(asm);
    pairs = findHigherPairs(asm);
  }, 120_000);

  it('42000 meshes', () => {
    const expectPair = (a: string, b: string, kind: HigherPair['kind'], ratio?: number) => {
      const p = pairOf(pairs, a, b);
      expect(p, `${a} ↔ ${b} among ${pairs.length} pairs`).toBeDefined();
      expect(p!.kind).toBe(kind);
      if (ratio) expect(p!.a === a ? p!.ratio : 1 / p!.ratio!).toBeCloseTo(ratio, 6);
    };
    // Differential ring and the drive pinion (28:20 teeth, so the ring turns 20/28 per pinion turn).
    expectPair(at('32269', 0, -60, 600), at('62821', 0, -60, 640), 'bevel', 20 / 28);
    // Drive shaft: 20T double bevel on the engine shaft, side by side with a 12T.
    expectPair(at('32269', 0, -60, 560), at('32270', 0, -100, 560), 'spur', 20 / 12);
    // Steering column: two 20T double bevels through a 12T bevel between them.
    expectPair(at('32269', 0, -100, 0), at('6589', 0, -73, -20), 'bevel');
    expectPair(at('6589', 0, -73, -20), at('32269', 0, -100, -40), 'bevel');
    // Steering pinion on the rack.
    expectPair(at('32270', 0, -100, -320), at('87761', 0, -80, -320), 'rack');
  });

  it('spider meshes both side gears', () => {
    const spider = at('6589', 0, -60, 657);
    for (const x of [17, -17]) expect(pairOf(pairs, spider, at('6589', x, -60, 640))?.kind, `x ${x}`).toBe('bevel');
  });

  it('no mesh between coaxial gears on one axle', () => {
    expect(pairOf(pairs, at('32269', 0, -60, 560), at('32269', 0, -60, 600))).toBeUndefined();
    expect(pairOf(pairs, at('32269', 0, -100, 0), at('32269', 0, -100, -40))).toBeUndefined();
  });

  it('rack runs off its pinion mid-travel', () => {
    const pinion = asm.instances.find(i => i.key === at('32270', 0, -100, -320))!, rack = asm.instances.find(i => i.key === at('87761', 0, -80, -320))!;
    const pair = pairOf(pairs, pinion.key, rack.key)!;
    const poseOf = (key: string) => (key === pinion.key ? pinion.world : rack.world);
    expect(engaged(pair, poseOf(pair.a), poseOf(pair.b)).ok).toBe(true);
    // The rack (along world x) moved 20 LDU still meshes; 60 LDU puts its end past the pinion.
    const shifted = (dx: number) => new THREE.Matrix4().makeTranslation(dx, 0, 0).multiply(rack.world);
    const at20 = pair.a === rack.key ? engaged(pair, shifted(20), pinion.world) : engaged(pair, pinion.world, shifted(20));
    const at60 = pair.a === rack.key ? engaged(pair, shifted(60), pinion.world) : engaged(pair, pinion.world, shifted(60));
    expect(at20.ok).toBe(true);
    expect(at60.ok).toBe(false);
    expect(at60.reason).toMatch(/past the end/);
  });
});

describe.skipIf(!partDataInstalled() || !existsSync(M5590))('5590 higher pairs', () => {
  it('5590 meshes unchanged: the steering bevel pair and the pinion on its rack', async () => {
    const { asm } = await loadRealModel(M5590);
    const pairs = findHigherPairs(asm);
    const kinds = pairs.map(p => [p.kind, ...[p.a, p.b].map(k => asm.instances.find(i => i.key === k)!.part.replace(/\.dat$/, '')).sort()].join(' '));
    expect(kinds).toContain('bevel 4143 4143');
    expect(kinds).toContain('rack 3647 3743');
  }, 120_000);
});
