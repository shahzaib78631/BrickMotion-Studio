import { assemble } from '../model/assemble';
import { collisionWorld, solidsFor } from '../plan/collision';
import { modelSteps, type ModelName } from '../plan/ops';
import type { Plan } from '../plan/types';
import { useAppSettings } from './appSettings';
import { getColors, metricsOf } from './partService';
import { useStudio } from './store';

const top = (key: string) => key.split('/')[0];

/** An edit's collision verdict, with the pieces it would newly sit inside. */
export type GuardResult = { ok: boolean; hits: string[] };

/**
 * Whether an edit that moved `ids` is clean, and which pieces it would newly penetrate. The
 * pieces' boxes are only the prefilter: the same collision world the drag uses decides.
 * Overlaps that were already there before may stay (imported models), so a stuck piece can
 * always be moved out. Always clean when collision is off.
 */
export function guardConflict(before: Plan, after: Plan, m: ModelName, ids: readonly string[]): GuardResult {
  if (!useAppSettings.getState().collision || before === after) return { ok: true, hits: [] };
  const moving = new Set(ids);
  const view = (p: Plan) => assemble({ ...p, steps: modelSteps(p, m) }, metricsOf, getColors()).instances;
  const was = view(before), now = view(after);
  const world = collisionWorld(solidsFor(now.filter((i) => !moving.has(top(i.key))), metricsOf));
  const mine = (list: typeof was) => solidsFor(list.filter((i) => moving.has(top(i.key))), metricsOf);
  const beforeHits = world.hits(mine(was));
  const hits = [...world.hits(mine(now))].filter((id) => !beforeHits.has(id));
  return { ok: hits.length === 0, hits };
}

/**
 * A cached collision probe for one gizmo gesture. The stationary solids and
 * pre-existing overlaps are immutable during the drag, so rebuild neither
 * for every 5-degree hinge sample nor for every pointermove.
 * A new probe must be created when a gesture begins or its selection changes.
 */
export function createGizmoCollisionProbe(before: Plan, m: ModelName, ids: readonly string[]): (after: Plan) => GuardResult {
  if (!useAppSettings.getState().collision) return () => ({ok:true,hits:[]});
  const moving = new Set(ids);
  const view = (p: Plan) => assemble({ ...p, steps: modelSteps(p, m) }, metricsOf, getColors()).instances;
  const original = view(before);
  const stationary = collisionWorld(solidsFor(original.filter(i=>!moving.has(top(i.key))),metricsOf));
  const ownSolids = (list: typeof original) => solidsFor(list.filter(i=>moving.has(top(i.key))),metricsOf);
  const initialContacts = stationary.hits(ownSolids(original));
  return (after: Plan) => {
    if (!useAppSettings.getState().collision || before === after) return {ok:true,hits:[]};
    const candidate = view(after);
    const hits = [...stationary.hits(ownSolids(candidate))].filter(id=>!initialContacts.has(id));
    return {ok:hits.length===0,hits};
  };
}

/** Whether an edit that moved `ids` is clean (see `guardConflict` for why it is not). */
export function guardEdit(before: Plan, after: Plan, m: ModelName, ids: readonly string[]): boolean {
  return guardConflict(before, after, m, ids).ok;
}

/**
 * Applies an edit of `ids` unless it pushes them into another piece. Then `retry` (when given)
 * is tried, and if that collides too nothing changes and the pieces flash red, with the
 * pieces they would have hit kept for the sidebar.
 */
export function guardedApply(m: ModelName, ids: string[], edit: (p: Plan) => Plan, retry?: (p: Plan) => Plan | null): 'ok' | 'retried' | 'blocked' {
  const st = useStudio.getState();
  const before = st.plan;
  const first = edit(before);
  const firstCheck = guardConflict(before, first, m, ids);
  if (firstCheck.ok) {
    st.apply(() => first);
    return 'ok';
  }
  const second = retry?.(before);
  if (second && guardConflict(before, second, m, ids).ok) {
    st.apply(() => second);
    return 'retried';
  }
  st.flashBlocked(ids, firstCheck.hits, 'the move would put it inside another piece');
  return 'blocked';
}

/**
 * One gizmo step: a move or turn that would push the pieces into another is held at the last
 * clean plan (or the start). Scale is its own explicit mode and is not guarded. The gizmo runs
 * every frame, so this only records the reason (no per-frame flash).
 */
export function clampGizmo(mode: 'translate' | 'rotate' | 'scale', original: Plan, next: Plan, lastClean: Plan | null, m: ModelName, ids: readonly string[], probe?: (next: Plan)=>GuardResult): { plan: Plan; blocked: boolean } {
  if (mode === 'scale') return { plan: next, blocked: false };
  const check = probe ? probe(next) : guardConflict(original, next, m, ids);
  if (check.ok) return { plan: next, blocked: false };
  useStudio.getState().noteBlocked([...ids], check.hits, mode === 'rotate'
    ? 'the turn would put it inside another piece'
    : 'it would sit inside another piece');
  return { plan: lastClean ?? original, blocked: true };
}
