/** Moving parts between models — the one operation the step-editing ops cannot do.
 *
 * A model's steps are written in that model's own space and placed by uses; a piece
 * therefore has to be re-expressed in the destination's frame or it would jump. The
 * transform is composed through the model frames (`modelFrames`), so a moved part
 * keeps its position in the main model — dropping it into a submodel leaves the
 * scene looking the same.
 *
 * Sibling reference ids (`attachTo`/`after`) are scoped to their containing model
 * (`src/plan/types.ts:13`), so they are repaired here exactly as `createSubmodel`
 * does; a reference that cannot be repaired refuses the move instead of silently
 * producing an unbuildable order.
 */
import type { Box } from '../ldraw/flatten';
import type { Vec3 } from '../ldraw/parse';
import type { Assembly } from '../model/assemble';
import type { ANode } from '../model/assemblyTypes';
import { modelFrames, modelNodes } from './modelFrames';
import { idFactory } from './ids';
import { findItem, modelSteps, type ModelName } from './ops';
import { composePlacement, invertPlacement, placementToGrid, tidyPlacement, type Placement } from './placement';
import { isGrid, isSub, type AssemblyHints, type Plan, type PlanItem, type Step } from './types';

export type CrossMove = {
  from: ModelName;
  to: ModelName;
  ids: string[];
  step: number;
  /** the exact use of the destination that the drop targeted, when there is more than one */
  viaUse?: string;
};
export type CrossResult = { plan: Plan; moved: string[]; step: number } | { error: string };

const capped = (model: string) => model || 'the main model';
const failed = (error: string): CrossResult => ({ error });
const names = (items: PlanItem[]) =>
  items.slice(0, 4).map((i) => i.id ?? 'a piece').join(', ') + (items.length > 4 ? ` and ${items.length - 4} more` : '');

function writeSteps(plan: Plan, model: ModelName, steps: Step[]): Plan {
  if (model === '') return { ...plan, steps };
  return { ...plan, submodels: { ...plan.submodels, [model]: { ...plan.submodels![model], steps } } };
}

/** A composed pose back into plan coordinates: grid when it lands on the grid, raw otherwise. */
function placeItem(item: PlanItem, pose: Placement, body: Box): PlanItem {
  const out = { ...item } as Record<string, unknown>;
  for (const key of ['x', 'y', 'z', 'rot', 'ldu', 'matrix']) delete out[key];
  const tidy = tidyPlacement(pose);
  const grid = placementToGrid(tidy, body);
  return (grid ? { ...out, ...grid } : { ...out, ldu: tidy.pos, matrix: tidy.m }) as PlanItem;
}

/** Drop sibling references that would now point into another model; keep the ones moving too. */
function repairHints(item: PlanItem, moving: ReadonlySet<string>, rel: Placement): PlanItem {
  const hints: AssemblyHints = { ...item.assembly };
  if (hints.attachTo && !moving.has(hints.attachTo)) delete hints.attachTo;
  if (hints.after) {
    const after = hints.after.filter((id) => moving.has(id) && id !== item.id);
    if (after.length) hints.after = after;
    else delete hints.after;
  }
  // A build spot is absolute in the main model's unmoved frame, and an insertion
  // axis is written in the containing model's frame: neither survives a new model.
  delete hints.buildSpot;
  if (hints.insertionAxis) {
    const [x, y, z] = hints.insertionAxis;
    const m = rel.m;
    const axis: Vec3 = [
      m[0] * x + m[1] * y + m[2] * z,
      m[3] * x + m[4] * y + m[5] * z,
      m[6] * x + m[7] * y + m[8] * z,
    ];
    const length = Math.hypot(...axis);
    if (length > 1e-6) hints.insertionAxis = axis.map((v) => v / length) as Vec3;
    else delete hints.insertionAxis;
  }
  const out = { ...item } as PlanItem;
  if (Object.keys(hints).length) out.assembly = hints;
  else delete out.assembly;
  return out;
}

/**
 * Items that now exist twice — an extracted copy next to the submodel definition that still
 * owns the original — need their own ids. Sharing one id makes two visible leaves with the
 * same key, which the build graph refuses with "Duplicate visible leaf". Sibling references
 * that move with them are remapped, so the order they express survives.
 */
