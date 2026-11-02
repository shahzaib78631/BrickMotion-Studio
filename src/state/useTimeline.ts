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
  /** This plan is older than the model (auto-planning is off): Plan makes a new one. */
  stale: boolean;
};
type State = {
  model: string; plan: Plan | null; optsSig: string; attempt: number;
  timeline: Timeline | null; error: string; status: 'idle' | 'planning' | 'ready' | 'error';
  progress: PlanningProgress | null;
};

/**
 * Plans the build animation for the open model. `autoPlan` decides what an edit does: on,
 * every change to the geometry is planned again (a full route search, which can take a
 * while); off, the plan already on screen stays and is only marked out of date, and a new
 * one is made when the user asks (Plan / retry), changes the animation options, or switches
 * model. Either way, keyframe and camera edits never re-plan.
 */
export function useTimeline(ready: boolean, plan: Plan, model: string, opts: AnimOptions, autoPlan = true): TimelineState {
  const dragging = useStudio((s) => s.gesture !== null);
  // Keyframe and scene-production editing are not changes to assembly geometry.
  // In particular, dragging a camera must NEVER interrupt an expensive V4 build.
  // Keep the plan reference stable across those metadata-only edits.
  const previous = useRef(plan);
  if (plan !== previous.current) {
    const old = previous.current;
    const keys = new Set([...Object.keys(plan), ...Object.keys(old)]);
    const animationOnly = [...keys].every((key) => key === 'animation' || key === 'sceneSetup' || key === 'cameraTracks' ||
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
  /** The request the last plan was made for: a part edit is not one while auto-planning is off. */
  const planned = useRef<{ model: string; optsSig: string; attempt: number } | null>(null);
  const last = planned.current;
  const sameRequest = last !== null && last.model === model && last.optsSig === optsSig && last.attempt === attempt;
  /** A result worth holding on to while auto-planning is off: a plan, or the error it failed with. */
  const holding = state.status === 'ready' || state.status === 'error';
  /** Whether this render should (re)plan: an edit alone does not count with auto-planning off. */
  const willPlan = autoPlan || !sameRequest || !holding;
  useEffect(() => {
    if (!ready || dragging) return;
    // auto-planning off: an edit of the model leaves the plan that is already there. A new
    // one is asked for by retry (Plan), by an animation option change, or by a model switch,
    // and the first plan of a model is always made — there would be nothing to keep.
    const plannedFor = planned.current;
    if (!autoPlan && holding && plannedFor && plannedFor.model === model && plannedFor.optsSig === optsSig && plannedFor.attempt === attempt) return;
    planned.current = { model, optsSig, attempt };
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
  }, [ready, dragging, planningPlan, model, optsSig, attempt, autoPlan]);
  const mine = state.model === model;
  const current = mine && state.plan === planningPlan && state.optsSig === optsSig && state.attempt === attempt;
  // With auto-planning off the last result stays on screen — a plan, or the error it failed
  // with — until the user asks for a new one.
  const kept = !autoPlan && mine && (state.status === 'ready' || state.status === 'error');
  return {
    timeline: ready && mine && state.status === 'ready' && (current || !autoPlan) ? state.timeline : null,
    planning: ready && !dragging && (state.status === 'planning' || (!current && willPlan)),
    error: current || kept ? state.error : '',
    progress: current ? state.progress : null,
    stale: kept && !current,
    retry,
  };
}
