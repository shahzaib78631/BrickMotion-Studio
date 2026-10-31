import type { Box } from '../ldraw/flatten';
import { assemble, transformBox, placementMatrix, type Assembly, type Instance } from '../model/assemble';
import { newId } from '../plan/ids';
import { addItem, deleteItems, duplicateItems, findItem, modelSteps, moveItems, rotateItems, type ModelName, insertItem } from '../plan/ops';
import { gridToPlacement } from '../plan/placement';
import { isGrid, isSub, type Grid, type Plan, type PlanItem } from '../plan/types';
import { studSnapper, type SnapPart, type StudSnapper } from '../plan/studSnap';
import type { Command } from './keymap';
import { useAppSettings } from './appSettings';
import { beginPlacing, cancelPlacing, commitPlacing, updatePlacing } from './placing';
import { floorAim } from '../plan/aim';
import { clipFromLDraw, clipToLDraw, copyItems, mergeSubmodels, type Clip } from '../plan/clipboard';
import { viewportApi } from '../ui/viewportApi';
import { guardEdit, guardedApply } from './guard';

/** How far (plates, or studs for a duplicate) a blocked edit looks for a clean spot. */
const RETRY_PLATES = 12;
import { ensureParts, getColors, metricsOf } from './partService';
import { useStudio } from './store';

const PLACEHOLDER: Box = { min: [0, -24, 0], max: [20, 0, 20] };

function subBounds(plan: Plan, name: string): Box {
  return assemble({ ...plan, steps: modelSteps(plan, name) }, metricsOf, getColors()).bounds ?? PLACEHOLDER;
}

export const bodyFor =
  (plan: Plan) =>
  (item: PlanItem): Box =>
    isSub(item) ? subBounds(plan, item.submodel) : metricsOf(item.part).body;

export const footprintFor = (plan: Plan) => (item: PlanItem) => {
  const b = bodyFor(plan)(item);
  const w = Math.max(1, Math.round((b.max[0] - b.min[0]) / 20));
  const d = Math.max(1, Math.round((b.max[2] - b.min[2]) / 20));
  return isGrid(item) && item.rot % 180 !== 0 ? { w: d, d: w } : { w, d };
};

function overlaps(a: Box, b: Box): boolean {
  return [0, 1, 2].every((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]) > 1);
}

/** Nearest free grid spot on the floor, spiralling out from the model centre. */
export function findFreeSpot(view: Assembly, body: Box): Grid {
  const g0 = { x: 0, y: 0, z: 0, rot: 0 as const };
  const fp = { w: Math.max(1, Math.round((body.max[0] - body.min[0]) / 20)), d: Math.max(1, Math.round((body.max[2] - body.min[2]) / 20)) };
  const b = view.bounds;
  const cx = b ? Math.round((b.min[0] + b.max[0]) / 40 - fp.w / 2) : 0;
  const cz = b ? Math.round((b.min[2] + b.max[2]) / 40 - fp.d / 2) : 0;
  const boxes = view.instances.map((i) => i.worldBox);
  for (let r = 0; r <= 40; r++) {
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const g = { ...g0, x: cx + dx, z: cz + dz };
        const wb = transformBox(body, placementMatrix(gridToPlacement(g, body)));
        if (!boxes.some((o) => overlaps(o, wb))) return g;
      }
  }
  return { ...g0, x: cx, z: cz };
}

/** Adds a part to the current step (or a new last step) at a free spot and selects it. */
/**
 * Adds a part in the paint colour at a free spot. It lands in the current step (or the
 * last one), or exactly where `at` says: a step and an arrival position in it, e.g. where
 * it was dropped on the timeline.
 */
export async function addPart(part: string, at?: { step: number; index: number }): Promise<void> {
  await ensureParts([part]);
  const st = useStudio.getState();
  const { plan, editingModel, currentStep, paintColor } = st;
  const view = assemble({ ...plan, steps: modelSteps(plan, editingModel) }, metricsOf, getColors());
  const spot = findFreeSpot(view, metricsOf(part).body);
  const id = newId(plan);
  const steps = modelSteps(plan, editingModel);
  const item = { id, part, color: paintColor, ...spot };
  if (at) st.apply((p) => insertItem(p, editingModel, at.step, item, at.index));
  else {
    const step = currentStep ?? Math.max(0, steps.length - 1);
    st.apply((p) => addItem(p, editingModel, steps.length === 0 ? 0 : step, item));
  }
  st.select([id]);
}

