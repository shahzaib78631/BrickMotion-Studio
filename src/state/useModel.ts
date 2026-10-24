import { useEffect, useMemo, useRef, useState } from 'react';
import { assemble, type Assembly } from '../model/assemble';
import { validate, type Warning } from '../model/validate';
import { modelSteps } from '../plan/ops';
import { isSub, type Plan } from '../plan/types';
import { sameGeometry } from './modelChange';
import { ensureParts, getColors, metricsOf, partName, registerInlineParts } from './partService';
import { useStudio } from './store';

export function allPartIds(plan: Plan): string[] {
  const ids = new Set<string>();
  for (const s of [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap((m) => m.steps)]) for (const i of s.pieces) if (!isSub(i)) ids.add(i.part);
  return [...ids];
}

/** The plan seen from one model: its steps become the top level. '' is the whole set. */
export function scopedPlan(plan: Plan, model: string): Plan {
  if (!model) return plan;
  // A submodel rendered on its own is built at its origin: the main spot and the
  // "loose pieces follow" switch apply only to the root model. Its nested `buildSpot`
  // hints stay with the steps.
  const { assemblySpot: _a, loosePiecesFollow: _f, ...rest } = plan;
  return { ...rest, steps: modelSteps(plan, model) };
}

export type ModelState = {
  /** the plan that was assembled (it can lag the store's plan while parts load) */
  plan: Plan;
  /** the whole model */
  assembly: Assembly;
  /** what the viewport shows: the whole model or the submodel being edited */
  view: Assembly;
  /** the plan `view` was assembled from (equal to the plan for the main model) */
  viewPlan: Plan;
  /** warnings for the shown model */
  warnings: Warning[];
  ready: boolean;
  error?: string;
};

/** the parts' LDCad connectors, so the floating check sees real stud and clip joints */
const snapsOf = (part: string) => metricsOf(part).snaps;

const EMPTY: Assembly = { nodes: [], instances: [], bounds: null, problems: [] };

export function computeModel(plan: Plan, editingModel: string): Omit<ModelState, 'ready'> {
  const colors = getColors();
  const assembly = assemble(plan, metricsOf, colors);
  const all = validate(assembly, partName, snapsOf);
  const viewPlan = scopedPlan(plan, editingModel);
  const view = editingModel ? assemble(viewPlan, metricsOf, colors) : assembly;
  const warnings = editingModel ? all.filter((w) => w.model === editingModel) : all;
  return { plan, assembly, view, viewPlan, warnings };
}

type Base = { plan: Plan; assembly: Assembly; warnings: Warning[] };


/**
 * Loads the parts a plan needs, then assembles and validates it whenever it changes.
 * Opening a submodel only assembles that submodel: the whole set is not rebuilt or
 * re-validated, which kept large imports (hundreds of parts) unresponsive.
 */
export function useModel(): ModelState {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const [base, setBase] = useState<Base | null>(null);
  // Editing object keyframes (or assembly markers) must not re-assemble a
  // hundred-brick submodel on every transform change. Cache by geometry identity.
  const viewCache = useRef<{ assembly: Assembly; model: string; view: Assembly } | null>(null);
  const [failure, setFailure] = useState<{ plan: Plan; message: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFailure(null);
    // Main spot edits move the timeline, NOT the source geometry. Reuse the
    // assembled set and its warnings instead of unloading the viewer on every
    // position/angle edit (and avoid a needless full model rebuild).
    if (base && sameGeometry(base.plan, plan)) {
      setBase({ ...base, plan });
      return () => { cancelled = true; };
    }
    Promise.resolve().then(() => {
      registerInlineParts(plan.parts);
      return ensureParts(allPartIds(plan));
    }).then(() => {
      if (cancelled) return;
      const assembly = assemble(plan, metricsOf, getColors());
      setBase({ plan, assembly, warnings: validate(assembly, partName, snapsOf) });
    }).catch((error: unknown) => {
      if (!cancelled) setFailure({ plan, message: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [plan]);
  return useMemo<ModelState>(() => {
    const error = failure?.plan === plan ? failure.message : '';
    if (!base) return { plan, assembly: EMPTY, view: EMPTY, viewPlan: plan, warnings: [], ready: false, error };
    // The render immediately after a spot edit must stay ready, even before the
    // metadata-only effect synchronises Base. Otherwise useTimeline is briefly
    // disabled and loses the active animation while a marker is committed.
    const current = sameGeometry(base.plan, plan) ? { ...base, plan } : base;
    const viewPlan = scopedPlan(current.plan, editingModel);
    let view = current.assembly;
    if (editingModel) {
      const cached = viewCache.current;
      if (cached?.assembly === current.assembly && cached.model === editingModel) view = cached.view;
      else {
        view = assemble(viewPlan, metricsOf, getColors());
        viewCache.current = { assembly: current.assembly, model: editingModel, view };
      }
    }
    const warnings = editingModel ? current.warnings.filter((w) => w.model === editingModel) : current.warnings;
    return { plan: current.plan, assembly: current.assembly, view, viewPlan, warnings, ready: current.plan === plan && !error, error };
    // `plan` only matters before the first assembly; afterwards `base` carries it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, editingModel, plan, failure]);
}
