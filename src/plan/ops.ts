import type { Box } from '../ldraw/flatten';
import type { Mat3, Vec3 } from '../ldraw/parse';
import { rotatedBox, rotMatrix } from './placement';
import { isGrid, type Plan, type PlanItem, type Rot, type Step } from './types';

/** '' is the main model; anything else names a submodel. */
export type ModelName = string;
export type Footprint = (item: PlanItem) => { w: number; d: number };

export function modelSteps(p: Plan, m: ModelName): Step[] {
  return m === '' ? p.steps : (p.submodels?.[m]?.steps ?? []);
}

function withSteps(p: Plan, m: ModelName, steps: Step[]): Plan {
  if (m === '') return { ...p, steps };
  return { ...p, submodels: { ...p.submodels, [m]: { steps } } };
}

function mapItems(p: Plan, m: ModelName, ids: string[], fn: (i: PlanItem) => PlanItem): Plan {
  const set = new Set(ids);
  const steps = modelSteps(p, m).map((s) =>
    s.pieces.some((i) => i.id && set.has(i.id)) ? { ...s, pieces: s.pieces.map((i) => (i.id && set.has(i.id) ? fn(i) : i)) } : s,
  );
  return withSteps(p, m, steps);
}

export function moveItems(p: Plan, m: ModelName, ids: string[], d: { x: number; y: number; z: number }): Plan {
  return mapItems(p, m, ids, (i) =>
    isGrid(i) ? { ...i, x: i.x + d.x, y: i.y + d.y, z: i.z + d.z } : { ...i, ldu: [i.ldu[0] + 20 * d.x, i.ldu[1] - 8 * d.y, i.ldu[2] + 20 * d.z] as Vec3 },
  );
}

function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r.map((v) => (Object.is(v, -0) ? 0 : v)) as Mat3;
}

const center = (b: Box): Vec3 => [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2) as Vec3;

export function rotateItems(p: Plan, m: ModelName, ids: string[], fp: Footprint, body: (i: PlanItem) => Box): Plan {
  return mapItems(p, m, ids, (i) => {
    if (isGrid(i)) {
      const { w, d } = fp(i);
      return { ...i, rot: ((i.rot + 90) % 360) as Rot, x: Math.floor(i.x + w / 2 - d / 2 + 0.5), z: Math.floor(i.z + d / 2 - w / 2 + 0.5) };
    }
    const b = body(i);
    const c0 = center(rotatedBox(b, i.matrix));
    const matrix = mul(rotMatrix(90), i.matrix);
    const c1 = center(rotatedBox(b, matrix));
    const ldu = [0, 1, 2].map((k) => i.ldu[k] + c0[k] - c1[k] || 0) as Vec3;
    return { ...i, matrix, ldu };
  });
}

export function deleteItems(p: Plan, m: ModelName, ids: string[]): Plan {
  const set = new Set(ids);
  return withSteps(
    p,
    m,
    modelSteps(p, m).map((s) => ({ ...s, pieces: s.pieces.filter((i) => !(i.id && set.has(i.id))) })),
  );
}

export function setColor(p: Plan, m: ModelName, ids: string[], color: string | number): Plan {
  return mapItems(p, m, ids, (i) => ('part' in i ? { ...i, color } : i));
}

export function setPart(p: Plan, m: ModelName, ids: string[], part: string): Plan {
  return mapItems(p, m, ids, (i) => ('part' in i ? { ...i, part } : i));
}

export function addItem(p: Plan, m: ModelName, step: number, item: PlanItem): Plan {
  const steps = [...modelSteps(p, m)];
  if (step >= steps.length) steps.push({ pieces: [item] });
  else steps[step] = { ...steps[step], pieces: [...steps[step].pieces, item] };
  return withSteps(p, m, steps);
}

export function moveItemsToStep(p: Plan, m: ModelName, ids: string[], step: number): Plan {
  const set = new Set(ids);
  const moving: PlanItem[] = [];
  const steps = modelSteps(p, m).map((s) => ({
    ...s,
    pieces: s.pieces.filter((i) => {
      if (i.id && set.has(i.id)) {
        moving.push(i);
        return false;
      }
      return true;
    }),
  }));
  while (steps.length <= step) steps.push({ pieces: [] });
  steps[step] = { ...steps[step], pieces: [...steps[step].pieces, ...moving] };
  return withSteps(p, m, steps);
}

/** Move an entire step without changing the order of parts *inside* that step. */
export function reorderStep(p: Plan, m: ModelName, from: number, to: number): Plan {
  const steps = [...modelSteps(p, m)];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= steps.length || to >= steps.length || from === to) return p;
  const [s] = steps.splice(from, 1);
  steps.splice(to, 0, s);
  return withSteps(p, m, steps);
}

export function insertStep(p: Plan, m: ModelName, at: number): Plan {
  const steps = [...modelSteps(p, m)];
  if (!Number.isInteger(at) || at < 0 || at > steps.length) return p;
  steps.splice(at, 0, { pieces: [] });
  return withSteps(p, m, steps);
}