/** A move's stud snapper: the selected items' parts against every other part (LDraw frame). */
export function snapperFor(instances: readonly Instance[], ids: readonly string[]): StudSnapper {
  const chosen = new Set(ids);
  const moving: SnapPart[] = [], others: SnapPart[] = [];
  for (const inst of instances) {
    if (inst.placeholder) continue;
    const m = metricsOf(inst.part);
    (chosen.has(inst.key.split('/')[0]) ? moving : others).push({ world: inst.world.elements, body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh });
  }
  return studSnapper(moving, others);
}

/**
 * A sideways selection (studs pointing along X or Z) sits on stud rows a stud apart
 * vertically, so a plate-sized nudge can never land it. Raise/Lower then step one stud
 * row, and every nudge seats the parts onto the studs it reaches. Upright parts are unchanged.
 */
function sidewaysMove(plan: Plan, m: ModelName, ids: readonly string[], d: { x: number; y: number; z: number }) {
  const view = assemble({ ...plan, steps: modelSteps(plan, m) }, metricsOf, getColors());
  const snap = snapperFor(view.instances, ids);
  return snap.sideways ? snap({ x: d.x, z: d.z, y: Math.sign(d.y) }) : null;
}

let lastClip: Clip | null = null;
let lastText = '';

/** Starts placing copied pieces: they follow the mouse in the view, or land beside the model. */
async function placeClip(clip: Clip): Promise<void> {
  const parts = [...clip.items, ...Object.values(clip.submodels).flatMap((s) => s.steps.flatMap((x) => x.pieces))]
    .flatMap((i) => ('part' in i ? [i.part] : []));
  await ensureParts(parts);
  const st = useStudio.getState();
  const m = st.editingModel;
  const merged = mergeSubmodels(st.plan, clip).clip;
  beginPlacing({ kind: 'new', model: m, items: merged.items, submodels: merged.submodels });
  if (viewportApi.pointerInside && viewportApi.placeAtPointer) return viewportApi.placeAtPointer();
  // the mouse is elsewhere: put it on the floor just past the model, like Duplicate
  const view = assemble({ ...st.plan, steps: modelSteps(st.plan, m) }, metricsOf, getColors());
  const b = view.bounds;
  for (let k = 0; k <= RETRY_PLATES; k++) {
    const pose = updatePlacing(floorAim([(b ? b.max[0] : 0) + 40 + k * 20, b?.max[1] ?? 0, b ? (b.min[2] + b.max[2]) / 2 : 0]));
    if (pose?.valid) { commitPlacing(); return; }
  }
  cancelPlacing();
}

async function pasteClip(): Promise<void> {
  const text = await navigator.clipboard?.readText?.().catch(() => null) ?? null;
  const clip = text && text !== lastText ? clipFromLDraw(text) ?? lastClip : lastClip;
  if (clip) await placeClip(clip);
}

