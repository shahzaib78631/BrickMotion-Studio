import * as THREE from 'three';
import { spotTransform } from '../anim/timeline';
import { fixedBayPose } from '../anim/construction/rigidStaging';
import type { Assembly, Instance } from '../model/assemble';
import { transformBox, unionBox } from '../model/assemble';
import type { Box } from '../ldraw/flatten';
import { isSub, type AssemblySpot, type Plan } from '../plan/types';
import { modelSteps } from '../plan/ops';

/** View-only placement of the main model. The LDraw document is never moved. */
export function modelPlacement(plan: Plan, editingModel: string, assembly: Assembly): THREE.Matrix4 | null {
  return plan.showModelAtSpot && editingModel === '' && plan.assemblySpot && assembly.bounds
    ? spotTransform(plan.assemblySpot, assembly.bounds) : null;
}

/**
 * Per-instance display deltas in LDraw world space. A submodel build spot is a
 * workbench location, NOT a change to its final connection in the LDraw file.
 *
 * A named submodel use owns every descendant instance unless a deeper use has
 * its own explicitly placed spot. Each fixed spot is absolute in the original
 * main-model frame, just like Construction V2's fixedBayPose; it does not get
 * compounded with its parent's spot. The main spot applies to bays only when
 * "loose pieces follow" is on, matching the animation and floor markers.
 *
 * This deliberately does not depend on a successful timeline. Even an
 * unplannable model is editable and appears directly on its dropped marker.
 */
export function instancePlacements(plan: Plan, editingModel: string, assembly: Assembly): Map<string, THREE.Matrix4> {
  const result = new Map<string, THREE.Matrix4>();
  if (editingModel !== '' || !plan.showModelAtSpot || !assembly.bounds) return result;

  const root = modelPlacement(plan, editingModel, assembly);
  const bayRoot = root && plan.loosePiecesFollow !== false ? root : null;
  const ground = assembly.bounds.max[1];
  const spots = new Map<string, AssemblySpot>();
  // Read the CURRENT plan, not the cached assembly nodes. A spot is editorial
  // metadata, so dropping a tile should take effect in the next editor frame
  // even while the animation worker or part loader is still running.
  const walk = (model: string, prefix: string, ancestors: readonly string[]) => {
    if (ancestors.length >= 16) return;
    for (const step of modelSteps(plan, model)) for (const item of step.pieces) {
      if (!isSub(item) || !item.id || !plan.submodels?.[item.submodel] || ancestors.includes(item.submodel)) continue;
      const path = prefix ? `${prefix}/${item.id}` : item.id;
      if (item.assembly?.buildSpot) spots.set(path, item.assembly.buildSpot);
      walk(item.submodel, path, [...ancestors, item.submodel]);
    }
  };
  walk('', '', []);

  // A single sweep of the actual assembled instances computes the world AABB
  // for every selected bay. No recursive transform accumulation and no O(n^2)
  // scan of the entire model for every marker.
  const bounds = new Map<string, Box>();
  for (const inst of assembly.instances) {
    for (let at = inst.key.indexOf('/'); at !== -1; at = inst.key.indexOf('/', at + 1)) {
      const path = inst.key.slice(0, at);
      if (!spots.has(path)) continue;
      bounds.set(path, unionBox(bounds.get(path) ?? null, inst.worldBox));
    }
  }
  const deltas = new Map<string, THREE.Matrix4>();
  for (const [path, spot] of spots) {
    const box = bounds.get(path);
    if (!box) continue;
    // The very same staging matrix as V2: no difference in centre, yaw or
    // floor height between the viewport preview and the animation planner.
    const local = new THREE.Matrix4().fromArray(fixedBayPose(box, spot, ground));
    deltas.set(path, bayRoot ? bayRoot.clone().multiply(local) : local);
  }

  for (const inst of assembly.instances) {
    let delta = root;
    // Walk ancestor paths from shallow to deep so an explicitly positioned
    // nested use wins over its parent's position. Automatic children inherit
    // the nearest positioned parent's transform.
    for (let at = inst.key.indexOf('/'); at !== -1; at = inst.key.indexOf('/', at + 1)) {
      const chosen = deltas.get(inst.key.slice(0, at));
      if (chosen) delta = chosen;
    }
    if (delta) result.set(inst.key, delta);
  }
  return result;
}

/** Resolve a placed world matrix/box without ever mutating an original instance. */
export function placedMatrix(inst: Instance, placements: ReadonlyMap<string, THREE.Matrix4>): THREE.Matrix4 {
  const delta = placements.get(inst.key);
  return delta ? delta.clone().multiply(inst.world) : inst.world;
}
export function placedBox(inst: Instance, placements: ReadonlyMap<string, THREE.Matrix4>): Box {
  const delta = placements.get(inst.key);
  return delta ? transformBox(inst.worldBox, delta) : inst.worldBox;
}

/** A top-level item is the unit the editor moves; its first leaf identifies
 * the displayed frame. The selected item's authored placement is never changed
 * merely because it has a manually positioned build spot. */
export function itemPlacement(instances: readonly Instance[], placements: ReadonlyMap<string, THREE.Matrix4>, id: string): THREE.Matrix4 | null {
  const instance = instances.find((i) => i.key === id || i.key.startsWith(`${id}/`));
  return instance ? placements.get(instance.key) ?? null : null;
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
