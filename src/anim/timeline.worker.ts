import type { ColorDef } from '../ldraw/colors';
import { measurePart, type PartMetrics } from '../ldraw/metrics';
import { assemble } from '../model/assemble';
import type { Plan } from '../plan/types';
import type { AnimOptions } from './pacing';
import type { PlannerReply } from './planning';
import { buildTimeline, rootSpotLayout } from './timeline';
import { encodeTimeline } from './timelineCodec';

export type PlanRequest = { id: number; plan: Plan; metrics: [string, PartMetrics][]; colors: [number, ColorDef][]; opts: AnimOptions };
export type PlanResponse = PlannerReply<ReturnType<typeof encodeTimeline>>;

const post = (msg: PlanResponse) => (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);

/** Plans build animations off the main thread so the editor never freezes on large sets. */
self.onmessage = (e: MessageEvent<PlanRequest>) => {
  const { id, plan, opts } = e.data;
  try {
    const table = new Map(e.data.metrics);
    const metrics = (part: string) => table.get(part) ?? measurePart(null, part);
    // "Loose pieces follow off" moves the model onto its spot before planning, while the
    // automatic floor stays where it was (layoutBox). "Follow on" is a post-transform.
    const { asm, layoutBox } = rootSpotLayout(assemble(plan, metrics, new Map(e.data.colors)), plan);
    const tl = buildTimeline(asm, metrics, opts, (progress) => post({ id, progress }), layoutBox, plan.workBaySpots);
    post({ id, ok: true, result: encodeTimeline(tl) });
  } catch (err) {
    post({ id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};
