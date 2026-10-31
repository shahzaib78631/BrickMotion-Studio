import { assemble } from '../model/assemble';
import { addsOverlap, collisionWorld, solidsFor } from '../plan/collision';
import { modelSteps, type ModelName } from '../plan/ops';
import type { Plan } from '../plan/types';
import { useAppSettings } from './appSettings';
import { getColors, metricsOf } from './partService';
import { useStudio } from './store';

const top = (key: string) => key.split('/')[0];

/**
 * Whether an edit that moved `ids` is clean: it adds no overlap between a moved piece and
 * any other piece of model `m`. Overlaps that were already there before may stay (imported
 * models), so a stuck piece can always be moved out. Always clean when collision is off.
 */
export function guardEdit(before: Plan, after: Plan, m: ModelName, ids: readonly string[]): boolean {
  if (!useAppSettings.getState().collision || before === after) return true;
  const moving = new Set(ids);
  const view = (p: Plan) => assemble({ ...p, steps: modelSteps(p, m) }, metricsOf, getColors()).instances;
  const was = view(before), now = view(after);
  const world = collisionWorld(solidsFor(now.filter((i) => !moving.has(top(i.key))), metricsOf));
  const mine = (list: typeof was) => solidsFor(list.filter((i) => moving.has(top(i.key))), metricsOf);
  return !addsOverlap(world.hits(mine(was)), world.hits(mine(now)));
}

/**
 * Applies an edit of `ids` unless it pushes them into another piece. Then `retry` (when given)
 * is tried, and if that collides too nothing changes and the pieces flash red.
 */
export function guardedApply(m: ModelName, ids: string[], edit: (p: Plan) => Plan, retry?: (p: Plan) => Plan | null): 'ok' | 'retried' | 'blocked' {
  const st = useStudio.getState();
  const before = st.plan;
  const first = edit(before);
  if (guardEdit(before, first, m, ids)) {
    st.apply(() => first);
    return 'ok';
  }
  const second = retry?.(before);
  if (second && guardEdit(before, second, m, ids)) {
    st.apply(() => second);
    return 'retried';
  }
  st.flashBlocked(ids);
  return 'blocked';
}
