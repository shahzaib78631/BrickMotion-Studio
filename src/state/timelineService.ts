import { buildTimeline, type Timeline } from '../anim/timeline';
import { decodeTimeline } from '../anim/timelineCodec';
import type { PlanRequest, PlanResponse } from '../anim/timeline.worker';
import type { AnimOptions } from '../anim/pacing';
import { assemble } from '../model/assemble';
import type { Plan } from '../plan/types';
import { getColors, metricsOf } from './partService';
import { allPartIds, scopedPlan } from './useModel';

/**
 * Builds animation timelines in a Web Worker and caches them per (plan, model,
 * options). Planning a big set can take seconds; on the main thread that froze
 * the whole editor whenever a submodel was opened or a piece was moved.
 *
 * Lanes: 'ui' keeps only the newest request (an outdated plan is abandoned);
 * 'export' runs every request in order.
 */
export type Lane = 'ui' | 'export';

const CACHE_SIZE = 16;
const cache = new Map<string, Promise<Timeline>>();
const planIds = new WeakMap<Plan, number>();
let nextPlanId = 1;
const planKey = (p: Plan) => {
  let id = planIds.get(p);
  if (!id) planIds.set(p, (id = nextPlanId++));
  return id;
};
const optsKey = (o: AnimOptions) =>
  [o.targetSeconds, o.heroOrbit, o.mode ?? 'auto', o.introSeconds ?? '', o.buildSeconds ?? '', o.outroSeconds ?? ''].join('|');

type Job = { req: Omit<PlanRequest, 'id'>; resolve(t: Timeline): void; reject(e: Error): void };

class PlannerWorker {
  private worker: Worker | null = null;
  private busy: { id: number; job: Job } | null = null;
  private queue: Job[] = [];
  private nextId = 1;
  constructor(private replace: boolean) {}

  run(req: Omit<PlanRequest, 'id'>): Promise<Timeline> {
    return new Promise((resolve, reject) => {
      const job = { req, resolve, reject };
      if (this.replace) {
        // Only the newest request matters: drop queued ones and abandon a running one.
        for (const old of this.queue) old.reject(abandoned());
        this.queue = [job];
        if (this.busy) {
          this.busy.job.reject(abandoned());
          this.busy = null;
          this.worker?.terminate();
          this.worker = null;
        }
      } else this.queue.push(job);
      this.pump();
    });
  }

  private pump() {
    if (this.busy || !this.queue.length) return;
    const job = this.queue.shift()!;
    const w = this.ensure();
    if (!w) {
      // No worker support (tests, very old browsers): plan inline, but after this event.
      setTimeout(() => {
        try {
          const table = new Map(job.req.metrics);
          const m = (p: string) => table.get(p) ?? metricsOf(p);
          job.resolve(buildTimeline(assemble(job.req.plan, m, new Map(job.req.colors)), m, job.req.opts));
        } catch (e) {
          job.reject(e as Error);
        }
        this.pump();
      }, 0);
      this.busy = null;
      return;
    }
    const id = this.nextId++;
    this.busy = { id, job };
    w.postMessage({ ...job.req, id } satisfies PlanRequest);
  }

  private ensure(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null;
    try {
      this.worker = new Worker(new URL('../anim/timeline.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return null;
    }
    this.worker.onmessage = (e: MessageEvent<PlanResponse>) => {
      const cur = this.busy;
      if (!cur || cur.id !== e.data.id) return;
      this.busy = null;
      if (e.data.ok) cur.job.resolve(decodeTimeline(e.data.timeline));
      else cur.job.reject(new Error(e.data.error));
      this.pump();
    };
    this.worker.onerror = (e) => {
      const cur = this.busy;
      this.busy = null;
      this.worker?.terminate();
      this.worker = null;
      cur?.job.reject(new Error(e.message || 'Animation planner crashed'));
      this.pump();
    };
    return this.worker;
  }
}

const abandoned = () => Object.assign(new Error('superseded'), { name: 'AbortError' });
const lanes: Record<Lane, PlannerWorker> = { ui: new PlannerWorker(true), export: new PlannerWorker(false) };

/** The animation of `model` ('' = the whole set) of `plan`. Cached; parts must already be loaded. */
export function planTimeline(plan: Plan, model: string, opts: AnimOptions, lane: Lane = 'ui'): Promise<Timeline> {
  const key = `${planKey(plan)}|${model}|${optsKey(opts)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const scoped = scopedPlan(plan, model);
  const metrics = allPartIds(scoped).map((id) => [id, metricsOf(id)] as [string, ReturnType<typeof metricsOf>]);
  const p = lanes[lane].run({ plan: scoped, metrics, colors: [...getColors()], opts });
  cache.set(key, p);
  p.catch(() => cache.get(key) === p && cache.delete(key));
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return p;
}

export const isAbandoned = (e: unknown) => (e as Error)?.name === 'AbortError';
