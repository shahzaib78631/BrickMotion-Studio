import { applyFloorShifts, applyAssemblySpotTransform } from '../anim/timeline';
import { floorShiftsByKey, resetFloorShifts } from '../plan/pieceActions';
import type { Timeline } from '../anim/timeline';
import { decodeTimeline, type EncodedTimeline } from '../anim/timelineCodec';
import type { PlanRequest } from '../anim/timeline.worker';
import type { PlanningProgress } from '../anim/planning';
import type { AnimOptions, FloorSides, FloorSort } from '../anim/pacing';
import type { ConstructionBudgetPreset } from '../anim/construction/budgetPresets';
import type { Plan } from '../plan/types';
import { ensureParts, getColors, hasShadowPack, metricsOf } from './partService';
import { deleteCachedTimeline, getCachedTimeline, putCachedTimeline, timelineFingerprint } from '../storage/timelineCache';
import { allPartIds, scopedPlan } from './useModel';
import { PlannerQueue, type PlannerPort } from './plannerQueue';

export type Lane = 'ui' | 'export';
const CACHE_SIZE = 16;
type Entry = { promise: Promise<Timeline>; listeners: Set<(p: PlanningProgress) => void>; progress: PlanningProgress | null; settled: boolean };
const cache = new Map<string, Entry>();
/**
 * A plan's planning content: the plan without the waiting spots pieces were dragged
 * to (those are applied to the planned timeline, see applyFloorShifts), and a
 * short signature of it, so a drag finds the animation already planned.
 */
const bases = new WeakMap<Plan, { plan: Plan; key: string }>();
function baseOf(p: Plan): { plan: Plan; key: string } {
  let b = bases.get(p);
  if (!b) {
    let plan = resetFloorShifts(p);
    // Editor-only viewing state and selection groups never invalidate a timeline.
    const { showModelAtSpot: _view, ...withoutView } = plan;
    plan = withoutView as Plan;
    // "Loose pieces follow on" (the default): the main spot is applied to the planned
    // timeline as one rigid transform, so it is not part of the planning cache key —
    // changing it re-applies `S` without planning again. "Follow off" moves the model
    // before planning, so the spot stays in the key.
    if (plan.loosePiecesFollow !== false) {
      const { assemblySpot: _s, loosePiecesFollow: _f, ...rest } = plan;
      plan = rest as Plan;
    }
    const omitGroups = (steps: Plan['steps']) => steps.map(step => ({ ...step, pieces: step.pieces.map(item => {
      if (!item.assembly?.group) return item;
      const { group: _group, ...assembly } = item.assembly;
      const out = { ...item, assembly: Object.keys(assembly).length ? assembly : undefined };
      return out;
    }) }));
    plan = { ...plan, steps: omitGroups(plan.steps), submodels: plan.submodels && Object.fromEntries(
      Object.entries(plan.submodels).map(([name, sub]) => [name, { ...sub, steps: omitGroups(sub.steps) }])) };
    const text = JSON.stringify(plan);
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    bases.set(p, (b = { plan, key: `${text.length.toString(36)}.${(h >>> 0).toString(36)}` }));
  }
  return b;
}
const planKey = (p: Plan) => baseOf(p).key;
export const optsKey = (o: AnimOptions) =>
  [o.targetSeconds, o.heroOrbit, o.mode ?? 'auto', o.introSeconds ?? '', o.buildSeconds ?? '', o.outroSeconds ?? '', o.bottomUp ?? true, o.preassembleKnownWheels ?? true, o.planner ?? 'legacy', o.constructionMaxStates ?? 2000, o.constructionMaxMilliseconds ?? 20000, o.constructionSupport ?? 'fixture', o.constructionMechanicalSubassemblies ?? true, o.accessSearchAttempts ?? 12, o.accessSearchWork ?? 1500, o.accessSearchMilliseconds ?? '',
    // added later: only when changed, so keys (and saved animations) made before stay valid
    ...((o.floorSort ?? 'step') !== 'step' ? [`floor-sort:${o.floorSort}`] : []),
    ...((o.floorSides ?? 'front-back') !== 'front-back' ? [`floor-sides:${o.floorSides}`] : []),
    ...((o.constructionMaxCandidates ?? 100000) !== 100000 ? [`v2-candidates:${o.constructionMaxCandidates}`] : []),
    // Bays are part of the construction payload consumed by the Assembly panel.
    // Invalidate timelines cached before they were reported.
    ...((o.planner === 'construction-v2' || o.planner === 'construction-auto' || o.planner === 'construction-v3' || o.planner === 'construction-v3-auto' || o.planner === 'construction-v4') ? ['work-bays:1'] : []),
    // Route candidate ordering is part of the planning output. Do not silently
    // reuse a previously timed-out/uncertified V3 preview after an engine fix.
    ...((o.planner === 'construction-v3' || o.planner === 'construction-v3-auto') ? ['v3-routing:mechanical-escape-r1', ...(o.constructionStepModules ? ['v3-step-modules:on'] : [])] : []),
    ...((o.planner === 'construction-v4') ? ['v4-global-scene:r1'] : []),
    ...((o.planner === 'standard-motion') ? ['standard-motion:connection-sequence-v3-r2'] : [])].join('|');

