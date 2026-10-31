import * as THREE from 'three';
import type { Box } from '../ldraw/flatten';
import type { Mat3, Vec3 } from '../ldraw/parse';
import { itemPlacement, placementMatrix, type ANode } from '../model/assemble';
import { LDU_TO_WORLD, WORLD_TO_LDU, transformPlanItems } from './gizmo';
import { addItem, findItem, moveItemsToStep, type ModelName } from './ops';
import { placementToGrid, type Placement } from './placement';
import type { Pose } from './placementEngine';
import type { Plan, PlanItem } from './types';

const nearZero = (v: number) => (Math.abs(v) < 1e-6 ? 0 : Math.round(v * 100000) / 100000);

/**
 * Writes a placement pose for pieces already in the plan. Whole-stud upright results stay
 * Grid items, anything else becomes an exact LDraw placement. A piece that now rests on a
 * piece from a later step moves to that step, so it never floats during the build.
 * `nodes` are the model's nodes from the start of the gesture; the pose is in the model's LDU frame.
 */
export function commitPose(plan: Plan, m: ModelName, ids: string[], nodes: ANode[], pose: Pose, stepOf: (owner: string) => number): Plan {
  const world = LDU_TO_WORLD.clone().multiply(new THREE.Matrix4().fromArray(pose.delta)).multiply(WORLD_TO_LDU);
  let out = transformPlanItems(plan, m, ids, nodes, world);
  if (!pose.owners.length) return out;
  const latest = Math.max(...pose.owners.map(stepOf));
  const late = ids.filter((id) => (findItem(out, m, id)?.step ?? latest) < latest);
  if (late.length) out = moveItemsToStep(out, m, late, latest);
  return out;
}

/** Adds new pieces (ids already set) to `step`, each moved from its own placement by the pose. */
export function addPosedItems(plan: Plan, m: ModelName, step: number, items: PlanItem[], pose: Pose, bodyOf: (item: PlanItem) => Box): Plan {
  const delta = new THREE.Matrix4().fromArray(pose.delta);
  let out = plan;
  for (const item of items) {
    const body = bodyOf(item);
    const e = delta.clone().multiply(placementMatrix(itemPlacement(item, body))).elements;
    const placed: Placement = {
      pos: [e[12], e[13], e[14]].map(nearZero) as Vec3,
      m: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]].map(nearZero) as Mat3,
    };
    const grid = placementToGrid(placed, body);
    const base: Record<string, unknown> = { ...item };
    for (const key of ['ldu', 'matrix', 'x', 'y', 'z', 'rot']) delete base[key];
    out = addItem(out, m, step, (grid ? { ...base, ...grid } : { ...base, ldu: placed.pos, matrix: placed.m }) as PlanItem);
  }
  return out;
}
