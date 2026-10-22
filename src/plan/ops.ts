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
    s.pieces.some((i) => i.id && set.has(i.id)) ? { pieces: s.pieces.map((i) => (i.id && set.has(i.id) ? fn(i) : i)) } : s,
  );
  return withSteps(p, m, steps);
}

export function moveItems(p: Plan, m: ModelName, ids: string[], d: { x: number; y: number; z: number }): Plan {
  return mapItems(p, m, ids, (i) =>
    isGrid(i)
      ? { ...i, x: i.x + d.x, y: i.y + d.y, z: i.z + d.z }
      : { ...i, ldu: [i.ldu[0] + 20 * d.x, i.ldu[1] - 8 * d.y, i.ldu[2] + 20 * d.z] as Vec3 },
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
  return withSteps(p, m, modelSteps(p, m).map((s) => ({ pieces: s.pieces.filter((i) => !(i.id && set.has(i.id))) })));
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
  else steps[step] = { pieces: [...steps[step].pieces, item] };
  return withSteps(p, m, steps);
}

export function moveItemsToStep(p: Plan, m: ModelName, ids: string[], step: number): Plan {
  const set = new Set(ids);
  const moving: PlanItem[] = [];
  const steps = modelSteps(p, m).map((s) => ({
    pieces: s.pieces.filter((i) => {
      if (i.id && set.has(i.id)) {
        moving.push(i);
        return false;
      }
      return true;
    }),
  }));
  while (steps.length <= step) steps.push({ pieces: [] });
  steps[step] = { pieces: [...steps[step].pieces, ...moving] };
  return withSteps(p, m, steps);
}

export function reorderStep(p: Plan, m: ModelName, from: number, to: number): Plan {
  const steps = [...modelSteps(p, m)];
  const [s] = steps.splice(from, 1);
  steps.splice(to, 0, s);
  return withSteps(p, m, steps);
}

export function insertStep(p: Plan, m: ModelName, at: number): Plan {
  const steps = [...modelSteps(p, m)];
  steps.splice(at, 0, { pieces: [] });
  return withSteps(p, m, steps);
}

/** Removes a step; its pieces join the previous step (or the next one when it is the first). */
export function deleteStep(p: Plan, m: ModelName, at: number): Plan {
  const steps = [...modelSteps(p, m)];
  const [gone] = steps.splice(at, 1);
  if (gone.pieces.length && steps.length) {
    const target = at === 0 ? 0 : at - 1;
    steps[target] = at === 0 ? { pieces: [...gone.pieces, ...steps[0].pieces] } : { pieces: [...steps[target].pieces, ...gone.pieces] };
  }
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
