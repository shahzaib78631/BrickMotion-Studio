import type { Timeline } from '../anim/timeline';
import { decodeTimeline, type EncodedTimeline } from '../anim/timelineCodec';
import type { PlanRequest } from '../anim/timeline.worker';
import type { PlanningProgress } from '../anim/planning';
import type { AnimOptions } from '../anim/pacing';
import type { Plan } from '../plan/types';
import { getColors, hasShadowPack, metricsOf } from './partService';
import { getCachedTimeline, putCachedTimeline, timelineFingerprint } from '../storage/timelineCache';
import { allPartIds, scopedPlan } from './useModel';
import { PlannerQueue, type PlannerPort } from './plannerQueue';

export type Lane = 'ui' | 'export';
const CACHE_SIZE = 16;
type Entry = { promise: Promise<Timeline>; listeners: Set<(p: PlanningProgress) => void>; progress: PlanningProgress | null; settled: boolean };
const cache = new Map<string, Entry>();
const planIds = new WeakMap<Plan, number>();
let nextPlanId = 1;
const planKey = (p: Plan) => {
  let id = planIds.get(p);
  if (!id) planIds.set(p, (id = nextPlanId++));
  return id;
};
export const optsKey = (o: AnimOptions) =>
  [o.targetSeconds, o.heroOrbit, o.mode ?? 'auto', o.introSeconds ?? '', o.buildSeconds ?? '', o.outroSeconds ?? '', o.bottomUp ?? true, o.preassembleKnownWheels ?? true, o.planner ?? 'legacy', o.constructionMaxStates ?? 2000, o.constructionMaxMilliseconds ?? 20000, o.constructionSupport ?? 'fixture', o.constructionMechanicalSubassemblies ?? true, o.accessSearchAttempts ?? 12, o.accessSearchMilliseconds ?? 4000].join('|');

const createWorker = (): PlannerPort<EncodedTimeline> => {
  if (typeof Worker === 'undefined') throw new Error('This browser cannot start the animation worker. Use a browser with Web Worker support. The model remains editable.');
  return new Worker(new URL('../anim/timeline.worker.ts', import.meta.url), { type: 'module' });
};
const lanes = {
  ui: new PlannerQueue<Omit<PlanRequest, 'id'>, EncodedTimeline>(createWorker, true),
  export: new PlannerQueue<Omit<PlanRequest, 'id'>, EncodedTimeline>(createWorker, false),
};

/** Parts must be loaded first. UI replacement never cancels an export's request. */
export function planTimeline(plan: Plan, model: string, opts: AnimOptions, lane: Lane = 'ui', onProgress?: (p: PlanningProgress) => void): Promise<Timeline> {
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
  const metrics = allPartIds(scoped).map((id) => [id, metricsOf(id)] as [string, ReturnType<typeof metricsOf>]);
  const listeners = new Set<(p: PlanningProgress) => void>(onProgress ? [onProgress] : []);
  const entry: Entry = { promise: null!, listeners, progress: null, settled: false };
  entry.promise = (async () => {
    // A timeline planned before (this session, an earlier one, or loaded from a project file)
    // is reused: planning a large set can take minutes. Storage failures just mean planning.
    const fingerprint = await timelineFingerprint({ plan: scoped, model, opts: optsKey(opts), shadow: hasShadowPack() }).catch(() => null);
    const saved = fingerprint ? await getCachedTimeline(fingerprint).catch(() => null) : null;
    if (saved) return decodeTimeline(saved);
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

/** The saved (already planned) timeline for this model and options, if there is one. */
export async function savedTimeline(plan: Plan, model: string, opts: AnimOptions): Promise<EncodedTimeline | null> {
  const fingerprint = await timelineFingerprint({ plan: scopedPlan(plan, model), model, opts: optsKey(opts), shadow: hasShadowPack() });
  return getCachedTimeline(fingerprint);
}

/** Makes a timeline from a project file reusable, as if it had just been planned here. */
export async function adoptTimeline(plan: Plan, model: string, opts: string, timeline: EncodedTimeline): Promise<void> {
  const fingerprint = await timelineFingerprint({ plan: scopedPlan(plan, model), model, opts, shadow: hasShadowPack() });
  await putCachedTimeline(fingerprint, timeline);
}
