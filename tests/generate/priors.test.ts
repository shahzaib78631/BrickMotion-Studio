import { describe, expect, it } from 'vitest';
import { buildingSpec, generateBuilding } from '../../src/generate/building';
import { originality, weighted, type BuildingPriors, type SetFingerprint } from '../../src/generate/priors';
import type { Plan } from '../../src/plan/types';

const learned = (over: Partial<BuildingPriors> = {}): BuildingPriors => ({
  buildings: 50,
  schemes: [{ wall: 25, stripe: null, roof: 70, frame: 0, door: 4, trim: 15, weight: 50 }],
  windows: { window2x2: 10 },
  roof: { sloped: 0, flat: 50, slope33Share: 0 },
  footprints: [[12, 10, 50]],
  floors: { '2': 50 },
  ...over,
});

describe('learned building priors', () => {
  it('picks by weight', () => {
    const items = [['a', 1], ['b', 3]] as const;
    expect(weighted(items, ([, w]) => w, 0.1)[0]).toBe('a');
    expect(weighted(items, ([, w]) => w, 0.5)[0]).toBe('b');
  });

  it('builds with the colours, windows, roofs and floors real sets use', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = buildingSpec(seed, { kind: 'house' }, learned());
      expect(s.volumes[0].scheme).toMatchObject({ wall: 25, roof: 70, frame: 0, door: 4 });
      expect(s.roof).toBe('flat');
      expect(s.floors).toBe(2);
      expect(s.volumes[0].windows.upper).toBe('window2x2');
    }
  });

  it('keeps the hand-made tables until enough buildings are learned', () => {
    const few = learned({ buildings: 3 });
    const walls = new Set(Array.from({ length: 30 }, (_, i) => buildingSpec(i + 1, { kind: 'house' }, few).volumes[0].scheme.wall));
    expect(walls.size).toBeGreaterThan(1);
  });

  it('still certifies what it builds from learned priors', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const g = generateBuilding(buildingSpec(seed, {}, learned({ roof: { sloped: 30, flat: 20, slope33Share: 0 } })));
      expect(g.built.components).toBe(1);
    }
  });
});

describe('originality', () => {
  const plan = (pieces: [string, number][]): Plan => ({
    format: 'brickmotion-plan', version: 1, name: 't',
    steps: [{ pieces: pieces.map(([part, color], i) => ({ id: `p${i}`, part, color, x: i, y: 0, z: 0, rot: 0 })) }],
  });
  const sets: SetFingerprint[] = [{ set: '1-1', name: 'Real set', theme: 'Town', pieces: 4, hist: [['3001:4', 0.5], ['3004:15', 0.5]] }];

  it('scores a copy of a real set as not original, and names the set', () => {
    const o = originality(plan([['3001', 4], ['3001', 4], ['3004', 15], ['3004', 15]]), sets);
    expect(o.percent).toBe(0);
    expect(o.closest).toMatchObject({ set: '1-1', shared: 100 });
  });

  it('scores a model sharing nothing as fully original', () => {
    expect(originality(plan([['3003', 1], ['3005', 2]]), sets).percent).toBe(100);
  });

  it('scores a half copy in between', () => {
    expect(originality(plan([['3001', 4], ['3003', 1]]), sets).percent).toBe(50);
  });
});
