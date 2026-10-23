import type { ColorDef } from '../ldraw/colors';
import type { Box } from '../ldraw/flatten';
import { assemble, placementMatrix, transformBox, type Metrics } from '../model/assemble';
import { CARRIER_RATIO, footprint, touching } from './components';
import { findItem, insertStep, modelSteps, moveItemsToStep, type ModelName } from './ops';
import { isSub, type Plan, type PlanItem, type Step } from './types';

/**
 * Moves pieces into step `target`. A step the move empties is removed (steps that
 * were empty already stay). Returns the plan and where the target step ended up.
 */
export function movePiecesToStep(p: Plan, m: ModelName, ids: string[], target: number): { plan: Plan; step: number } {
  const before = modelSteps(p, m);
  if (!ids.length || target < 0) return { plan: p, step: target };
  const moved = moveItemsToStep(p, m, ids, target);
  const after = modelSteps(moved, m);
  const emptied = (s: Step, i: number) => i !== target && s.pieces.length === 0 && (before[i]?.pieces.length ?? 0) > 0;
  if (!after.some(emptied)) return { plan: moved, step: target };
  const kept = after.filter((s, i) => !emptied(s, i));
  const step = target - after.slice(0, target).filter(emptied).length;
  const plan = m === '' ? { ...moved, steps: kept } : { ...moved, submodels: { ...moved.submodels, [m]: { steps: kept } } };
  return { plan, step };
}

/** Moves pieces into a new step inserted at index `at` (0 = first, steps.length = last). */
export function movePiecesToNewStep(p: Plan, m: ModelName, ids: string[], at: number): { plan: Plan; step: number } {
  const len = modelSteps(p, m).length;
  const index = Math.max(0, Math.min(len, Math.round(at)));
  return movePiecesToStep(insertStep(p, m, index), m, ids, index);
}

export type Similar = 'part' | 'color' | 'step' | 'all';

const sameKind = (a: PlanItem, b: PlanItem) => (isSub(a) ? isSub(b) && a.submodel === b.submodel : !isSub(b) && a.part === b.part);
const sameColor = (a: PlanItem, b: PlanItem) => !isSub(a) && !isSub(b) && String(a.color) === String(b.color);

/** Ids of the pieces like `id` in the model: the same part, the same colour, the same step, or every piece. */
export function similarIds(p: Plan, m: ModelName, id: string, kind: Similar): string[] {
  const found = findItem(p, m, id);
  if (!found) return [];
  const steps = modelSteps(p, m);
  const pool = kind === 'step' ? steps[found.step].pieces : steps.flatMap((s) => s.pieces);
  const match = kind === 'part' ? (i: PlanItem) => sameKind(i, found.item) : kind === 'color' ? (i: PlanItem) => sameColor(i, found.item) : () => true;
  return pool.filter((i) => i.id && match(i)).map((i) => i.id!);
}

/**
 * The pieces in contact with these ones ('touching'), or everything reachable
 * through contacts ('connected'): a minifig standing on a station floor reaches
 * the floor, not the whole station, because a baseplate-sized piece is never
 * passed through (unless it is where the search starts).
 */
export function connectedIds(p: Plan, m: ModelName, ids: string[], how: 'touching' | 'connected', metrics: Metrics, colors: Map<number, ColorDef>): string[] {
  const items = modelSteps(p, m).flatMap((s) => s.pieces).filter((i) => i.id);
  const asm = assemble({ ...p, steps: [{ pieces: items }] }, metrics, colors);
  const boxes = new Map<string, Box>();
  for (const n of asm.nodes) if (n.itemId) boxes.set(n.itemId, transformBox(n.body, placementMatrix(n.local)));
  const all = [...boxes.keys()];
  const sizes = all.map((id) => footprint(boxes.get(id)!)).sort((a, b) => a - b);
  const median = sizes[sizes.length >> 1] ?? 0;
  const barrier = (id: string) => all.length > 2 && footprint(boxes.get(id)!) >= CARRIER_RATIO * median;
  const start = ids.filter((id) => boxes.has(id));
  const seen = new Set(start), queue = [...start];
  while (queue.length) {
    const id = queue.shift()!;
    // a baseplate is selected when touched, but the search does not go on through it
    if (!start.includes(id) && barrier(id)) continue;
    const box = boxes.get(id)!;
    for (const other of all) {
      if (seen.has(other) || !touching(box, boxes.get(other)!)) continue;
      seen.add(other);
      if (how === 'connected') queue.push(other);
    }
  }
  return [...seen];
}

/** The steps the pieces are in, in order. */
export function stepsOf(p: Plan, m: ModelName, ids: string[]): number[] {
  const out = new Set<number>();
  for (const id of ids) {
    const f = findItem(p, m, id);
    if (f) out.add(f.step);
  }
  return [...out].sort((a, b) => a - b);
}
