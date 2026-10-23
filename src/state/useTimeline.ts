import { useEffect, useState } from 'react';
import type { Timeline } from '../anim/timeline';
import type { AnimOptions } from '../anim/pacing';
import type { Plan } from '../plan/types';
import { useStudio } from './store';
import { isAbandoned, planTimeline } from './timelineService';

export type TimelineState = { timeline: Timeline | null; planning: boolean; error: string };

/**
 * The build animation of `model` ('' = the whole set), planned in the background.
 * While a newer plan is computed the previous timeline of the SAME model stays
 * visible; edits during a drag are not planned until the drag ends.
 */
export function useTimeline(ready: boolean, plan: Plan, model: string, opts: AnimOptions): TimelineState {
  const dragging = useStudio((s) => s.gesture !== null);
  const [state, setState] = useState<{ model: string; plan: Plan | null; timeline: Timeline | null; error: string }>({ model, plan: null, timeline: null, error: '' });
  const optsSig = JSON.stringify(opts);
  useEffect(() => {
    if (!ready || dragging) return;
    let alive = true;
    // Debounce bursts of edits (typing a value, nudging with arrow keys).
    const timer = setTimeout(() => {
      planTimeline(plan, model, opts)
        .then((timeline) => alive && setState({ model, plan, timeline, error: '' }))
        .catch((e) => {
          if (alive && !isAbandoned(e)) setState({ model, plan, timeline: null, error: (e as Error).message });
        });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // opts is compared by value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dragging, plan, model, optsSig]);
  const sameModel = state.model === model;
  return {
    timeline: sameModel ? state.timeline : null,
    planning: ready && (!sameModel || state.plan !== plan || state.timeline === null) && !state.error,
    error: sameModel ? state.error : '',
  };
}
