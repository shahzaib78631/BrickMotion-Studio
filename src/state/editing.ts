import type { Box } from '../ldraw/flatten';
import { assemble, transformBox, placementMatrix, type Assembly } from '../model/assemble';
import { newId } from '../plan/ids';
import { addItem, deleteItems, findItem, modelSteps, moveItems, rotateItems, type ModelName } from '../plan/ops';
import { gridToPlacement } from '../plan/placement';
import { isGrid, isSub, type Grid, type Plan, type PlanItem } from '../plan/types';
import type { Command } from './keymap';
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
export async function addPart(part: string): Promise<void> {
  await ensureParts([part]);
  const st = useStudio.getState();
  const { plan, editingModel, currentStep, paintColor } = st;
  const view = assemble({ ...plan, steps: modelSteps(plan, editingModel) }, metricsOf, getColors());
  const spot = findFreeSpot(view, metricsOf(part).body);
  const id = newId(plan);
  const steps = modelSteps(plan, editingModel);
  const step = currentStep ?? Math.max(0, steps.length - 1);
  st.apply((p) => addItem(p, editingModel, steps.length === 0 ? 0 : step, { id, part, color: paintColor, ...spot }));
  st.select([id]);
}

export function runCommand(cmd: Command): void {
  const st = useStudio.getState();
  const { selection, editingModel } = st;
  if (cmd.kind === 'undo') return st.undo();
  if (cmd.kind === 'redo') return st.redo();
  const ids = selection.model === editingModel ? selection.ids : [];
  if (!ids.length) return;
  const m: ModelName = editingModel;
  if (cmd.kind === 'move') st.apply((p) => moveItems(p, m, ids, cmd.d));
  else if (cmd.kind === 'rotate') st.apply((p) => rotateItems(p, m, ids, footprintFor(p), bodyFor(p)));
  else if (cmd.kind === 'delete') {
    st.apply((p) => deleteItems(p, m, ids));
    st.select([]);
  }
}

export function selectedItems(): PlanItem[] {
  const { plan, selection } = useStudio.getState();
  return selection.ids.map((id) => findItem(plan, selection.model, id)?.item).filter((x): x is PlanItem => !!x);
}