/**
 * The video settings an options key was made with (the leading fields, which every
 * saved project has, in this order since the format began). Null if it is not one.
 */
export type SavedVideoSettings = {
  targetSeconds: number; heroOrbit: boolean; mode: 'auto' | NonNullable<AnimOptions['mode']>;
  introSeconds: number | null; buildSeconds: number | null; outroSeconds: number | null;
  bottomUp: boolean; planner: 'legacy' | 'construction-v2' | 'construction-auto' | 'construction-v3' | 'construction-v3-auto' | 'construction-v4' | 'standard-motion'; constructionSupport: 'fixture' | 'table'; constructionBudget?: ConstructionBudgetPreset;
  floorSort: FloorSort; floorSides: FloorSides;
};
export function settingsFromOptsKey(key: string): SavedVideoSettings | null {
  const f = key.split('|');
  const target = Number(f[0]);
  const mode = f[2];
  if (f.length < 9 || !Number.isFinite(target) || !['auto', 'piece', 'batch', 'step'].includes(mode)) return null;
  const seconds = (v: string) => (v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    targetSeconds: target,
    heroOrbit: f[1] === 'true',
    mode: mode as 'auto' | NonNullable<AnimOptions['mode']>,
    introSeconds: seconds(f[3]), buildSeconds: seconds(f[4]), outroSeconds: seconds(f[5]),
    bottomUp: f[6] !== 'false',
    planner: f[8] === 'construction-v2' ? 'construction-v2' : f[8] === 'construction-auto' ? 'construction-auto' : f[8] === 'construction-v3' ? 'construction-v3' : f[8] === 'construction-v3-auto' ? 'construction-v3-auto' : f[8] === 'construction-v4' ? 'construction-v4' : f[8] === 'standard-motion' ? 'standard-motion' : 'legacy',
    constructionSupport: f[11] === 'table' ? 'table' : 'fixture',
    constructionBudget: f[10] === '300000' ? 'v4' : f[10] === '120000' ? 'diagnostic' : f[10] === '60000' ? 'extended' : 'standard',
    floorSort: (['colour', 'part', 'size'] as const).find((v) => f.includes(`floor-sort:${v}`)) ?? 'step',
    floorSides: (['front', 'behind', 'sides'] as const).find((v) => f.includes(`floor-sides:${v}`)) ?? 'front-back',
  };
}

const createWorker = (): PlannerPort<EncodedTimeline> => {
  if (typeof Worker === 'undefined') throw new Error('This browser cannot start the animation worker. Use a browser with Web Worker support. The model remains editable.');
  return new Worker(new URL('../anim/timeline.worker.ts', import.meta.url), { type: 'module' });
};
const lanes = {
  ui: new PlannerQueue<Omit<PlanRequest, 'id'>, EncodedTimeline>(createWorker, true),
  export: new PlannerQueue<Omit<PlanRequest, 'id'>, EncodedTimeline>(createWorker, false),
};

