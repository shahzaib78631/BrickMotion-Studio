import { describe, expect, it } from 'vitest';
import { buildingSpec, generateBuilding, FIXTURE_PARTS, RIDGES, SLOPES, type BuildingKind, type RoofStyle } from '../../src/generate/building';
import { certify } from '../../src/generate/certify';
import type { PieceItem, Plan } from '../../src/plan/types';
import { metricsOf } from '../../src/state/partService';
import { appPartsReady as ready, useAppParts } from '../helpers/appParts';

const pieces = (plan: Plan) => plan.steps.flatMap((s) => s.pieces) as PieceItem[];
const KINDS: BuildingKind[] = ['house', 'shop', 'tower', 'manor', 'block'];
const ROOFS: RoofStyle[] = ['gable', 'hip', 'slope', 'flat'];

describe('building generator', () => {
  it('gives the same building for the same seed, and another for another seed', () => {
    expect(generateBuilding(42).plan).toEqual(generateBuilding(42).plan);
    expect(generateBuilding(42).plan).not.toEqual(generateBuilding(43).plan);
  });

  it('holds together for every seed, with a door and windows', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const g = generateBuilding(seed);
      const parts = pieces(g.plan).map((p) => p.part);
      expect(g.built.components, `seed ${seed} (${g.spec.label})`).toBe(1);
      expect(parts.filter((p) => p === '60596').length, `seed ${seed} door`).toBeGreaterThanOrEqual(1);
      expect(parts.filter((p) => ['60592', '60593', '60594'].includes(p)).length, `seed ${seed} windows`).toBeGreaterThan(1);
    }
  });

  it('varies: every kind, shape and roof turns up, and no two of 200 seeds are alike', () => {
    const specs = Array.from({ length: 200 }, (_, i) => buildingSpec(i + 1));
    expect(new Set(specs.map((s) => s.kind))).toEqual(new Set(KINDS));
    expect(new Set(specs.map((s) => s.shape))).toEqual(new Set(['rect', 'L', 'T', 'U']));
    expect(new Set(specs.map((s) => s.roof))).toEqual(new Set(ROOFS));
    expect(new Set(specs.map((s) => s.label)).size).toBeGreaterThanOrEqual(15);
    const plans = new Set(specs.slice(0, 60).map((s) => JSON.stringify(pieces(generateBuilding(s).plan).map(({ id: _, ...p }) => p))));
    expect(plans.size).toBe(60);
  });

  it('honours the size, floors, shape and roof asked for', () => {
    const g = generateBuilding(buildingSpec(7, { kind: 'house', shape: 'L', width: 12, depth: 10, floors: 3, roof: 'hip' }));
    expect(g.spec).toMatchObject({ width: 12, depth: 10, floors: 3, roof: 'hip', shape: 'L' });
    const bricks = pieces(g.plan).filter((p) => 'x' in p) as (PieceItem & { x: number; z: number })[];
    expect(Math.max(...bricks.map((p) => p.x))).toBeLessThan(12);
    expect(Math.max(...bricks.map((p) => p.z))).toBeLessThan(10);
  });

  it('puts real slopes and a ridge on a sloped roof', () => {
    const g = generateBuilding(buildingSpec(11, { kind: 'house', shape: 'rect', width: 12, depth: 8, roof: 'slope' }));
    const parts = pieces(g.plan).map((p) => p.part);
    expect(parts.some((p) => Object.values(SLOPES).includes(p))).toBe(true);
    expect(parts.some((p) => Object.values(RIDGES).includes(p))).toBe(true);
    expect(g.built.components).toBe(1);
  });
});

describe.skipIf(!ready)('building generator with real parts', () => {
  it('knows its window, door, slope and ridge parts as the library measures them', async () => {
    await useAppParts([...Object.values(FIXTURE_PARTS).flatMap((f) => [f.frame, f.inner]), ...Object.values(SLOPES), ...Object.values(RIDGES)]);
    for (const f of Object.values(FIXTURE_PARTS)) {
      const m = metricsOf(f.frame);
      expect(m.body, f.frame).toEqual(f.body);
      expect(m.footprint, f.frame).toEqual({ w: f.w, d: 1 });
      // the glass or door sits inside its frame: never above or below it (that is wall);
      // a door stands up to 2 LDU proud of the frame's face, as the real part does
      const inner = metricsOf(f.inner).body;
      for (let k = 0; k < 3; k++) {
        const slack = k === 1 ? 0 : 2;
        expect(inner.min[k] + f.offset[k], `${f.inner} axis ${k}`).toBeGreaterThanOrEqual(f.body.min[k] - slack);
        expect(inner.max[k] + f.offset[k], `${f.inner} axis ${k}`).toBeLessThanOrEqual(f.body.max[k] + slack);
      }
    }
    for (const [w, part] of [...Object.entries(SLOPES), ...Object.entries(RIDGES)]) {
      const m = metricsOf(part);
      expect(m.footprint, part).toEqual({ w: Number(w), d: 2 });
      expect(m.heightPlates, part).toBe(3);
    }
    // single slopes fall towards −z: their studs are all on the back row
    for (const part of Object.values(SLOPES)) {
      const studs = (metricsOf(part).snaps ?? []).filter((s) => s.gender === 'M' && Math.abs(s.axis[1]) > 0.9);
      expect(studs.length, part).toBeGreaterThan(0);
      expect(studs.every((s) => s.start[2] > -10), part).toBe(true);
    }
  }, 60000);

  const combos = KINDS.flatMap((kind) => ROOFS.map((roof) => [kind, roof] as const));
  it.each(combos)('certifies a %s with a %s roof as buildable', async (kind, roof) => {
    for (const seed of [3, 17]) {
      const g = generateBuilding(buildingSpec(seed, { kind, roof }));
      const c = await certify(g.plan, g.built.components);
      expect({ seed, label: g.spec.label, ...c }).toMatchObject({ buildable: true, floating: 0, overlapping: 0, unknown: 0, parts: 1 });
    }
  }, 120000);
});