function freshCopies(items: PlanItem[], plan: Plan): { items: PlanItem[]; ids: string[] } {
  const nextId = idFactory(plan);
  const renamed = new Map<string, string>();
  for (const item of items) if (item.id) renamed.set(item.id, nextId());
  const out = items.map((item) => {
    const hints: AssemblyHints = { ...item.assembly };
    if (hints.attachTo) {
      const to = renamed.get(hints.attachTo);
      if (to) hints.attachTo = to;
      else delete hints.attachTo;
    }
    if (hints.after) {
      const after = [...new Set(hints.after.flatMap((id) => (renamed.get(id) ? [renamed.get(id)!] : [])))];
      if (after.length) hints.after = after;
      else delete hints.after;
    }
    const copy = { ...item } as PlanItem;
    const id = item.id ? renamed.get(item.id) : undefined;
    if (id) copy.id = id;
    if (Object.keys(hints).length) copy.assembly = hints;
    else delete copy.assembly;
    return copy;
  });
  return { items: out, ids: out.flatMap((item) => (item.id ? [item.id] : [])) };
}

/**
 * Moves parts into another model, appending them to step `move.step` there.
 * Refuses when a frame is unknown or when a piece left behind depends on the
 * selection; those are the only two cases that cannot be represented.
 */
export function movePartsToModel(plan: Plan, assembly: Assembly, move: CrossMove): CrossResult {
  const ids = [...new Set(move.ids)].filter(Boolean);
  if (!ids.length) return failed('Select at least one part to move.');
  if (move.from === move.to) return failed('Those parts are already in that model.');
  const moving = new Set(ids);
  const frames = modelFrames(assembly);
  const from = frames.get(move.from);
  // A submodel used more than once has one stored definition but several frames: a
  // drop onto a specific use row must follow that use, not the first one in the set.
  const chosen = move.viaUse
    ? usesOf(assembly, new Set([move.to])).find((use) => use.node.itemId === move.viaUse)
    : undefined;
  const parent = chosen ? frames.get(chosen.model) : undefined;
  const to = chosen && parent
    ? { placement: composePlacement(parent.placement, chosen.node.local), uses: 1 }
    : frames.get(move.to);
  if (!from) return failed(`${capped(move.from)} is not placed in this set, so it has no frame to move parts from.`);
  if (!to) return failed(`${capped(move.to)} is not placed in this set, so it has no frame to move parts into.`);
  const inverse = invertPlacement(to.placement);
  if (!inverse) return failed(`${capped(move.to)} has a non-rigid placement, so parts cannot be moved into it.`);
  const rel = composePlacement(inverse, from.placement);

  const before = modelSteps(plan, move.from);
  // A piece left behind that waits for a moved piece would keep a sibling reference
  // across models, which the build graph rejects (`missing-parent`). Never drop it
  // silently — the order it expresses would be lost.
  const stranded = before.flatMap((step) => step.pieces).filter((item) =>
    item.id && !moving.has(item.id) &&
    ((item.assembly?.attachTo && moving.has(item.assembly.attachTo)) ||
      (item.assembly?.after ?? []).some((id) => moving.has(id))));
  if (stranded.length)
    return failed(`${names(stranded)} in ${capped(move.from)} depend on the selection. Move ${stranded.length === 1 ? 'it' : 'them'} too, or clear that dependency first.`);

  const nodeById = new Map(modelNodes(assembly, move.from).map((node) => [node.itemId, node]));
  const placed: PlanItem[] = [];
  for (const step of before) for (const item of step.pieces) {
    if (!item.id || !moving.has(item.id)) continue;
    const node = nodeById.get(item.id);
    if (!node) return failed(`${item.id} is not placed in ${capped(move.from)}, so its transform is unknown.`);
    placed.push(placeItem(repairHints(item, moving, rel), composePlacement(rel, node.local), node.body));
  }
  if (placed.length !== ids.length)
    return failed('Some selected parts could not be resolved. Reopen the model and try again.');

  // Remove from the source, dropping a step the move empties (as movePiecesToStep does).
  const stripped = before.map((step) => ({ ...step, pieces: step.pieces.filter((i) => !(i.id && moving.has(i.id))) }));
  const kept = stripped.filter((step, i) => step.pieces.length > 0 || before[i].pieces.length === 0);
  // Append to the destination step, creating it when the drop lands past the end.
  const destination = [...modelSteps(plan, move.to)];
  const target = Math.max(0, Math.min(destination.length, Math.round(move.step)));
  while (destination.length <= target) destination.push({ pieces: [] });
  destination[target] = { ...destination[target], pieces: [...destination[target].pieces, ...placed] };

  const next = pinUses(writeSteps(writeSteps(plan, move.from, kept), move.to, destination),
    assembly, new Set([move.from, move.to]));
  return { plan: next, moved: ids, step: target };
}

const usesSubmodel = (plan: Plan, name: string) =>
  ['', ...Object.keys(plan.submodels ?? {})].some((model) =>
    modelSteps(plan, model).some((step) => step.pieces.some((item) => isSub(item) && item.submodel === name)));

