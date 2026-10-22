import { useEffect, useState } from 'react';
import { assemble, type Assembly } from '../model/assemble';
import { validate, type Warning } from '../model/validate';
import { modelSteps } from '../plan/ops';
import { isSub, type Plan } from '../plan/types';
import { ensureParts, getColors, metricsOf, partName, registerInlineParts } from './partService';
import { useStudio } from './store';

export function allPartIds(plan: Plan): string[] {
  const ids = new Set<string>();
  for (const s of [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap((m) => m.steps)])
    for (const i of s.pieces) if (!isSub(i)) ids.add(i.part);
  return [...ids];
}

export type ModelState = {
  /** the whole model */
  assembly: Assembly;
  /** what the viewport shows: the whole model or the submodel being edited */
  view: Assembly;
  /** warnings for the shown model */
  warnings: Warning[];
  ready: boolean;
};

const EMPTY: Assembly = { nodes: [], instances: [], bounds: null, problems: [] };

export function computeModel(plan: Plan, editingModel: string): Omit<ModelState, 'ready'> {
  const colors = getColors();
  const assembly = assemble(plan, metricsOf, colors);
  const all = validate(assembly, partName);
  const view = editingModel ? assemble({ ...plan, steps: modelSteps(plan, editingModel) }, metricsOf, colors) : assembly;
  const warnings = editingModel ? all.filter((w) => w.model === editingModel) : all;
  return { assembly, view, warnings };
}

/** Loads the parts a plan needs, then assembles and validates it whenever it changes. */
export function useModel(): ModelState {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const [state, setState] = useState<ModelState>({ assembly: EMPTY, view: EMPTY, warnings: [], ready: false });
  useEffect(() => {
    let cancelled = false;
    registerInlineParts(plan.parts);
    ensureParts(allPartIds(plan)).then(() => {
      if (!cancelled) setState({ ...computeModel(plan, editingModel), ready: true });
    });
    return () => {
      cancelled = true;
    };
  }, [plan, editingModel]);
  return state;
}
