import { describe, expect, it } from 'vitest';
import { parsePlan } from '../../src/plan/schema';
import { emptyPlan } from '../../src/plan/types';
import { emptyAnimation } from '../../src/anim/keyframes';

describe('baked flight project persistence', () => {
  it('accepts a baked source with held visibility keys', () => {
    const plan = { ...emptyPlan(), animation: { ...emptyAnimation(), tracks: [{
      kind: 'object', source: 'baked-flight', model: '', target: 'truck/wheel', channels: {
        visibility: [{ frame: 1, value: 0, interpolation: 'constant' }, { frame: 10, value: 1, interpolation: 'constant' }],
      },
    }] } };
    const parsed = parsePlan(JSON.parse(JSON.stringify(plan)));
    expect(parsed.ok).toBe(true);
  });
  it('rejects partial visibility values instead of silently fading pieces', () => {
    const plan = { ...emptyPlan(), animation: { ...emptyAnimation(), tracks: [{
      kind: 'object', source: 'baked-flight', model: '', target: 'brick', channels: {
        visibility: [{ frame: 10, value: .5, interpolation: 'linear' }],
      },
    }] } };
    expect(parsePlan(plan).ok).toBe(false);
  });
});
