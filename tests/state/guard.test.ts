import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useStudio } from '../../src/state/store';
import { useAppSettings } from '../../src/state/appSettings';
import { runCommand } from '../../src/state/editing';
import { clampGizmo, createGizmoCollisionProbe, guardConflict, guardEdit, guardedApply } from '../../src/state/guard';
import { moveItems, findItem } from '../../src/plan/ops';
import type { Plan, PlanItem } from '../../src/plan/types';
import { appPartsReady as ready, useAppParts } from '../helpers/appParts';

const piece = (id: string, part: string, x: number, y: number, z = 0): PlanItem => ({ id, part, color: 4, x, y, z, rot: 0 });
const load = (pieces: PlanItem[], select: string[]) => {
  const s = useStudio.getState();
  s.setPlan({ name: 't', steps: [{ pieces }] } as Plan, { resetHistory: true });
  s.select(select);
};
const at = (id: string) => findItem(useStudio.getState().plan, '', id)!.item as { x: number; y: number; z: number };

describe('collision guard', () => {
  beforeAll(async () => { if (ready) await useAppParts(['3001', '3023']); }, 60_000);
  beforeEach(() => {
    // This suite tests collision guarding, not smart-joint detachment policies.
    useStudio.getState().setSmartJointsEnabled(false);
    useAppSettings.getState().set({ collision: true });
  });

  it.skipIf(!ready)('refuses an arrow move into a wall', () => {
    load([piece('a', '3001', 0, 0), piece('wall', '3001', 8, 0)], ['a']);
    const r1 = guardedApply('', ['a'], (p) => moveItems(p, '', ['a'], { x: 2, y: 0, z: 0 }));
    expect(r1).toBe('ok');
    expect(at('a').x).toBe(2);
    const before = useStudio.getState().plan;
    expect(guardedApply('', ['a'], (p) => moveItems(p, '', ['a'], { x: 4, y: 0, z: 0 }))).toBe('blocked');
    expect(useStudio.getState().plan).toBe(before);
    expect(useStudio.getState().blocked?.ids).toEqual(['a']);
  });

  it.skipIf(!ready)('E on a plate under a brick lands on top of the brick', () => {
    load([piece('p', '3023', 0, 0), piece('b', '3001', 0, 1)], ['p']);
    runCommand({ kind: 'move', d: { x: 0, y: 1, z: 0 } });
    expect(at('p').y).toBe(4);
  });

  it.skipIf(!ready)('moves freely when collision is off', () => {
    useAppSettings.getState().set({ collision: false });
    load([piece('a', '3001', 0, 0), piece('wall', '3001', 4, 0)], ['a']);
    runCommand({ kind: 'move', d: { x: 1, y: 0, z: 0 } });
    expect(at('a').x).toBe(1);
  });

  it.skipIf(!ready)('arrow keys refuse to push a brick into another', () => {
    load([piece('a', '3001', 0, 0), piece('wall', '3001', 4, 0)], ['a']);
    runCommand({ kind: 'move', d: { x: 1, y: 0, z: 0 } });
    expect(at('a').x).toBe(0);
  });

  it.skipIf(!ready)('duplicate is collision-checked', () => {
    load([piece('a', '3001', 0, 0), piece('wall', '3001', 4, 0)], ['a']);
    runCommand({ kind: 'duplicate' });
    const copy = useStudio.getState().selection.ids[0];
    expect(copy).not.toBe('a');
    expect(at(copy).x).toBeGreaterThanOrEqual(8);
  });

  it.skipIf(!ready)('a refused move names the piece it would hit, for the sidebar', () => {
    load([piece('a', '3001', 0, 0), piece('wall', '3001', 4, 0)], ['a']);
    const before = useStudio.getState().plan;
    const after = moveItems(before, '', ['a'], { x: 1, y: 0, z: 0 });
    expect(guardConflict(before, after, '', ['a'])).toEqual({ ok: false, hits: ['wall'] });
    expect(guardedApply('', ['a'], () => after)).toBe('blocked');
    const note = useStudio.getState().blockedNote!;
    expect(note.ids).toEqual(['a']);
    expect(note.with).toEqual(['wall']);
    expect(note.why).toContain('inside another piece');
    useStudio.getState().clearBlockedNote();
    expect(useStudio.getState().blockedNote).toBeNull();
  });

  it.skipIf(!ready)('gesture collision probe is equivalent to guardConflict and preserves existing contacts', () => {
    load([piece('a','3001',0,0),piece('wall','3001',8,0)],['a']);
    const before=useStudio.getState().plan;
    const probe=createGizmoCollisionProbe(before,'',['a']);
    const far=moveItems(before,'',['a'],{x:1,y:0,z:0});
    const hit=moveItems(before,'',['a'],{x:5,y:0,z:0});
    expect(probe(far)).toEqual(guardConflict(before,far,'',['a']));
    expect(probe(hit)).toEqual(guardConflict(before,hit,'',['a']));
    expect(clampGizmo('translate',before,hit,null,'',['a'],probe).blocked).toBe(!probe(hit).ok);
  });

  it.skipIf(!ready)('the rotate gizmo cannot turn a piece into its neighbour', () => {
    load([piece('a', '3001', 0, 0), piece('wall', '3001', 0, 0, 2)], ['a']);
    const original = useStudio.getState().plan;
    const turned = { ...original, steps: [{ pieces: original.steps[0].pieces.map((it) => (it.id === 'a' ? { ...it, rot: 90 } : it)) }] } as Plan;
    expect(guardEdit(original, turned, '', ['a'])).toBe(false); // the turn really overlaps
    const r = clampGizmo('rotate', original, turned, null, '', ['a']);
    expect(r.blocked).toBe(true);
    expect(r.plan).toBe(original);
    const t = clampGizmo('translate', original, turned, null, '', ['a']);
    expect(t.blocked).toBe(true);
    // scaling is an explicit, separate mode and stays unguarded
    expect(clampGizmo('scale', original, turned, null, '', ['a']).plan).toBe(turned);
  });

  it.skipIf(!ready)('a piece whose studs land between a neighbour’s tubes is refused', () => {
    // the plate sits under the brick; on the brick's grid (z = 10) its studs are in the
    // brick's sockets, 10 LDU over they are between the brick's tubes, in its way
    const plan = (plateZ: number): Plan => ({ name: 't', steps: [{ pieces: [
      { id: 'b', part: '3001', color: 4, ldu: [0, -32, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      { id: 'p', part: '3023', color: 4, ldu: [0, -8, plateZ], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    ] }] } as Plan);
    const seated = plan(10), moved = plan(0);
    expect(guardEdit(seated, seated, '', ['p'])).toBe(true); // the studs are in the sockets
    expect(guardEdit(seated, moved, '', ['p'])).toBe(false); // the studs are in the way
    expect(clampGizmo('translate', seated, moved, null, '', ['p']).blocked).toBe(true);
  });
});