export function runCommand(cmd: Command): void {
  const st = useStudio.getState();
  const { selection, editingModel } = st;
  if (cmd.kind === 'paste') return void pasteClip();
  if (cmd.kind === 'undo') return st.undo();
  if (cmd.kind === 'redo') return st.redo();
  if (cmd.kind === 'tool') return st.setTool(cmd.tool);
  if (cmd.kind === 'collision') {
    const a = useAppSettings.getState();
    return a.set({ collision: !a.collision });
  }
  const ids = selection.model === editingModel ? selection.ids : [];
  if (!ids.length) return;
  const m: ModelName = editingModel;
  if (cmd.kind === 'move') {
    const step = (p: Plan, d: { x: number; y: number; z: number }) => {
      const seated = sidewaysMove(p, m, ids, d);
      return seated ? moveItems(p, m, ids, seated, bodyFor(p)) : moveItems(p, m, ids, d);
    };
    // Raise / Lower into a piece keep going the same way to the first clean height
    // (E on a plate under a brick pops it up on top). Sideways moves are refused.
    const vertical = cmd.d.x === 0 && cmd.d.z === 0 && cmd.d.y !== 0;
    const retry = vertical ? (p: Plan) => {
      for (let n = Math.abs(cmd.d.y) + 1; n <= RETRY_PLATES; n++) {
        const next = step(p, { x: 0, y: Math.sign(cmd.d.y) * n, z: 0 });
        if (guardEdit(p, next, m, ids)) return next;
      }
      return null;
    } : undefined;
    guardedApply(m, ids, (p) => step(p, cmd.d), retry);
  } else if (cmd.kind === 'rotate') guardedApply(m, ids, (p) => rotateItems(p, m, ids, footprintFor(p), bodyFor(p)));
  else if (cmd.kind === 'duplicate') {
    // the copy goes right beside the selection (+X), so it is easy to see and drag;
    // when that spot is taken it steps further out until it is clear
    const view = assemble({ ...st.plan, steps: modelSteps(st.plan, m) }, metricsOf, getColors());
    const set = new Set(ids);
    const boxes = view.instances.filter((i) => set.has(i.key.split('/')[0])).map((i) => i.worldBox);
    const w = boxes.length ? Math.max(1, Math.ceil((Math.max(...boxes.map((b) => b.max[0])) - Math.min(...boxes.map((b) => b.min[0]))) / 20 - 1e-6)) : 1;
    const plan = st.plan;
    const taken = new Set<string>();
    const fresh = () => {
      let id = newId(plan);
      while (taken.has(id)) id = newId(plan);
      taken.add(id);
      return id;
    };
    for (let k = 0; k <= RETRY_PLATES; k++) {
      taken.clear();
      const r = duplicateItems(plan, m, ids, fresh, { x: w + k, y: 0, z: 0 });
      if (!guardEdit(plan, r.plan, m, r.ids)) continue;
      st.apply(() => r.plan);
      st.select(r.ids);
      return;
    }
    st.flashBlocked(ids);
  } else if (cmd.kind === 'copy' || cmd.kind === 'cut') {
    lastClip = copyItems(st.plan, m, ids);
    lastText = clipToLDraw(lastClip, metricsOf, getColors());
    void navigator.clipboard?.writeText?.(lastText).catch(() => {});
    if (cmd.kind === 'cut') {
      st.apply((p) => deleteItems(p, m, ids));
      st.select([]);
    }
  } else if (cmd.kind === 'clone') {
    void placeClip(copyItems(st.plan, m, ids));
  } else if (cmd.kind === 'delete') {
    st.apply((p) => deleteItems(p, m, ids));
    st.select([]);
  }
}

export function selectedItems(): PlanItem[] {
  const { plan, selection } = useStudio.getState();
  return selection.ids.map((id) => findItem(plan, selection.model, id)?.item).filter((x): x is PlanItem => !!x);
}

/**
 * Whole-stud/plate move that puts the model's footprint centre on the origin and
 * its lowest point on the floor (LDraw y = 0). Null when it is already there.
 */
export function floorCentreOffset(bounds: Box | null): { x: number; y: number; z: number } | null {
  if (!bounds) return null;
  const d = {
    x: -Math.round((bounds.min[0] + bounds.max[0]) / 2 / 20),
    y: Math.round(bounds.max[1] / 8),
    z: -Math.round((bounds.min[2] + bounds.max[2]) / 2 / 20),
  };
  return d.x || d.y || d.z ? d : null;
}

/** Centre the open model on the floor: one undoable move of every top-level piece. */
export function centreModelOnFloor(): boolean {
  const st = useStudio.getState();
  const m: ModelName = st.editingModel;
  const view = assemble({ ...st.plan, steps: modelSteps(st.plan, m) }, metricsOf, getColors());
  const d = floorCentreOffset(view.bounds);
  if (!d) return false;
  const ids = modelSteps(st.plan, m).flatMap((s) => s.pieces.map((i) => i.id).filter((x): x is string => !!x));
  if (!ids.length) return false;
  st.apply((p) => moveItems(p, m, ids, d));
  return true;
}
