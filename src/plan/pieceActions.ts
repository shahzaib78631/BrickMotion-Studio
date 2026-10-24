import type { ColorDef } from '../ldraw/colors';
import type { Box } from '../ldraw/flatten';
import { assemble, placementMatrix, transformBox, type Metrics } from '../model/assemble';
import { CARRIER_RATIO, footprint, touching } from './components';
import { findItem, insertStep, modelSteps, moveItemsToStep, type ModelName } from './ops';
import { isSub, type AssemblySpot, type Plan, type PlanItem, type Step } from './types';

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

/**
 * Moves where a piece waits on the floor before it flies in, by whole studs (LDraw
 * x and z). `path` is the piece's key in `m` ("sub/piece" for a piece of a
 * submodel): the offset is stored on its item in the submodel itself, so every
 * copy of that submodel lays the piece out the same way. Null if it is not found.
 */
export function shiftOnFloor(p: Plan, m: ModelName, path: string, d: [number, number]): Plan | null {
  const segs = path.split('/');
  let model = m;
  for (const seg of segs.slice(0, -1)) {
    const found = findItem(p, model, seg);
    if (!found || !isSub(found.item)) return null;
    model = found.item.submodel;
  }
  const id = segs[segs.length - 1];
  if (!findItem(p, model, id)) return null;
  const steps = modelSteps(p, model).map((s) => (!s.pieces.some((i) => i.id === id) ? s : {
    ...s,
    pieces: s.pieces.map((i) => {
      if (i.id !== id) return i;
      const old = i.assembly?.floorShift ?? [0, 0];
      const next: [number, number] = [old[0] + d[0], old[1] + d[1]];
      const { floorShift: _, ...rest } = i.assembly ?? {};
      const assembly = next[0] || next[1] ? { ...rest, floorShift: next } : rest;
      const out = { ...i, assembly } as PlanItem;
      if (!Object.keys(assembly).length) delete out.assembly;
      return out;
    }),
  }));
  return model === '' ? { ...p, steps } : { ...p, submodels: { ...p.submodels, [model]: { ...p.submodels![model], steps } } };
}

/** Puts every piece of a model (and its submodels) back where the automatic floor layout puts it. */
export function resetFloorShifts(p: Plan): Plan {
  const clear = (steps: Step[]) => steps.map((s) => (!s.pieces.some((i) => i.assembly?.floorShift) ? s : {
    ...s,
    pieces: s.pieces.map((i) => {
      if (!i.assembly?.floorShift) return i;
      const { floorShift: _, ...rest } = i.assembly;
      const out = { ...i, assembly: rest } as PlanItem;
      if (!Object.keys(rest).length) delete out.assembly;
      return out;
    }),
  }));
  return { ...p, steps: clear(p.steps), ...(p.submodels ? { submodels: Object.fromEntries(Object.entries(p.submodels).map(([k, v]) => [k, { ...v, steps: clear(v.steps) }])) } : {}) };
}

/** Every dragged waiting spot in a model and the submodels it uses, by piece key ("sub/piece"). */
export function floorShiftsByKey(p: Plan, m: ModelName): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const walk = (model: string, prefix: string, depth: number) => {
    if (depth > 16) return;
    for (const s of modelSteps(p, model))
      for (const i of s.pieces) {
        if (!i.id) continue;
        if (isSub(i)) walk(i.submodel, `${prefix}${i.id}/`, depth + 1);
        else if (i.assembly?.floorShift) out.set(prefix + i.id, i.assembly.floorShift);
      }
  };
  walk(m, '', 0);
  return out;
}

/**
 * The main model's assembly spot (floor position in studs and facing in degrees), or
 * null for Auto. Changing it re-applies the rigid transform `S` to the timeline; with
 * "loose pieces follow" on it is not part of the planning cache key, so the build is
 * not planned again.
 */
function safeSpot(spot: AssemblySpot | null): void {
  if (spot && (![spot.x, spot.z, spot.angle].every(Number.isFinite)))
    throw new RangeError('Assembly spot coordinates and angle must be finite numbers.');
}
const equalSpot = (a: AssemblySpot | undefined, b: AssemblySpot | null) =>
  (!a && !b) || (!!a && !!b && a.x === b.x && a.z === b.z && a.angle === b.angle);

export function setAssemblySpot(p: Plan, spot: AssemblySpot | null): Plan {
  safeSpot(spot);
  if (equalSpot(p.assemblySpot, spot)) return p;
  if (spot === null) {
    const { assemblySpot: _, ...rest } = p;
    return rest as Plan;
  }
  return { ...p, assemblySpot: spot };
}

/** Whether the loose floor layout moves and turns with the main spot. On is the default (no key). */
export function setLoosePiecesFollow(p: Plan, loosePiecesFollow: boolean): Plan {
  if ((p.loosePiecesFollow !== false) === loosePiecesFollow) return p;
  if (loosePiecesFollow) {
    const { loosePiecesFollow: _, ...rest } = p;
    return rest as Plan;
  }
  return { ...p, loosePiecesFollow: false };
}

/**
 * The build spot of one submodel use, or null for Auto. Stored on the SubItem, so it
 * applies to every copy of the submodel that contains it, like `floorShift`.
 */
export function setSubmodelBuildSpot(p: Plan, modelName: ModelName, subId: string, spot: AssemblySpot | null): Plan {
  safeSpot(spot);
  const item = modelSteps(p, modelName).flatMap(s => s.pieces).find(i => isSub(i) && i.id === subId);
  if (!item || !isSub(item) || equalSpot(item.assembly?.buildSpot, spot)) return p;
  const steps = modelSteps(p, modelName).map((s) => (!s.pieces.some((i) => isSub(i) && i.id === subId) ? s : {
    ...s,
    pieces: s.pieces.map((i) => {
      if (!isSub(i) || i.id !== subId) return i;
      if (spot === null) {
        const { buildSpot: _, ...rest } = i.assembly ?? {};
        const out = { ...i, assembly: { ...rest } } as PlanItem;
        if (!Object.keys(rest).length) delete out.assembly;
        return out;
      }
      return { ...i, assembly: { ...(i.assembly ?? {}), buildSpot: spot } } as PlanItem;
    }),
  }));
  return modelName === '' ? { ...p, steps } : { ...p, submodels: { ...(p.submodels ?? {}), [modelName]: { ...(p.submodels?.[modelName] ?? { steps: [] }), steps } } };
}
