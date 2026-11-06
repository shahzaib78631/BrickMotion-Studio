import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { suggest, symmetryPlane, type Placed } from '../../src/suggest/engine';
import { TECHNIQUES, searchTechniques } from '../../src/suggest/techniques';
import { measureReal, realPartsReady as ready } from '../helpers/realParts';
import type { PartMetrics } from '../../src/ldraw/metrics';

const at = (key: string, part: string, x: number, y: number, z: number, color = 4): Placed =>
  ({ key, part, color, world: new THREE.Matrix4().makeTranslation(x, y, z) });

const ALL_PARTS = [...new Set(['3958', '3020', '3001', '3024', ...TECHNIQUES.flatMap((t) => [...t.parts, ...(t.recipe ?? []).map((s) => s.part)])])];

async function metricsFor(ids: string[]): Promise<(p: string) => PartMetrics | null> {
  const got = new Map<string, PartMetrics>();
  for (const id of ids) {
    try { got.set(id, await measureReal(id)); } catch { /* missing parts stay null */ }
  }
  return (p) => got.get(p) ?? null;
}

describe('techniques library', () => {
  it('covers the 36 handbook techniques with unique ids and sources', () => {
    const fromHandbook = TECHNIQUES.filter((t) => t.url.startsWith('https://brickbuildershandbook.com'));
    expect(fromHandbook.length).toBeGreaterThanOrEqual(36);
    expect(new Set(TECHNIQUES.map((t) => t.id)).size).toBe(TECHNIQUES.length);
  });

  it('finds techniques by what you want to build', () => {
    expect(searchTechniques('round tower')[0].tags).toContain('round');
    expect(searchTechniques('45 degree wall').some((t) => t.id === 'angle-near-triples')).toBe(true);
    expect(searchTechniques('sideways tiles')[0].tags).toContain('snot');
  });

  it.skipIf(!ready)('names only parts the library has', async () => {
    const metrics = await metricsFor(ALL_PARTS);
    const missing = ALL_PARTS.filter((p) => !metrics(p) || metrics(p)!.placeholder);
    expect(missing).toEqual([]);
  });
});

describe('suggestion engine', () => {
  it.skipIf(!ready)('suggests where builders put parts on a 6x6 plate, and every ghost fits', async () => {
    const metrics = await metricsFor(ALL_PARTS.concat(['2431', '87079', '92593', '4477', '4032a']));
    const { suggestions } = suggest({ pieces: [at('a', '3958', 0, 0, 0)], anchors: ['a'], metrics, budgetMs: 2000, limit: 30 });
    const habits = suggestions.filter((s) => s.kind === 'habit');
    expect(habits.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.links > 0)).toBe(true);
    // a habit on top of the plate: one plate height above it (Y down)
    expect(habits.some((s) => Math.abs(s.pieces[0].world[13] + 8) < 1e-6)).toBe(true);
  });

  it.skipIf(!ready)('places the headlight-brick technique with the tile on its side stud', async () => {
    const metrics = await metricsFor(ALL_PARTS);
    const { suggestions } = suggest({ pieces: [at('a', '3001', 0, 0, 0)], anchors: ['a'], metrics, budgetMs: 4000, limit: 60, maxTechniques: Infinity });
    const t = suggestions.find((s) => s.technique === 'snot-headlight');
    expect(t).toBeDefined();
    expect(t!.pieces.map((g) => g.part)).toEqual(['4070', '3070b']);
    // the tile stands upright: its up axis (part −Y) is horizontal in the world
    const up = new THREE.Vector3(0, -1, 0).transformDirection(new THREE.Matrix4().fromArray(t!.pieces[1].world));
    expect(Math.abs(up.y)).toBeLessThan(1e-6);
  });

  it.skipIf(!ready)('solves every placeable recipe on a 2x4 brick or a 6x6 plate', async () => {
    const metrics = await metricsFor(ALL_PARTS);
    const solved = new Set<string>();
    for (const base of [at('a', '3001', 0, 0, 0), at('a', '3958', 0, 0, 0)]) {
      const { suggestions } = suggest({ pieces: [base], anchors: ['a'], metrics, budgetMs: 20000, limit: 200, maxTechniques: Infinity });
      for (const s of suggestions) if (s.technique) solved.add(s.technique);
    }
    const placeable = TECHNIQUES.filter((t) => t.recipe).map((t) => t.id);
    expect(placeable.filter((id) => !solved.has(id))).toEqual([]);
  }, 60000);

  it.skipIf(!ready)('completes a symmetric model with the missing mirror piece', async () => {
    const metrics = await metricsFor(['3020', '3024']);
    const pieces = [at('b', '3020', 0, 0, 0), at('l', '3024', -30, -8, -10), at('r', '3024', 30, -8, -10), at('x', '3024', -10, -8, -10)];
    expect(symmetryPlane(pieces)).toEqual({ axis: 0, at: 0 });
    const { suggestions } = suggest({ pieces, anchors: ['x'], metrics, budgetMs: 2000 });
    const m = suggestions.find((s) => s.kind === 'mirror');
    expect(m?.pieces[0].world.slice(12, 15)).toEqual([10, -8, -10]);
  });

  it.skipIf(!ready)('continues a row', async () => {
    const metrics = await metricsFor(['3958', '3024']);
    const pieces = [at('b', '3958', 0, 0, 0), at('p', '3024', -50, -8, -50), at('q', '3024', -30, -8, -50)];
    const { suggestions } = suggest({ pieces, anchors: ['q'], metrics, budgetMs: 2000 });
    const r = suggestions.find((s) => s.kind === 'repeat');
    expect(r?.pieces[0].world.slice(12, 15)).toEqual([-10, -8, -50]);
  });

  it.skipIf(!ready)('never suggests a pose inside another piece', async () => {
    const metrics = await metricsFor(ALL_PARTS);
    // a 2x4 brick fully covered by another: its top studs are taken, so nothing may go
    // in the covering brick's space (stacking a third brick on top is fine)
    const pieces = [at('a', '3001', 0, 0, 0), at('c', '3001', 0, -24, 0)];
    const { suggestions } = suggest({ pieces, anchors: ['a'], metrics, budgetMs: 3000, limit: 50 });
    expect(suggestions.length).toBeGreaterThan(0);
    const insideCover = (g: { world: number[] }) => g.world[13] > -48 && g.world[13] < 0 && Math.abs(g.world[12]) < 40 && Math.abs(g.world[14]) < 20;
    expect(suggestions.flatMap((s) => s.pieces).filter(insideCover)).toEqual([]);
  });
});
