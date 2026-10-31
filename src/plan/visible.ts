import { modelSteps, type ModelName } from './ops';
import type { Plan } from './types';

/** Ids of a model's top-level items shown at `currentStep` (null = every step), minus hidden ones. */
export function visibleItemIds(plan: Plan, m: ModelName, currentStep: number | null, hidden: readonly string[]): Set<string> {
  const gone = new Set(hidden);
  const out = new Set<string>();
  modelSteps(plan, m).forEach((s, i) => {
    if (currentStep !== null && i > currentStep) return;
    for (const it of s.pieces) if (it.id && !gone.has(it.id)) out.add(it.id);
  });
  return out;
}
