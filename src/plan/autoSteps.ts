import type { ColorDef } from '../ldraw/colors';
import type { Box } from '../ldraw/flatten';
import { assemble, placementMatrix, transformBox, type Metrics } from '../model/assemble';
import { modelSteps } from './ops';
import type { Plan, PlanItem, Step } from './types';

/** A single step holding more pieces than this is treated as "no steps" (LDraw files without STEP lines). */
export const LARGE_STEP = 24;
const LAYER_TOLERANCE = 4; // LDU: bottoms this close count as the same layer

/**
 * Splits a model's pieces into bottom-up build steps of about `target` pieces,
 * cutting at layer boundaries where possible — the way printed instructions
 * build: the base first, then each layer on top. Every piece keeps its exact
 * position; only the order and step grouping change. Step titles/notes of the
 * original steps are dropped only when they are merged into the new layers.
 */
export function autoSplitSteps(plan: Plan, model: string, metrics: Metrics, colors: Map<number, ColorDef>, target = 10): Plan {
  const steps = modelSteps(plan, model);
  const items = steps.flatMap((s) => s.pieces);
  if (items.length <= target) return plan;
  // place the model's own items in its own space
  const asm = assemble({ ...plan, steps: [{ pieces: items }] }, metrics, colors);
  const boxes = new Map<PlanItem, Box>();
  const byId = new Map(asm.nodes.map((n) => [n.itemId, n]));
  items.forEach((item, k) => {
    const n = byId.get(item.id ?? `:0:${k}`); // assemble's id for an item without one
    if (n) boxes.set(item, transformBox(n.body, placementMatrix(n.local)));
  });
  // LDraw +Y points down: a larger max Y is lower in the model.
  const bottom = (i: PlanItem) => boxes.get(i)?.max[1] ?? 0;
  const sorted = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const d = bottom(b.item) - bottom(a.item);
      if (Math.abs(d) > LAYER_TOLERANCE) return d;
      const ba = boxes.get(a.item), bb = boxes.get(b.item);
      // within a layer: back to front, then left to right, so neighbours arrive together
      return (bb?.min[2] ?? 0) - (ba?.min[2] ?? 0) || (ba?.min[0] ?? 0) - (bb?.min[0] ?? 0) || a.i - b.i;
    })
    .map((e) => e.item);

  const layers: PlanItem[][] = [];
  let layerBottom = Infinity;
  for (const item of sorted) {
    const b = bottom(item);
    if (!layers.length || Math.abs(b - layerBottom) > LAYER_TOLERANCE) {
      layers.push([]);
      layerBottom = b;
    }
    layers[layers.length - 1].push(item);
  }
  const out: Step[] = [];
  let cur: PlanItem[] = [];
  const flush = () => {
    if (cur.length) out.push({ pieces: cur, auto: true });
    cur = [];
  };
  for (const layer of layers) {
    if (cur.length && cur.length + layer.length > target * 1.5) flush();
    for (let k = 0; k < layer.length; k += target * 2) {
      // a very large layer (a baseplate's worth of tiles) is cut into even chunks
      const chunk = layer.slice(k, k + target * 2);
      if (cur.length && cur.length + chunk.length > target * 2) flush();
      cur.push(...chunk);
      if (cur.length >= target) flush();
    }
  }
  flush();
  // keep the hold after the last step, if the original had one
  const lastPause = steps[steps.length - 1]?.pauseAfter;
  if (lastPause && out.length) out[out.length - 1] = { ...out[out.length - 1], pauseAfter: lastPause };
  return model === '' ? { ...plan, steps: out } : { ...plan, submodels: { ...plan.submodels, [model]: { steps: out } } };
}

/** Models whose pieces all sit in one big step — usually an LDraw file without STEP lines. */
export function modelsWithoutSteps(plan: Plan): string[] {
  const names = ['', ...Object.keys(plan.submodels ?? {})];
  return names.filter((m) => {
    const steps = modelSteps(plan, m).filter((s) => s.pieces.length);
    return steps.length === 1 && steps[0].pieces.length > LARGE_STEP;
  });
}

/** Gives every step-less model layered steps. */
export function autoStepPlan(plan: Plan, metrics: Metrics, colors: Map<number, ColorDef>): { plan: Plan; models: string[] } {
  const models = modelsWithoutSteps(plan);
  let next = plan;
  for (const m of models) next = autoSplitSteps(next, m, metrics, colors);
  return { plan: next, models };
}
