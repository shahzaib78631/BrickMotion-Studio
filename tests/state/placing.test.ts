import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { useStudio } from '../../src/state/store';
import { useAppSettings } from '../../src/state/appSettings';
import { beginPlacing, cancelPlacing, commitPlacing, cycleHandle, updatePlacing, usePlacing } from '../../src/state/placing';
import { findItem } from '../../src/plan/ops';
import { modelPointOf, viewPlacement } from '../../src/ui/modelPlacement';
import type { Plan, PlanItem } from '../../src/plan/types';
import type { Aim } from '../../src/plan/aim';
import type { Vec3 } from '../../src/ldraw/parse';
import { appPartsReady as ready, useAppParts } from '../helpers/appParts';

const piece = (id: string, part: string, x: number, y: number, z = 0): PlanItem => ({ id, part, color: 4, x, y, z, rot: 0 });
const load = (steps: PlanItem[][], currentStep: number | null = null) => {
  const s = useStudio.getState();
  s.setPlan({ name: 't', steps: steps.map((pieces) => ({ pieces })) } as Plan, { resetHistory: true });
  s.setCurrentStep(currentStep);
};
/** Looking straight down at a model point from 400 LDU above it (the floor is the plan's, y = 0). */
const aimDown = (p: Vec3): Aim => ({ ray: { origin: [p[0], p[1] - 400, p[2]], dir: [0, 1, 0] }, hitDepth: 400, floorPoint: [p[0], 0, p[2]], hitPoint: p });
const item = (id: string) => findItem(useStudio.getState().plan, '', id)!.item as { x: number; y: number; z: number };

