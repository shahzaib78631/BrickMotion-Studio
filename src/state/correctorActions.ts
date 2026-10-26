import {
  correctorHealth,
  correctorMark,
  exportedIds,
  groupsFromCorrectedMpd,
  modelMpd,
  runCorrector,
  withCorrectorSteps,
  withoutCorrectorSteps,
  type CorrectorHealth,
  type CorrectorSummary,
} from '../plan/corrector';
import { useStudio } from './store';

/**
 * Running the Assembly Corrector on one model: hand the model to the local engine, map
 * the corrected step grouping back onto our items, and apply it as one undoable edit.
 * A run that cannot be matched to our pieces is refused rather than applied partially.
 */
export type CorrectorResult = {
  ok: boolean;
  message: string;
  summary?: CorrectorSummary | null;
  steps?: number;
};

export const correctorStatus = (): Promise<CorrectorHealth> => correctorHealth();

export async function runCorrectorForModel(model: string, opts: { maxStep?: number } = {}): Promise<CorrectorResult> {
  const studio = useStudio.getState();
  const plan = studio.plan;
  const mpd = modelMpd(plan, model);
  if (!mpd.trim()) return { ok: false, message: 'this model has nothing to correct' };
  const ids = exportedIds(plan, model);
  const run = await runCorrector(mpd, model || plan.name, opts);
  if (!run.mpd) return { ok: false, message: run.message ?? 'the engine returned no corrected model', summary: run.summary };
  const { groups, unmatched } = groupsFromCorrectedMpd(run.mpd, mpd, ids);
  if (!groups.length) return { ok: false, message: 'the engine returned no steps to apply', summary: run.summary };
  if (unmatched > 0) {
    return { ok: false, message: `the engine's ${unmatched} placement${unmatched === 1 ? '' : 's'} could not be matched to this model, so nothing was changed`, summary: run.summary };
  }
  const mark = correctorMark(plan, model, run.summary);
  const existing = plan.assemblyCorrector?.[model];
  // Re-running keeps the order from before the first correction, so disabling it still
  // puts the model back the way its author had it.
  const remembered = existing?.previous ? { ...mark, previous: existing.previous, at: existing.at } : mark;
  useStudio.getState().apply((p) => ({
    ...withCorrectorSteps(p, model, groups),
    assemblyCorrector: { ...(p.assemblyCorrector ?? {}), [model]: remembered },
  }));
  return {
    ok: true,
    message: `${groups.length} step${groups.length === 1 ? '' : 's'} planned by the engine`,
    summary: run.summary,
    steps: groups.length,
  };
}

/** Stop using the corrector for a model and put the author's step order back. */
export function disableCorrectorForModel(model: string): CorrectorResult {
  const plan = useStudio.getState().plan;
  const mark = plan.assemblyCorrector?.[model];
  if (!mark) return { ok: false, message: 'this model is not using the assembly corrector' };
  const restored = withoutCorrectorSteps(plan, model, mark);
  useStudio.getState().apply((p) => {
    const { [model]: _dropped, ...rest } = p.assemblyCorrector ?? {};
    const next = restored ? { ...restored } : { ...p };
    return { ...next, assemblyCorrector: Object.keys(rest).length ? rest : undefined };
  });
  return { ok: true, message: restored ? 'back to the step order this model had before' : 'no recorded order to restore; the steps were left as they are' };
}
