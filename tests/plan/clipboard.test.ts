import { beforeAll, describe, expect, it } from 'vitest';
import { clipFromLDraw, clipToLDraw, copyItems, mergeSubmodels } from '../../src/plan/clipboard';
import type { Plan, PlanItem } from '../../src/plan/types';
import { realMetrics, realPartsReady as ready } from '../helpers/realParts';
import type { PartMetrics } from '../../src/ldraw/metrics';
import { itemPlacement } from '../../src/model/assemble';
import { parseLDConfig, type ColorDef } from '../../src/ldraw/colors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const piece = (id: string, part: string, x: number, extra: Partial<PlanItem> = {}): PlanItem => ({ id, part, color: 4, x, y: 0, z: 0, rot: 0, ...extra } as PlanItem);
const sub = (id: string, name: string, x: number): PlanItem => ({ id, submodel: name, x, y: 0, z: 0, rot: 0 });
const plan = (steps: PlanItem[][], submodels: Plan['submodels'] = {}): Plan => ({ name: 't', steps: steps.map((pieces) => ({ pieces })), submodels } as Plan);

describe('clipboard', () => {
  let metrics: (p: string) => PartMetrics;
  let colors = new Map<number, ColorDef>();
  beforeAll(async () => {
    if (!ready) return;
    metrics = await realMetrics(['3001', '3023']);
    colors = parseLDConfig(readFileSync(join(__dirname, '..', '..', 'public', 'ldraw', 'LDConfig.ldr'), 'utf8'));
  });

  it('copies a selection without ids', () => {
    const p = plan([[piece('a', '3001', 0, { assembly: { group: 'g', role: 'leg', attachTo: 'b' } }), piece('b', '3023', 4), piece('c', '3023', 8)]]);
    const clip = copyItems(p, '', ['a', 'b']);
    expect(clip.items).toHaveLength(2);
    expect(clip.items.every((i) => !('id' in i))).toBe(true);
    expect(clip.items[0].assembly).toEqual({ group: 'g' });
    expect(clip.items[1].assembly).toBeUndefined();
  });

  it('includes nested submodels', () => {
    const p = plan([[sub('s', 'A', 0)]], { A: { steps: [{ pieces: [sub('i', 'B', 0)] }] }, B: { steps: [{ pieces: [piece('x', '3001', 0)] }] }, C: { steps: [] } });
    const clip = copyItems(p, '', ['s']);
    expect(Object.keys(clip.submodels).sort()).toEqual(['A', 'B']);
  });

  it.skipIf(!ready)('round-trips through LDraw text', () => {
    const p = plan([[piece('a', '3001', 0), piece('b', '3023', 4, { color: 1 } as never)]]);
    const clip = copyItems(p, '', ['a', 'b']);
    const back = clipFromLDraw(clipToLDraw(clip, metrics, colors))!;
    expect(back.items.map((i) => ('part' in i ? i.part : '')).sort()).toEqual(['3001', '3023']);
    const b = back.items.find((i) => 'part' in i && i.part === '3023')!;
    const was = clip.items.find((i) => 'part' in i && i.part === '3023')!;
    expect(itemPlacement(b, metrics('3023').body).pos).toEqual(itemPlacement(was, metrics('3023').body).pos);
    expect((b as { color: number }).color).toBe(1);
  });

  it('returns null for text with no pieces', () => {
    expect(clipFromLDraw('hello there')).toBeNull();
  });

  it('reuses an identical submodel', () => {
    const A = { steps: [{ pieces: [piece('x', '3001', 0)] }] };
    const p = plan([[sub('s', 'A', 0)]], { A });
    const clip = copyItems(p, '', ['s']);
    const out = mergeSubmodels(p, clip);
    expect(Object.keys(out.plan.submodels!)).toEqual(['A']);
    expect((out.clip.items[0] as { submodel: string }).submodel).toBe('A');
  });

  it('renames a clashing submodel and leaves the original untouched', () => {
    const mine = { steps: [{ pieces: [piece('x', '3001', 0)] }] };
    const p = plan([[]], { A: mine });
    const clip = { items: [{ submodel: 'A', x: 0, y: 0, z: 0, rot: 0 } as PlanItem], submodels: { A: { steps: [{ pieces: [piece('y', '3023', 2)] }] } } };
    const out = mergeSubmodels(p, clip);
    expect(out.plan.submodels!.A).toEqual(mine);
    expect(out.plan.submodels!['A (2)']).toEqual(clip.submodels.A);
    expect((out.clip.items[0] as { submodel: string }).submodel).toBe('A (2)');
  });
});
