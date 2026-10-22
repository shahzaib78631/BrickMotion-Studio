import * as THREE from 'three';
import type { ANode } from '../model/assemble';
import { placementMatrix } from '../model/assemble';
import { placementToGrid, type Placement } from './placement';
import type { Mat3, Vec3 } from '../ldraw/parse';
import type { Plan } from './types';

/** LDraw X right, Y down, Z back; viewport X right, Y up, Z forward. */
const LDU_TO_WORLD = new THREE.Matrix4().makeScale(1 / 20, -1 / 20, -1 / 20);
const WORLD_TO_LDU = LDU_TO_WORLD.clone().invert();

const nearZero = (v: number) => Math.abs(v) < 1e-6 ? 0 : Math.round(v * 100000) / 100000;

/**
 * Apply a Blender-style world-space transform to selected LDraw placements.
 * Unchanged bricks remain on the stud grid whenever placementToGrid permits it;
 * arbitrary rotations and scaling use a standard LDraw raw matrix instead.
 * The nodes MUST be from the model at the beginning of the gesture, not a
 * progressively transformed frame (that would compound the movement).
 */
export function transformPlanItems(plan: Plan, model: string, ids: string[], nodes: ANode[], worldDelta: THREE.Matrix4): Plan {
  const chosen = new Set(ids);
  const originals = new Map(nodes.filter((node) => chosen.has(node.itemId)).map((node) => [node.itemId, node]));
  if (!originals.size) return plan;
  const localDelta = WORLD_TO_LDU.clone().multiply(worldDelta).multiply(LDU_TO_WORLD);
  const steps = model === '' ? plan.steps : plan.submodels?.[model]?.steps;
  if (!steps) return plan;
  let changed = false;
  const result = steps.map((step) => {
    let edited = false;
    const pieces = step.pieces.map((piece) => {
      if (!piece.id) return piece;
      const node = originals.get(piece.id);
      if (!node) return piece;
      const matrix = localDelta.clone().multiply(placementMatrix(node.local));
      const e = matrix.elements;
      const pose: Placement = {
        pos: [e[12], e[13], e[14]].map(nearZero) as Vec3,
        m: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]].map(nearZero) as Mat3,
      };
      const grid = placementToGrid(pose, node.body);
      edited = true;
      // Never leave an undefined `rot` property on a raw item: the editor's
      // isGrid() discriminator checks the presence of that key.
      const base: Record<string, unknown> = { ...piece };
      for (const key of ['ldu', 'matrix', 'x', 'y', 'z', 'rot']) delete base[key];
      return (grid ? { ...base, ...grid } : { ...base, ldu: pose.pos, matrix: pose.m }) as typeof piece;
    });
    if (edited) changed = true;
    return edited ? { ...step, pieces } : step;
  });
  if (!changed) return plan;
  if (model === '') return { ...plan, steps: result };
  return { ...plan, submodels: { ...plan.submodels, [model]: { steps: result } } };
}

/** About the selection's pivot (world units). Used by rotate and scale gizmos. */
export function aroundPivot(delta: THREE.Matrix4, pivot: THREE.Vector3): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(delta)
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
}
