import { beforeAll, describe, expect, it } from 'vitest';
import { assemble, type Metrics } from '../../src/model/assemble';
import type { Box } from '../../src/ldraw/flatten';
import { ensureIds } from '../../src/plan/ids';
import { setAssemblySpot, setLoosePiecesFollow, setSubmodelBuildSpot } from '../../src/plan/pieceActions';
import { boxesOverlap, facing, formatSpot, outline, overlaps, spotWarnings, submodelUses } from '../../src/plan/assemblySpots';
import { parsePlan } from '../../src/plan/schema';
import type { Plan, PlanItem } from '../../src/plan/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

const base = { format: 'brickmotion-plan' as const, version: 1 as const, name: 'police car' };
const piece = (id: string, part = '3001'): PlanItem => ({ id, part, color: 4, x: 0, y: 0, z: 0, rot: 0 });
const use = (id: string, submodel: string): PlanItem => ({ id, submodel, x: 0, y: 0, z: 0, rot: 0 });
const box = (min: number[], max: number[]): Box => ({ min: min as [number, number, number], max: max as [number, number, number] });

const withUse = (): Plan =>
  ensureIds({
    ...base,
    submodels: { 'underside 1': { steps: [{ pieces: [piece('w1', '3020')] }] } },
    steps: [{ pieces: [piece('a'), use('s1', 'underside 1')] }],
  });

