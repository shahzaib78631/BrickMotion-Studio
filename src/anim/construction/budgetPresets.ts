/** Explicit search budgets for controlled, reproducible Construction V2 diagnostics.
 * These affect computational effort only; they never relax geometric checks.
 * The planner independently enforces hard maxima in planner.ts.
 */
export const CONSTRUCTION_BUDGET_PRESETS = {
  standard: { maxMilliseconds: 20_000, maxStates: 2_000, maxCandidates: 100_000 },
  extended: { maxMilliseconds: 60_000, maxStates: 10_000, maxCandidates: 500_000 },
  diagnostic: { maxMilliseconds: 120_000, maxStates: 50_000, maxCandidates: 1_000_000 },
} as const;

export type ConstructionBudgetPreset = keyof typeof CONSTRUCTION_BUDGET_PRESETS;

export function isConstructionBudgetPreset(value: unknown): value is ConstructionBudgetPreset {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONSTRUCTION_BUDGET_PRESETS, value);
}
