import { describe, expect, it } from 'vitest';
import { CONSTRUCTION_BUDGET_PRESETS, isConstructionBudgetPreset } from '../../src/anim/construction/budgetPresets';

describe('Construction V2 diagnostic search budgets', () => {
  it('increases all independent limits monotonically without passing planner caps', () => {
    const { standard, extended, diagnostic } = CONSTRUCTION_BUDGET_PRESETS;
    expect([standard.maxMilliseconds, extended.maxMilliseconds, diagnostic.maxMilliseconds]).toEqual([20_000, 60_000, 120_000]);
    expect([standard.maxStates, extended.maxStates, diagnostic.maxStates]).toEqual([2_000, 10_000, 50_000]);
    expect([standard.maxCandidates, extended.maxCandidates, diagnostic.maxCandidates]).toEqual([100_000, 500_000, 1_000_000]);
    expect(diagnostic.maxMilliseconds).toBeLessThanOrEqual(120_000);
    expect(diagnostic.maxStates).toBeLessThanOrEqual(100_000);
    expect(diagnostic.maxCandidates).toBeLessThanOrEqual(2_000_000);
  });

  it('rejects unrecognized persisted budget names', () => {
    expect(isConstructionBudgetPreset('standard')).toBe(true);
    expect(isConstructionBudgetPreset('extended')).toBe(true);
    expect(isConstructionBudgetPreset('diagnostic')).toBe(true);
    expect(isConstructionBudgetPreset('unlimited')).toBe(false);
    expect(isConstructionBudgetPreset(undefined)).toBe(false);
    expect(isConstructionBudgetPreset(120_000)).toBe(false);
  });
});
