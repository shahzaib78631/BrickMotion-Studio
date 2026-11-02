import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useStudio } from '../../src/state/store';
import { useAppSettings } from '../../src/state/appSettings';
import { fitSelected } from '../../src/state/fit';
import { findItem } from '../../src/plan/ops';
import type { Plan, PlanItem } from '../../src/plan/types';
import { attachmentSlotsFor } from '../../src/ldraw/attachments';
import { assemble } from '../../src/model/assemble';
import { modelSteps } from '../../src/plan/ops';
import { validate } from '../../src/model/validate';
import { getColors, metricsOf } from '../../src/state/partService';
import { appPartsReady as ready, useAppParts } from '../helpers/appParts';

const piece = (id: string, part: string, x: number, y: number, z = 0): PlanItem => ({ id, part, color: 4, x, y, z, rot: 0 });
const load = (pieces: PlanItem[], select: string[]) => {
  const s = useStudio.getState();
  s.setPlan({ name: 't', steps: [{ pieces }] } as Plan, { resetHistory: true });
  s.select(select);
  s.clearBlockedNote();
};
const item = (id: string) => findItem(useStudio.getState().plan, '', id)!.item as Record<string, unknown>;

describe('fit the selected pieces together', () => {
  beforeAll(async () => { if (ready) await useAppParts(['19141', '21459', '18031', '3820', '4349']); }, 60_000);
  beforeEach(() => {
    useStudio.getState().setSmartJointsEnabled(false);
    useAppSettings.getState().set({ collision: true });
  });

  it.skipIf(!ready)('slots a katana into the scabbard at the documented LDraw pose', async () => {
    load([piece('scabbard', '19141', 0, 0), piece('sword', '21459', 30, 0)], ['sword', 'scabbard']);
    expect(fitSelected()).toBe('ok');
    // the documented pose is not a whole-stud grid position: the piece keeps its exact LDU pose
    const sword = item('sword');
    expect('rot' in sword).toBe(false);
    const slot = attachmentSlotsFor('19141', '30173')[0];
    expect(sword.matrix).toEqual(slot.m);
    expect(useStudio.getState().past.length).toBe(1);
    // the pose belongs to the host: stand the scabbard ten studs along and the sword follows
    const first = (sword.ldu as number[]).slice();
    load([piece('scabbard', '19141', 10, 0), piece('sword', '21459', 30, 0)], ['sword', 'scabbard']);
    expect(fitSelected()).toBe('ok');
    expect((item('sword').ldu as number[]).map((v, i) => v - first[i])).toEqual([200, 0, 0]);
  });

  it.skipIf(!ready)('undoes the whole fit in one step', async () => {
    load([piece('scabbard', '19141', 0, 0), piece('sword', '21459', 30, 0)], ['sword', 'scabbard']);
    const was = item('sword');
    expect(fitSelected()).toBe('ok');
    useStudio.getState().undo();
    expect(item('sword')).toEqual(was);
  });

  it.skipIf(!ready)('never puts the second sword in the slot the first one fills', async () => {
    load([
      piece('scabbard', '19141', 0, 0),
      piece('sword1', '21459', 30, 0),
      piece('sword2', '21459', 40, 4),
    ], ['sword1', 'scabbard']);
    expect(fitSelected()).toBe('ok');
    const first = item('sword1').ldu as number[];

    // the scabbard's only free slot is the reflected one, so it is not taken by default
    useStudio.getState().select(['sword2', 'scabbard']);
    expect(fitSelected()).toBe('refused');
    expect(useStudio.getState().blockedNote?.why).toContain('Allow mirrored LDraw reference poses');
    expect(item('sword2')).toHaveProperty('rot');

    // with the explicit opt-in, the mirrored pose places the sword in the *other* slot
    useAppSettings.getState().set({ mirrorReferencePlacements: true });
    expect(fitSelected()).toBe('ok');
    expect('rot' in item('sword2')).toBe(false);
    expect(item('sword2').ldu).not.toEqual(first);
    expect(item('sword1').ldu).toEqual(first);      // and the first sword has not moved

    // and the model counts it as a real connection, not a floating piece
    const asm = assemble({ ...useStudio.getState().plan, steps: modelSteps(useStudio.getState().plan, '') }, metricsOf, getColors());
    const names = new Map(asm.instances.map((i) => [i.itemId, i.part]));
    const floating = validate(asm).filter((w) => w.kind === 'floating').map((w) => names.get(w.itemIds[0]));
    expect(floating).toEqual([]);
    useAppSettings.getState().set({ mirrorReferencePlacements: false });
  });

  it.skipIf(!ready)('puts a hand-held tool in the hand’s clip', async () => {
    load([piece('hand', '3820', 0, 0), piece('gun', '4349', 6, 0)], ['gun', 'hand']);
    expect(fitSelected()).toBe('ok');
    expect('rot' in item('gun')).toBe(false);
  });

  it.skipIf(!ready)('refuses a piece with no interface, naming the pair', async () => {
    load([piece('scabbard', '19141', 0, 0), piece('sword', '18031', 30, 0)], ['sword', 'scabbard']);
    expect(fitSelected()).toBe('refused');
    expect(useStudio.getState().blockedNote?.why).toContain('no joint between 18031 and 19141');
    expect(useStudio.getState().past.length).toBe(0);
  });

  it.skipIf(!ready)('asks for two pieces', async () => {
    load([piece('sword', '21459', 0, 0)], ['sword']);
    expect(fitSelected()).toBe('refused');
    expect(useStudio.getState().blockedNote?.why).toContain('select the piece to slot in');
  });
});
