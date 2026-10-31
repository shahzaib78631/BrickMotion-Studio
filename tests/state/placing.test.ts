import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { useStudio } from '../../src/state/store';
import { useAppSettings } from '../../src/state/appSettings';
import { beginPlacing, cancelPlacing, commitPlacing, cycleHandle, updatePlacing, usePlacing } from '../../src/state/placing';
import { findItem } from '../../src/plan/ops';
import { modelPointOf, viewPlacement } from '../../src/ui/modelPlacement';
import type { Plan, PlanItem } from '../../src/plan/types';
import { appPartsReady as ready, useAppParts } from '../helpers/appParts';

const piece = (id: string, part: string, x: number, y: number, z = 0): PlanItem => ({ id, part, color: 4, x, y, z, rot: 0 });
const load = (steps: PlanItem[][], currentStep: number | null = null) => {
  const s = useStudio.getState();
  s.setPlan({ name: 't', steps: steps.map((pieces) => ({ pieces })) } as Plan, { resetHistory: true });
  s.setCurrentStep(currentStep);
};
const item = (id: string) => findItem(useStudio.getState().plan, '', id)!.item as { x: number; y: number; z: number };

describe('placing session', () => {
  beforeAll(async () => { if (ready) await useAppParts(['3001', '3020', '3024']); }, 60_000);
  beforeEach(() => { useAppSettings.getState().set({ collision: true }); cancelPlacing(); });

  it.skipIf(!ready)('drags a brick from the floor onto a plate and commits once', () => {
    load([[piece('plate', '3020', 0, 0), piece('brick', '3001', 10, 0)]]);
    // grab the brick by its corner socket (model LDU, Y down)
    beginPlacing({ kind: 'move', model: '', ids: ['brick'] }, [210, 0, 10]);
    const pose = updatePlacing({ point: [11, -8, 11], owner: 'plate' });
    expect(pose?.valid).toBe(true);
    expect(pose?.mated).toBe(8);
    expect(commitPlacing()).toEqual(['brick']);
    expect(item('brick')).toMatchObject({ x: 0, y: 1, z: 0 });
    useStudio.getState().undo();
    expect(item('brick')).toMatchObject({ x: 10, y: 0, z: 0 });
  });

  it.skipIf(!ready)('cancel restores the original position', () => {
    load([[piece('plate', '3020', 0, 0), piece('brick', '3001', 10, 0)]]);
    const before = useStudio.getState().plan;
    beginPlacing({ kind: 'move', model: '', ids: ['brick'] }, [210, 0, 10]);
    updatePlacing({ point: [11, -8, 11], owner: 'plate' });
    cancelPlacing();
    expect(useStudio.getState().plan).toBe(before);
    expect(useStudio.getState().past).toHaveLength(0);
    expect(usePlacing.getState().state).toBeNull();
  });

  it.skipIf(!ready)('does not target pieces from later steps', () => {
    load([[piece('brick', '3001', 10, 0)], [], [], [piece('plate', '3020', 0, 0)]], 1);
    beginPlacing({ kind: 'move', model: '', ids: ['brick'] }, [210, 0, 10]);
    const pose = updatePlacing({ point: [11, -8, 11], owner: 'plate' });
    expect(pose?.owners).toEqual([]);
    expect(pose?.mated).toBe(0);
  });

  it.skipIf(!ready)('adds a new part where it is dropped, in the current step', () => {
    load([[piece('plate', '3020', 0, 0)], []], 1);
    beginPlacing({ kind: 'new', model: '', items: [piece('', '3024', 0, 0)] });
    updatePlacing({ point: [30, -8, 30], owner: 'plate' });
    const ids = commitPlacing()!;
    expect(ids).toHaveLength(1);
    const found = findItem(useStudio.getState().plan, '', ids[0])!;
    expect(found.step).toBe(1);
    expect(found.item).toMatchObject({ x: 1, y: 1, z: 1 });
    expect(useStudio.getState().selection.ids).toEqual(ids);
  });

  it.skipIf(!ready)('cancelling a new part leaves the plan untouched', () => {
    load([[piece('plate', '3020', 0, 0)]]);
    const before = useStudio.getState().plan;
    beginPlacing({ kind: 'new', model: '', items: [piece('', '3024', 0, 0)] });
    updatePlacing({ point: [30, -8, 30], owner: 'plate' });
    cancelPlacing();
    expect(useStudio.getState().plan).toBe(before);
  });

  it.skipIf(!ready)('Tab cycles the handle', () => {
    load([[piece('brick', '3001', 10, 0)]]);
    beginPlacing({ kind: 'move', model: '', ids: ['brick'] }, [210, 0, 10]);
    const h0 = usePlacing.getState().state!.handle;
    cycleHandle(1);
    expect(usePlacing.getState().state!.handle).not.toBe(h0);
  });

  it('maps a display hit back into the model frame of a rotated bay', () => {
    const bay = new THREE.Matrix4().makeTranslation(100, 0, 40).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
    const modelPoint = new THREE.Vector3(30, -8, 10);
    const shownLdu = modelPoint.clone().applyMatrix4(bay);
    const shownView = shownLdu.clone().applyMatrix4(new THREE.Matrix4().makeScale(1 / 20, -1 / 20, -1 / 20));
    expect(modelPointOf(shownView, bay).map((v) => Math.round(v * 1000) / 1000)).toEqual([30, -8, 10]);
    expect(modelPointOf(shownView, null).map((v) => Math.round(v * 1000) / 1000)).toEqual([shownLdu.x, shownLdu.y, shownLdu.z].map((v) => Math.round(v * 1000) / 1000));
    void viewPlacement;
  });

  it.skipIf(!ready)('grabbing a brick by its top still seats it on top', () => {
    load([[piece('plate', '3020', 0, 0), piece('brick', '3001', 10, 0)]]);
    beginPlacing({ kind: 'move', model: '', ids: ['brick'] }, [210, -24, 10]);
    const pose = updatePlacing({ point: [11, -8, 11], owner: 'plate' });
    expect(pose?.valid).toBe(true);
    commitPlacing();
    expect(item('brick')).toMatchObject({ x: 0, y: 1, z: 0 });
  });
});
