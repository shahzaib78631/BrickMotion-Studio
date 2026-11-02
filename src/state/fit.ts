import * as THREE from 'three';
import { assemble } from '../model/assemble';
import { partConnectors } from '../plan/connectors';
import { collisionWorld, solidsFor, type CollisionWorld, type Solid } from '../plan/collision';
import { fitSelection, type FitPiece } from '../plan/fitSelection';
import { worldConnectors } from '../plan/connectors';
import { LDU_TO_WORLD, WORLD_TO_LDU, transformPlanItems } from '../plan/gizmo';
import { modelSteps } from '../plan/ops';
import { useAppSettings } from './appSettings';
import { guardConflict } from './guard';
import { getColors, metricsOf } from './partService';
import { useStudio } from './store';

/**
 * Fit the selected pieces together in place: slot the one that can move into the one that holds
 * it, using a documented LDraw slot when the host has one and the nearest stud/pin/bar joint
 * otherwise (`src/plan/fitSelection.ts`). One undo step, the same collision verdict as a drag,
 * and a named reason in the sidebar when nothing fits.
 */
export function fitSelected(): 'ok' | 'refused' {
  const st = useStudio.getState();
  const model = st.editingModel;
  const ids = st.selection.model === model ? [...st.selection.ids] : [];
  const refuse = (why: string, hits: readonly string[] = []) => {
    st.noteBlocked(ids, hits, why);
    return 'refused' as const;
  };
  if (ids.length < 2) return refuse('select the piece to slot in together with the piece it goes into');

  const before = st.plan;
  const view = assemble({ ...before, steps: modelSteps(before, model) }, metricsOf, getColors());
  // a fit moves single pieces: a submodel use stands for a whole group of leaves
  const mine = new Set(ids);
  const pieces: FitPiece[] = [];
  const leaf = new Map<string, (typeof view.instances)[number]>();
  for (const id of ids) {
    const leaves = view.instances.filter((inst) => inst.key.split('/')[0] === id);
    if (leaves.length !== 1) return refuse(leaves.length ? `${id} is a submodel: fit its single pieces instead` : `${id} is not in this model`);
    leaf.set(id, leaves[0]);
    pieces.push({ id, part: leaves[0].part, world: Array.from(leaves[0].world.elements) });
  }

  const poseOf = (inst: NonNullable<ReturnType<typeof leaf.get>>, delta: THREE.Matrix4 | null): Solid[] =>
    solidsFor([inst], metricsOf).map((s) => ({
      ...s,
      world: delta ? delta.clone().multiply(new THREE.Matrix4().fromArray(Array.from(s.world))).elements : s.world,
    }));
  /**
   * What a pose would newly sit inside, asked of the same world the guard uses: every piece
   * except the one being fitted — the host included, since a fit that buries the piece in the
   * host is exactly the case this has to catch. Overlaps the model already had may stay.
   */
  const worlds = new Map<string, { world: CollisionWorld; was: ReadonlySet<string>; inst: NonNullable<ReturnType<typeof leaf.get>> }>();
  const blocked = (insertId: string, target: readonly number[]): readonly string[] => {
    if (!useAppSettings.getState().collision) return [];
    const inst = leaf.get(insertId);
    if (!inst) return [];
    let known = worlds.get(insertId);
    if (!known) {
      const world = collisionWorld(solidsFor(view.instances.filter((i) => i.key.split('/')[0] !== insertId), metricsOf));
      worlds.set(insertId, (known = { world, was: world.hits(poseOf(inst, null)), inst }));
    }
    const delta = new THREE.Matrix4().fromArray(Array.from(target)).multiply(known.inst.world.clone().invert());
    return [...known.world.hits(poseOf(known.inst, delta))].filter((id) => !known.was.has(id));
  };

  // which piece is already joined to the rest: that one stays, the loose one is slotted in
  const connectors = (inst: NonNullable<ReturnType<typeof leaf.get>>) =>
    worldConnectors(partConnectors(metricsOf(inst.part)), Array.from(inst.world.elements));
  const outside = view.instances.filter((inst) => !mine.has(inst.key.split('/')[0])).flatMap(connectors);
  const meets = (a: (typeof outside)[number], b: (typeof outside)[number]) =>
    a.type === b.type && a.gender !== b.gender &&
    Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) < 1 &&
    a.axis[0] * b.axis[0] + a.axis[1] * b.axis[1] + a.axis[2] * b.axis[2] < -0.999;
  const planted = new Map(pieces.map((piece) => [
    piece.id, connectors(leaf.get(piece.id)!).filter((c) => outside.some((o) => meets(c, o))).length,
  ]));

  // every piece in the model, so the fitter can leave the slots other pieces already sit in
  const placed: FitPiece[] = view.instances.map((inst) => ({
    id: inst.key.split('/')[0], part: inst.part, world: Array.from(inst.world.elements),
  }));
  const fit = fitSelection(pieces, {
    metricsOf, blocked, placed, planted: (id) => planted.get(id) ?? 0,
    referenceHints: useAppSettings.getState().referenceHints,
    mirrored: useAppSettings.getState().mirrorReferencePlacements,
  });
  if (!fit.ok) return refuse(fit.why);

  const inst = leaf.get(fit.insert)!;
  // already seated: nothing to change, and no empty undo step
  if (fit.world.every((v, i) => Math.abs(v - inst.world.elements[i]) < 1e-6)) return 'ok';
  const id = fit.insert.split('/')[0];
  const delta = new THREE.Matrix4().fromArray(fit.world).multiply(inst.world.clone().invert());
  const next = transformPlanItems(before, model, [id], view.nodes, LDU_TO_WORLD.clone().multiply(delta).multiply(WORLD_TO_LDU));
  const check = guardConflict(before, next, model, [id]);
  if (!check.ok) return refuse(`the fit would put ${inst.part} inside ${check.hits.join(', ')}`, check.hits);
  st.clearBlockedNote();
  st.apply(() => next);
  return 'ok';
}