describe('placing session', () => {
  beforeAll(async () => { if (ready) await useAppParts(['3001', '3020', '3024']); }, 60_000);
  beforeEach(() => { useAppSettings.getState().set({ collision: true }); cancelPlacing(); useStudio.getState().clearBlockedNote(); });

  it.skipIf(!ready)('drags a brick from the floor onto a plate and commits once', () => {
    load([[piece('plate', '3020', 0, 0), piece('brick', '3001', 10, 0)]]);
    // grab the brick by its corner socket (model LDU, Y down)
    beginPlacing({ kind: 'move', model: '', ids: ['brick'] }, [210, 0, 10]);
    const pose = updatePlacing(aimDown([11, -8, 11]));
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
    updatePlacing(aimDown([11, -8, 11]));
    cancelPlacing();
    expect(useStudio.getState().plan).toBe(before);
    expect(useStudio.getState().past).toHaveLength(0);
    expect(usePlacing.getState().state).toBeNull();
  });

  it.skipIf(!ready)('does not target pieces from later steps', () => {
    load([[piece('brick', '3001', 10, 0)], [], [], [piece('plate', '3020', 0, 0)]], 1);
    beginPlacing({ kind: 'move', model: '', ids: ['brick'] }, [210, 0, 10]);
    const pose = updatePlacing(aimDown([11, -8, 11]));
    expect(pose?.owners).toEqual([]);
    expect(pose?.mated).toBe(0);
  });

  it.skipIf(!ready)('adds a new part where it is dropped, in the current step', () => {
    load([[piece('plate', '3020', 0, 0)], []], 1);
    beginPlacing({ kind: 'new', model: '', items: [piece('', '3024', 0, 0)] });
    updatePlacing(aimDown([30, -8, 30]));
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
    updatePlacing(aimDown([30, -8, 30]));
    cancelPlacing();
    expect(useStudio.getState().plan).toBe(before);
  });

  it.skipIf(!ready)('cycles the grip lock through Auto', () => {
    load([[piece('brick', '3001', 10, 0)]]);
    beginPlacing({ kind: 'move', model: '', ids: ['brick'] }, [210, 0, 10]);
    const lock = () => usePlacing.getState().state!.lock;
    expect(lock()).toBeNull();
    cycleHandle(1);
    expect(lock()).toBe(0);
    cycleHandle(-1);
    expect(lock()).toBeNull();
    cycleHandle(-1);
    const n = lock()! + 1;
    expect(n).toBeGreaterThan(1);
    cycleHandle(1); // past the last grip: back to Auto
    expect(lock()).toBeNull();
    for (let i = 0; i < n; i++) cycleHandle(1);
    expect(lock()).toBe(n - 1);
  });

  it.skipIf(!ready)("a new part is held by its underside centre", () => {
    load([[piece('plate', '3020', 0, 0)], []], 1);
    beginPlacing({ kind: 'new', model: '', items: [piece('', '3001', 0, 0)] });
    // pointing at the plate's centre (plan positions are corner-based) puts the brick's centre there: on all 8 studs
    const pose = updatePlacing(aimDown([40, -8, 20]));
    expect(pose?.valid).toBe(true);
    expect(pose?.mated).toBe(8);
  });

  it('says so when a part is not in the library instead of letting it float', () => {
    load([[piece('x', 'not-a-part', 0, 0)]]);
    beginPlacing({ kind: 'move', model: '', ids: ['x'] }, [10, 0, 10]);
    // a placeholder has no connectors and no measurement: the sidebar must say why nothing bites
    const note = useStudio.getState().blockedNote;
    expect(note?.why).toContain('not in the part library');
    expect(note?.why).toContain('not-a-part');
    cancelPlacing();
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
    const pose = updatePlacing(aimDown([11, -8, 11]));
    expect(pose?.valid).toBe(true);
    commitPlacing();
    expect(item('brick')).toMatchObject({ x: 0, y: 1, z: 0 });
  });

  describe('an outside change ends the session first', () => {
    const ghostIn = () => useStudio.getState().plan.steps.flatMap((x) => x.pieces).some((it) => 'part' in it && it.part === '3024');

    it.skipIf(!ready)('keeps an edit made elsewhere and drops the held part', () => {
      load([[piece('plate', '3020', 0, 0)]]);
      beginPlacing({ kind: 'new', model: '', items: [piece('', '3024', 0, 0)] });
      updatePlacing(aimDown([30, -8, 30]));
      useStudio.getState().apply((p) => ({ ...p, steps: [{ pieces: [...p.steps[0].pieces, piece('lane', '3001', 40, 0)] }] }));
      expect(usePlacing.getState().state).toBeNull();
      expect(ghostIn()).toBe(false);
      expect(item('lane')).toBeTruthy();
      expect(useStudio.getState().gesture).toBeNull();
      expect(useStudio.getState().past).toHaveLength(1);
      // a late mouse move or drag end changes nothing
      expect(updatePlacing(aimDown([30, -8, 30]))).toBeNull();
      cancelPlacing();
      expect(item('lane')).toBeTruthy();
    });

    it.skipIf(!ready)('opening another project leaves that project alone', () => {
      load([[piece('plate', '3020', 0, 0)]]);
      beginPlacing({ kind: 'new', model: '', items: [piece('', '3024', 0, 0)] });
      const other = { name: 'other', steps: [{ pieces: [piece('x', '3001', 0, 0)] }] } as Plan;
      useStudio.getState().setPlan(other, { resetHistory: true });
      updatePlacing(aimDown([30, -8, 30]));
      expect(useStudio.getState().plan).toBe(other);
      expect(useStudio.getState().gesture).toBeNull();
    });

    it.skipIf(!ready)('undo, switching model or mode cancel it', () => {
      for (const act of [() => useStudio.getState().undo(), () => useStudio.getState().setEditingModel(''), () => useStudio.getState().setMode('preview')]) {
        load([[piece('plate', '3020', 0, 0)]]);
        useStudio.getState().setMode('edit');
        beginPlacing({ kind: 'new', model: '', items: [piece('', '3024', 0, 0)] });
        updatePlacing(aimDown([30, -8, 30]));
        act();
        expect(usePlacing.getState().state).toBeNull();
        expect(ghostIn()).toBe(false);
        expect(useStudio.getState().gesture).toBeNull();
      }
    });
  });
});