describe('assembly spot schema', () => {
  it('round-trips the new optional fields', () => {
    const r = parsePlan({
      ...base,
      assemblySpot: { x: 10, z: -5, angle: 90 },
      loosePiecesFollow: false,
      submodels: { wheel: { steps: [{ pieces: [{ id: 'w', submodel: 'x', x: 0, y: 0, z: 0, rot: 0, assembly: { buildSpot: { x: 2, z: 3, angle: 15 } } }] }] } },
      steps: [],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.assemblySpot).toEqual({ x: 10, z: -5, angle: 90 });
      expect(r.plan.loosePiecesFollow).toBe(false);
      expect(r.plan.submodels!.wheel.steps[0].pieces[0].assembly!.buildSpot).toEqual({ x: 2, z: 3, angle: 15 });
    }
  });

  it('leaves an old file without spots exactly as it was', () => {
    const r = parsePlan({ ...base, steps: [{ pieces: [{ part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.assemblySpot).toBeUndefined();
      expect(r.plan.loosePiecesFollow).toBeUndefined();
      expect(r.plan.steps[0].pieces[0].assembly).toBeUndefined();
    }
  });
});

describe('spot edits', () => {
  it('sets and clears the main spot', () => {
    const p = setAssemblySpot(withUse(), { x: 1, z: 2, angle: 30 });
    expect(p.assemblySpot).toEqual({ x: 1, z: 2, angle: 30 });
    expect(setAssemblySpot(p, null).assemblySpot).toBeUndefined();
  });

  it('only stores "loose pieces follow" when it is off', () => {
    const off = setLoosePiecesFollow(withUse(), false);
    expect(off.loosePiecesFollow).toBe(false);
    expect(setLoosePiecesFollow(off, true).loosePiecesFollow).toBeUndefined();
  });

  it('edits one submodel use and leaves the others alone', () => {
    const p = setSubmodelBuildSpot(withUse(), '', 's1', { x: 8, z: -3, angle: 45 });
    expect(p.steps[0].pieces.find((i) => i.id === 's1')!.assembly!.buildSpot).toEqual({ x: 8, z: -3, angle: 45 });
    expect(p.steps[0].pieces.find((i) => i.id === 'a')!.assembly).toBeUndefined();
    const cleared = setSubmodelBuildSpot(p, '', 's1', null);
    expect(cleared.steps[0].pieces.find((i) => i.id === 's1')!.assembly).toBeUndefined();
  });

  it('edits a nested use inside a submodel definition', () => {
    const nested: Plan = ensureIds({
      ...base,
      submodels: {
        wheel: { steps: [{ pieces: [piece('w1', '3020'), use('inner', 'hub')] }] },
        hub: { steps: [{ pieces: [piece('h1', '3020')] }] },
      },
      steps: [{ pieces: [use('s1', 'wheel')] }],
    });
    const p = setSubmodelBuildSpot(nested, 'wheel', 'inner', { x: 0, z: 0, angle: 0 });
    expect(p.submodels!.wheel.steps[0].pieces.find((i) => i.id === 'inner')!.assembly!.buildSpot).toEqual({ x: 0, z: 0, angle: 0 });
  });
});

describe('listing the uses', () => {
  it('main model first, then each submodel use, nested under its parent', () => {
    const p = ensureIds({
      ...base,
      submodels: {
        wheel: { steps: [{ pieces: [piece('w1', '3020'), use('inner', 'hub')] }] },
        hub: { steps: [{ pieces: [piece('h1', '3020')] }] },
      },
      steps: [{ pieces: [use('s1', 'wheel'), use('s2', 'hub')] }],
    });
    const uses = submodelUses(p);
    expect(uses.map((u) => u.label)).toEqual(['Main model', 'police car – wheel', 'wheel – hub', 'police car – hub']);
    expect(uses.map((u) => u.ref.id)).toEqual(['', 's1', 'inner', 's2']);
    expect(uses.map((u) => u.depth)).toEqual([0, 1, 2, 1]);
  });
});

describe('spot geometry', () => {
  it('a spot at the footprint centre with no angle is the identity', () => {
    const b = box([0, -24, 0], [40, 0, 20]);
    const pts = outline(b, 20, 10, 0);
    expect(pts).toEqual([[0, 0], [40, 0], [40, 20], [0, 20]]);
  });

  it('turns the footprint about its centre and faces the same way', () => {
    const b = box([0, 0, 0], [40, 0, 20]);
    const pts = outline(b, 100, 0, 90);
    const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(90, 3);
    expect(Math.max(...xs)).toBeCloseTo(110, 3);
    expect(facing(90)[0]).toBeCloseTo(1, 6);
    expect(facing(90)[1]).toBeCloseTo(0, 6);
  });

  it('overlaps only when the boxes interpenetrate on every axis', () => {
    expect(boxesOverlap(box([0, 0, 0], [20, 20, 20]), box([10, 0, 0], [30, 20, 20]))).toBe(true);
    expect(boxesOverlap(box([0, 0, 0], [20, 20, 20]), box([40, 0, 0], [60, 20, 20]))).toBe(false);
    expect(overlaps([{ ref: { model: '', id: '' }, label: 'A', box: box([0, 0, 0], [20, 20, 20]), placed: true }, { ref: { model: '', id: 'x' }, label: 'B', box: box([5, 0, 0], [25, 20, 20]), placed: true }])).toHaveLength(1);
  });

  it('formats a spot in studs and degrees', () => {
    expect(formatSpot({ x: 12, z: -4, angle: 90 })).toBe('X 12 · Z −4 studs · 90°');
    expect(formatSpot(null)).toBeNull();
  });
});

describe('static overlap check', () => {
  let metrics: Metrics;
  beforeAll(async () => {
    metrics = await fixtureMetrics(['3001', '3020']);
  });

  it('names the models that overlap and never moves the spot', () => {
    const plan = setAssemblySpot(setSubmodelBuildSpot(withUse(), '', 's1', { x: 0, z: 0, angle: 0 }), { x: 0, z: 0, angle: 0 });
    const asm = assemble(plan, metrics, fixtureColors);
    const warnings = spotWarnings(plan, asm, null);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((w) => w.kind === 'assembly-spot')).toBe(true);
    expect(warnings.some((w) => w.message.includes('Main model') && w.message.includes('underside 1'))).toBe(true);
    expect(plan.assemblySpot).toEqual({ x: 0, z: 0, angle: 0 });
    expect(plan.steps[0].pieces.find((i) => i.id === 's1')!.assembly!.buildSpot).toEqual({ x: 0, z: 0, angle: 0 });
  });

  it('reports nothing when the spots are far apart', () => {
    const plan = setAssemblySpot(setSubmodelBuildSpot(withUse(), '', 's1', { x: 200, z: 0, angle: 0 }), { x: 0, z: 0, angle: 0 });
    const asm = assemble(plan, metrics, fixtureColors);
    expect(spotWarnings(plan, asm, null)).toHaveLength(0);
  });
});
