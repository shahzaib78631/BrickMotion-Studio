import { useCallback, useEffect, useRef, useState } from 'react';
import type { Timeline } from '../anim/timeline';
import type { PlanningProgress } from '../anim/planning';
import type { AnimOptions } from '../anim/pacing';
import type { Plan } from '../plan/types';
import { useStudio } from './store';
import { isAbandoned, planTimeline } from './timelineService';

export type TimelineState = {
  timeline: Timeline | null; planning: boolean; error: string;
  progress: PlanningProgress | null; retry(): void;
};
type State = {
  model: string; plan: Plan | null; optsSig: string; attempt: number;
  timeline: Timeline | null; error: string; status: 'idle' | 'planning' | 'ready' | 'error';
  progress: PlanningProgress | null;
};

export function useTimeline(ready: boolean, plan: Plan, model: string, opts: AnimOptions): TimelineState {
  const dragging = useStudio((s) => s.gesture !== null);
  // Keyframe editing is metadata, not a change to build geometry or routes.
  // Keep the construction plan reference stable across animation-only edits so
  // dragging diamonds does not cancel/restart a potentially expensive planner.
  const previous = useRef(plan);
  if (plan !== previous.current) {
    const old = previous.current;
    const keys = new Set([...Object.keys(plan), ...Object.keys(old)]);
    const animationOnly = [...keys].every((key) => key === 'animation' ||
      (plan as unknown as Record<string, unknown>)[key] === (old as unknown as Record<string, unknown>)[key]);
    if (!animationOnly) previous.current = plan;
  }
  const planningPlan = previous.current;
  const [tries, setAttempt] = useState(0);
  // Regenerate (in the toolbar) counts as a retry too
  const attempt = tries + useStudio((s) => s.replans) * 1e6;
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const optsSig = JSON.stringify(opts);
  const [state, setState] = useState<State>({ model, plan: null, optsSig: '', attempt: -1, timeline: null, error: '', status: 'idle', progress: null });
  useEffect(() => {
    if (!ready || dragging) return;
    let alive = true;
    const request = { model, plan: planningPlan, optsSig, attempt };
    setState((prev) => ({ ...request, timeline: prev.model === model ? prev.timeline : null, error: '', status: 'planning', progress: null }));
    const timer = setTimeout(() => {
      // The promise boundary also catches synchronous request/metrics failures.
      Promise.resolve().then(() => planTimeline(planningPlan, model, opts, 'ui', (progress) => {
        if (alive) setState((prev) => ({ ...prev, progress }));
      })).then((timeline) => {
        if (alive) setState({ ...request, timeline, error: '', status: 'ready', progress: null });
      }).catch((e: unknown) => {
        if (alive) setState({ ...request, timeline: null, status: 'error', progress: null,
          error: isAbandoned(e) ? 'Planning was cancelled by a newer request. Retry this model.' : (e instanceof Error ? e.message : String(e)) });
      });
    }, 120);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dragging, planningPlan, model, optsSig, attempt]);
  const current = state.model === model && state.plan === planningPlan && state.optsSig === optsSig && state.attempt === attempt;
  return {
    timeline: ready && current && state.status === 'ready' ? state.timeline : null,
    planning: ready && !dragging && (!current || state.status === 'planning'),
    error: current ? state.error : '',
    progress: current ? state.progress : null,
    retry,
  };
}
