import { beforeAll, describe, expect, it } from 'vitest';
import { assemble, type Metrics } from '../../src/model/assemble';
import { createSubmodel } from '../../src/plan/createSubmodel';
import { membersOfGroup, nextGroupName, selectionForHit, setGroup, ungroupSelection } from '../../src/plan/groups';
import { parsePlan } from '../../src/plan/schema';
import type { Plan, PlanItem } from '../../src/plan/types';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

const raw = (id: string, x: number, z: number): PlanItem => ({ id, part: '3001', color: 4,
  ldu: [x, 0, z], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] });
const base = (): Plan => ({ format: 'brickmotion-plan', version: 1, name: 'Editable car',
  steps: [{ pieces: [raw('a', 20, -40), raw('b', 60, -40), raw('c', 100, -40)] },
          { pieces: [raw('d', 140, -40)] }] });
let m: Metrics;
beforeAll(async () => { m = await fixtureMetrics(['3001']); });

function worldFor(plan: Plan) {
  const assembled = assemble(plan, m, fixtureColors);
  return new Map(assembled.instances.map(i => [i.key, [...i.world.elements]]));
}

describe('editor groups and new submodels', () => {
  it('groups and ungroups without changing geometry or build steps', () => {
    const plan = base();
    const grouped = setGroup(plan, '', ['a', 'c'], nextGroupName(plan, ''));
    expect(membersOfGroup(grouped, '', 'Group 1')).toEqual(['a', 'c']);
    expect(selectionForHit(grouped, '', 'c')).toEqual(['a', 'c']);
    expect(selectionForHit(grouped, '', 'c', true)).toEqual(['c']);
    expect(grouped.steps[0].pieces.map(i => i.id)).toEqual(['a', 'b', 'c']);
    expect(worldFor(grouped)).toEqual(worldFor(plan));
    const cleared = ungroupSelection(grouped, '', ['a']);
    expect(cleared.steps).toEqual(plan.steps);
  });

  it('creates an editable submodel from two picked parts without changing any world poses', () => {
    const plan = base(), before = worldFor(plan);
    const result = createSubmodel(plan, '', ['a', 'c'], assemble(plan, m, fixtureColors).nodes, 'Axle')!;
    expect(result).not.toBeNull();
    expect(result.name).toBe('Axle');
    expect(result.plan.steps[0].pieces.map(i => i.id)).toEqual([result.referenceId, 'b']);
    expect(result.plan.submodels?.Axle.steps[0].pieces.map(i => i.id)).toEqual(['a', 'c']);
    const after = worldFor(result.plan);
    for (const [key, matrix] of before) {
      const renamed = key === 'a' || key === 'c' ? `${result.referenceId}/${key}` : key;
      expect(after.get(renamed)).toBeDefined();
      after.get(renamed)!.forEach((v, k) => expect(v).toBeCloseTo(matrix[k], 4));
    }
    expect(parsePlan(result.plan).ok).toBe(true);
  });

  it('keeps source object dependencies intact when a related pair becomes a submodel', () => {
    const plan = base();
    plan.steps[0].pieces[2].assembly = { after: ['b'] };
    plan.steps[1].pieces[0].assembly = { after: ['a'] };
    const result = createSubmodel(plan, '', ['a', 'c'], assemble(plan, m, fixtureColors).nodes, 'Axle')!;
    expect(result.plan.steps[0].pieces.find(i => i.id === result.referenceId)?.assembly?.after).toEqual(['b']);
    expect(result.plan.steps[1].pieces.find(i => i.id === 'd')?.assembly?.after).toEqual([result.referenceId]);
  });

  it('refuses an in-place submodel edit that would create a circular dependency', () => {
    const plan = base();
    plan.steps[0].pieces[0].assembly = { after: ['b'] };
    plan.steps[0].pieces[1].assembly = { after: ['a'] };
    expect(createSubmodel(plan, '', ['a', 'c'], assemble(plan, m, fixtureColors).nodes)).toBeNull();
  });

  it('refuses conflicting external attachTo parents rather than silently discarding constraints', () => {
    const plan = base();
    plan.steps[0].pieces[0].assembly = { attachTo: 'b' };
    plan.steps[0].pieces[2].assembly = { attachTo: 'd' };
    expect(createSubmodel(plan, '', ['a', 'c'], assemble(plan, m, fixtureColors).nodes)).toBeNull();
  });

  it('round-trips the independent visibility preference and group metadata', () => {
    const plan = setGroup({ ...base(), showModelAtSpot: true }, '', ['a', 'c'], 'Axle');
    const parsed = parsePlan(plan);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.plan.showModelAtSpot).toBe(true);
      expect(selectionForHit(parsed.plan, '', 'a')).toEqual(['a', 'c']);
    }
  });
});