/** Every assembled use of the given submodels, with the model that contains it. */
function usesOf(assembly: Assembly, models: ReadonlySet<string>): { model: string; node: Extract<ANode, { kind: 'sub' }> }[] {
  const out: { model: string; node: Extract<ANode, { kind: 'sub' }> }[] = [];
  const walk = (nodes: ANode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'sub') continue;
      if (models.has(node.submodel)) out.push({ model: node.model, node });
      walk(node.children);
    }
  };
  walk(assembly.nodes);
  return out;
}

/**
 * A *grid* use takes its placement from the submodel's own body box
 * (`gridToPlacement`), so adding or removing parts would shift that use — and with
 * it every part still inside — while the parts crossing the boundary were placed
 * against the old frame. Freezing each affected use at the pose it already has
 * makes the frame independent of the content, which is what `createSubmodel` does
 * for the reference it mints. Uses that are already raw are untouched.
 */
function pinUses(plan: Plan, assembly: Assembly, models: ReadonlySet<string>): Plan {
  let next = plan;
  for (const { model, node } of usesOf(assembly, models)) {
    const located = findItem(next, model, node.itemId);
    if (!located || !isGrid(located.item)) continue;
    const raw = { ...located.item } as Record<string, unknown>;
    for (const key of ['x', 'y', 'z', 'rot']) delete raw[key];
    const pinned = { ...raw, ldu: node.local.pos, matrix: node.local.m } as PlanItem;
    const steps = modelSteps(next, model).map((step) => ({
      ...step,
      pieces: step.pieces.map((item) => (item.id === node.itemId ? pinned : item)),
    }));
    next = writeSteps(next, model, steps);
  }
  return next;
}

/**
 * Replaces one submodel use with its parts, in place, keeping every part where it
 * appears. A definition that nothing uses afterwards is removed.
 */
export function inlineSubmodelUse(plan: Plan, assembly: Assembly, model: ModelName, useId: string): CrossResult {
  const located = findItem(plan, model, useId);
  if (!located || !isSub(located.item)) return failed('That submodel use no longer exists.');
  const sub = located.item.submodel;
  if (sub === model) return failed('A submodel cannot be extracted into itself.');
  if (!plan.submodels?.[sub]) return failed(`Submodel "${sub}" was not found.`);
  const node = modelNodes(assembly, model).find((n) => n.itemId === useId);
  if (!node || node.kind !== 'sub') return failed('That submodel use is not placed, so its transform is unknown.');

  const children: ANode[] = [...node.children].sort((a, b) => a.step - b.step || a.order - b.order);
  const inside = new Set(children.map((child) => child.itemId));
  const placed: PlanItem[] = [];
  for (const child of children) {
    const item = findItem(plan, sub, child.itemId)?.item;
    if (!item) continue;
    placed.push(placeItem(repairHints(item, inside, node.local), composePlacement(node.local, child.local), child.body));
  }
  if (!placed.length) return failed(`Submodel "${sub}" has no parts to extract.`);
  // The definition keeps its own items, so the copies taken out of it cannot keep their ids.
  const copies = freshCopies(placed, plan);
  const firstPiece = copies.items.find((item) => item.id)?.id;
  const pieceIds = copies.ids;

  /** References to the use must follow the parts that replaced it. */
  const remap = (item: PlanItem): PlanItem => {
    const hints = item.assembly;
    if (!hints) return item;
    const next: AssemblyHints = { ...hints };
    if (next.attachTo === useId) {
      if (firstPiece) next.attachTo = firstPiece;
      else delete next.attachTo;
    }
    if (next.after?.includes(useId)) {
      const after = [...new Set(next.after.flatMap((id) => (id === useId ? pieceIds : [id])))].filter((id) => id !== item.id);
      if (after.length) next.after = after;
      else delete next.after;
    }
    return { ...item, assembly: next };
  };

  const steps = modelSteps(plan, model).map((step, index) => {
    if (index !== located.step) return { ...step, pieces: step.pieces.map(remap) };
    const at = step.pieces.findIndex((item) => item.id === useId);
    if (at < 0) return step;
    return {
      ...step,
      pieces: [...step.pieces.slice(0, at), ...copies.items, ...step.pieces.slice(at + 1)].map(remap),
    };
  });

  let next = writeSteps(plan, model, steps);
  if (next.submodels?.[sub] && !usesSubmodel(next, sub)) {
    const submodels = { ...next.submodels };
    delete submodels[sub];
    next = { ...next, submodels: Object.keys(submodels).length ? submodels : undefined };
  }
  return { plan: next, moved: pieceIds, step: located.step };
}
