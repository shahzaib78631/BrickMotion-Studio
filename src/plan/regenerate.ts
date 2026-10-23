import type { ColorDef } from '../ldraw/colors';
import type { Mat3, Vec3 } from '../ldraw/parse';
import type { Metrics } from '../model/assemble';
import { autoSplitSteps } from './autoSteps';
import { canSplitComponents, splitComponents } from './components';
import { modelSteps, type ModelName } from './ops';
import { isGrid, isSub, type Plan, type PlanItem } from './types';

const mul = (a: Mat3, b: Mat3): Mat3 => {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
};
const apply = (m: Mat3, v: Vec3): Vec3 => [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]) as Vec3;

/** Whether this submodel is a component an earlier step split built aside for `model`. */
export function isComponentOf(plan: Plan, model: ModelName, sub: string): boolean {
  const own = `${model || plan.name || 'Model'} - `;
  return sub.startsWith(own) && /^(underside|top|branch) \d+$/.test(sub.slice(own.length));
}

/**
 * Plans the build steps of one model again from scratch: components an earlier
 * split built aside are put back in place, every item goes in one step, then the
 * model is split and layered the same way a step-less import is. Pieces keep
 * their ids and exact placement; only the steps (and its components) change.
 */
export function regenerateSteps(plan: Plan, model: ModelName, metrics: Metrics, colors: Map<number, ColorDef>): Plan {
  const submodels = { ...plan.submodels };
  const dropped = new Set<string>();
  const inline = (item: PlanItem): PlanItem[] => {
    if (!isSub(item) || isGrid(item) || !isComponentOf(plan, model, item.submodel)) return [item];
    dropped.add(item.submodel);
    return modelSteps(plan, item.submodel).flatMap((s) => s.pieces).flatMap((child) => {
      if (isGrid(child)) return [child];
      const ldu = apply(item.matrix, child.ldu).map((v, k) => v + item.ldu[k]) as Vec3;
      return [{ ...child, ldu, matrix: mul(item.matrix, child.matrix) } as PlanItem];
    });
  };
  const items = modelSteps(plan, model).flatMap((s) => s.pieces).flatMap(inline);
  // too few to layer (autoSplitSteps leaves 10 or fewer as they are): keep the author's steps
  if (!dropped.size && items.length <= 10) return plan;
  for (const name of dropped) delete submodels[name];
  let next: Plan = model === ''
    ? { ...plan, steps: [{ pieces: items }], submodels }
    : { ...plan, submodels: { ...submodels, [model]: { steps: [{ pieces: items }] } } };
  if (next.submodels && !Object.keys(next.submodels).length) delete next.submodels;
  const made = canSplitComponents(next, model) ? splitComponents(next, model, metrics, colors) : { plan: next, components: [] };
  next = made.plan;
  for (const m of [model, ...made.components]) next = autoSplitSteps(next, m, metrics, colors);
  return next;
}