/** Parts must be loaded first. UI replacement never cancels an export's request. */
export function planTimeline(plan: Plan, model: string, opts: AnimOptions, lane: Lane = 'ui', onProgress?: (p: PlanningProgress) => void, withShifts = true): Promise<Timeline> {
  const base = baseOf(plan).plan;
  const planned = planBase(base, model, opts, lane, onProgress);
  if (!withShifts) return planned;
  const shifts = floorShiftsByKey(plan, model);
  let res = shifts.size ? planned.then((tl) => applyFloorShifts(tl, shifts)) : planned;
  // "Loose pieces follow on" (default): the whole scene turns with the main spot. The
  // spot applies only to the root model; a submodel rendered alone keeps its origin.
  if (model === '' && plan.assemblySpot && plan.loosePiecesFollow !== false) {
    const spot = plan.assemblySpot;
    res = res.then((tl) => applyAssemblySpotTransform(tl, spot));
  }
  return res;
}

/** Plans (or finds) the timeline of a plan without dragged waiting spots. */
function planBase(plan: Plan, model: string, opts: AnimOptions, lane: Lane, onProgress?: (p: PlanningProgress) => void): Promise<Timeline> {
  const key = `${lane}|${planKey(plan)}|${model}|${optsKey(opts)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    if (onProgress && !hit.settled) {
      hit.listeners.add(onProgress);
      if (hit.progress) onProgress(hit.progress);
    }
    return hit.promise;
  }
  const scoped = scopedPlan(plan, model);
  const listeners = new Set<(p: PlanningProgress) => void>(onProgress ? [onProgress] : []);
  const entry: Entry = { promise: null!, listeners, progress: null, settled: false };
  entry.promise = (async () => {
    // A timeline planned before (this session, an earlier one, or loaded from a project file)
    // is reused: planning a large set can take minutes. Storage failures just mean planning.
    const fingerprint = await timelineFingerprint({ plan: scoped, model, opts: optsKey(opts), shadow: hasShadowPack() }).catch(() => null);
    const saved = fingerprint ? await getCachedTimeline(fingerprint).catch(() => null) : null;
    if (saved) return decodeTimeline(saved);
    // every part measured first: an unloaded part would reach the planner as an empty
    // placeholder (Construction V2 then stops with "missing collision mesh")
    const ids = allPartIds(scoped);
    await ensureParts(ids);
    const metrics = ids.map((id) => [id, metricsOf(id)] as [string, ReturnType<typeof metricsOf>]);
    const encoded = await lanes[lane].run({ plan: scoped, metrics, colors: [...getColors()], opts }, (p) => {
      entry.progress = p;
      for (const listener of listeners) listener(p);
    });
    if (fingerprint) void putCachedTimeline(fingerprint, encoded).catch(() => {});
    return decodeTimeline(encoded);
  })();
  cache.set(key, entry);
  // Both handlers settle; do not create an unhandled rejected finally() promise.
  entry.promise.then(() => { entry.settled = true; listeners.clear(); }, () => {
    entry.settled = true;
    listeners.clear();
    if (cache.get(key) === entry) cache.delete(key);
  });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return entry.promise;
}
export const isAbandoned = (e: unknown) => (e as Error)?.name === 'AbortError';

/**
 * Drops the planned timelines of these models (this session's and the stored ones),
 * so the next request plans them from scratch. An export already running finishes.
 */
export async function forgetTimelines(plan: Plan, models: string[], opts: AnimOptions): Promise<void> {
  const id = `|${planKey(plan)}|`;
  for (const [key, entry] of cache) if (key.includes(id) && entry.settled) cache.delete(key);
  await Promise.all(models.map(async (model) => {
    const fingerprint = await timelineFingerprint({ plan: scopedPlan(baseOf(plan).plan, model), model, opts: optsKey(opts), shadow: hasShadowPack() });
    await deleteCachedTimeline(fingerprint);
  }));
}

/** The saved (already planned) timeline for this model and options, if there is one. */
export async function savedTimeline(plan: Plan, model: string, opts: AnimOptions): Promise<EncodedTimeline | null> {
  const fingerprint = await timelineFingerprint({ plan: scopedPlan(baseOf(plan).plan, model), model, opts: optsKey(opts), shadow: hasShadowPack() });
  return getCachedTimeline(fingerprint);
}

/** Makes a timeline from a project file reusable, as if it had just been planned here. */
export async function adoptTimeline(plan: Plan, model: string, opts: string, timeline: EncodedTimeline): Promise<void> {
  const fingerprint = await timelineFingerprint({ plan: scopedPlan(baseOf(plan).plan, model), model, opts, shadow: hasShadowPack() });
  await putCachedTimeline(fingerprint, timeline);
}