/** Removes a step; its pieces join the previous step (or the next one when it is the first). */
export function deleteStep(p: Plan, m: ModelName, at: number): Plan {
  const steps = [...modelSteps(p, m)];
  if (!Number.isInteger(at) || at < 0 || at >= steps.length || (steps.length === 1 && steps[0].pieces.length > 0)) return p;
  const [gone] = steps.splice(at, 1);
  if (gone.pieces.length && steps.length) {
    const target = at === 0 ? 0 : at - 1;
    const keep = steps[target];
    steps[target] = {
      ...keep,
      pieces: at === 0 ? [...gone.pieces, ...keep.pieces] : [...keep.pieces, ...gone.pieces],
      notes: at === 0
        ? [gone.notes, keep.notes].filter(Boolean).join('\n') || undefined
        : [keep.notes, gone.notes].filter(Boolean).join('\n') || undefined,
      // Removing a step also removes any pause between it and its neighbour.
      pauseAfter: at === 0 ? keep.pauseAfter : gone.pauseAfter,
    };
  }
  return withSteps(p, m, steps);
}

/** Update a step's editorial details. Empty text removes optional metadata. */
export function updateStep(p: Plan, m: ModelName, at: number, fields: Pick<Step, 'title' | 'notes' | 'pauseAfter'>): Plan {
  const steps = [...modelSteps(p, m)];
  if (!steps[at]) return p;
  const title = fields.title?.trim().slice(0, 80) || undefined;
  const notes = fields.notes?.trim().slice(0, 1000) || undefined;
  const pauseAfter = Number.isFinite(fields.pauseAfter)
    ? Math.round(Math.min(10, Math.max(0, fields.pauseAfter ?? 0)) * 10) / 10
    : 0;
  const previous = steps[at];
  const next = { ...previous, title, notes, pauseAfter: pauseAfter || undefined };
  if (previous.title === next.title && previous.notes === next.notes && previous.pauseAfter === next.pauseAfter) return p;
  steps[at] = next;
  return withSteps(p, m, steps);
}

/** Reorder one piece inside its step (the build plays in the new order). */
export function reorderItemInStep(p: Plan, m: ModelName, at: number, from: number, to: number): Plan {
  const steps = [...modelSteps(p, m)];
  const step = steps[at];
  if (!step || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= step.pieces.length || to >= step.pieces.length || from === to) return p;
  const pieces = [...step.pieces];
  const [item] = pieces.splice(from, 1);
  pieces.splice(to, 0, item);
  steps[at] = { ...step, pieces };
  return withSteps(p, m, steps);
}

/** Split into this step and the step after it; select ids to choose the moved pieces,
 * or automatically split at the midpoint. No part is duplicated or repositioned. */
export function splitStep(p: Plan, m: ModelName, at: number, selectedIds: string[] = []): Plan {
  const steps = [...modelSteps(p, m)];
  const step = steps[at];
  if (!step || step.pieces.length < 2) return p;
  const selected = new Set(selectedIds);
  let earlier: PlanItem[] = [];
  let later: PlanItem[] = [];
  if (selected.size) {
    earlier = step.pieces.filter((i) => !i.id || !selected.has(i.id));
    later = step.pieces.filter((i) => i.id && selected.has(i.id));
  }
  if (!earlier.length || !later.length) {
    const mid = Math.ceil(step.pieces.length / 2);
    earlier = step.pieces.slice(0, mid);
    later = step.pieces.slice(mid);
  }
  // Keep the pause after the entire original step, not halfway through it.
  steps.splice(at, 1, { ...step, pieces: earlier, pauseAfter: undefined }, { pieces: later, pauseAfter: step.pauseAfter });
  return withSteps(p, m, steps);
}

/** Join two consecutive steps, retaining their parts and both sets of notes. */
export function mergeSteps(p: Plan, m: ModelName, first: number): Plan {
  const steps = [...modelSteps(p, m)];
  if (!steps[first] || !steps[first + 1]) return p;
  const a = steps[first], b = steps[first + 1];
  steps.splice(first, 2, {
    ...a,
    pieces: [...a.pieces, ...b.pieces],
    title: a.title || b.title,
    notes: [a.notes, b.notes].filter(Boolean).join('\n') || undefined,
    pauseAfter: b.pauseAfter,
  });
  return withSteps(p, m, steps);
}

export function findItem(p: Plan, m: ModelName, id: string): { item: PlanItem; step: number } | null {
  const steps = modelSteps(p, m);
  for (let s = 0; s < steps.length; s++) {
    const item = steps[s].pieces.find((i) => i.id === id);
    if (item) return { item, step: s };
  }
  return null;
}

/** Copies items into the same step, each right after its original, shifted by `d` (studs, plates); returns the copies' ids. */
export function duplicateItems(
  p: Plan,
  m: ModelName,
  ids: string[],
  newId: () => string,
  d: { x: number; y: number; z: number },
): { plan: Plan; ids: string[] } {
  const set = new Set(ids);
  const copies: string[] = [];
  const steps = modelSteps(p, m).map((s) =>
    s.pieces.some((i) => i.id && set.has(i.id))
      ? {
          ...s,
          pieces: s.pieces.flatMap((i) => {
            if (!i.id || !set.has(i.id)) return [i];
            const id = newId();
            copies.push(id);
            return [i, { ...i, id }];
          }),
        }
      : s,
  );
  return { plan: moveItems(withSteps(p, m, steps), m, copies, d), ids: copies };
}
