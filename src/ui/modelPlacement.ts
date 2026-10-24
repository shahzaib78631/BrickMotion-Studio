import * as THREE from 'three';
import { spotTransform } from '../anim/timeline';
import type { Assembly } from '../model/assemble';
import type { Plan } from '../plan/types';

/** View-only placement of the main model. The LDraw document is never moved. */
export function modelPlacement(plan: Plan, editingModel: string, assembly: Assembly): THREE.Matrix4 | null {
  return plan.showModelAtSpot && editingModel === '' && plan.assemblySpot && assembly.bounds
    ? spotTransform(plan.assemblySpot, assembly.bounds) : null;
}

/** Three's editor uses studs and Y-up/Z-forward; the planner uses LDraw units. */
const LDU_TO_VIEW = new THREE.Matrix4().makeScale(1 / 20, -1 / 20, -1 / 20);
const VIEW_TO_LDU = LDU_TO_VIEW.clone().invert();
export function viewPlacement(matrix: THREE.Matrix4): THREE.Matrix4 {
  return LDU_TO_VIEW.clone().multiply(matrix).multiply(VIEW_TO_LDU);
}

/** Undo the visual placement before recording a gizmo operation on source pieces. */
export function sourceEditDelta(delta: THREE.Matrix4, placement: THREE.Matrix4 | null): THREE.Matrix4 {
  if (!placement) return delta;
  const shown = viewPlacement(placement);
  return shown.clone().invert().multiply(delta).multiply(shown);
}
