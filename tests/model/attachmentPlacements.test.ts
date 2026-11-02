import { describe, expect, it } from 'vitest';
import { attachmentSlotsFor } from '../../src/ldraw/attachments';
import { attachmentLocalMatrix, attachmentFit, availableAttachmentTargets,
  discoverPlacedAttachments, inverseAttachmentWorldMatrix, multiplyAttachmentMatrices,
  type PlacedAttachmentPart } from '../../src/model/attachmentPlacements';

const I = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const host: PlacedAttachmentPart = { id: 'host', part: '19141', world: I };
const [first, second] = attachmentSlotsFor('19141', '30173');
const sword = (id: string, slot = first, world: number[] = I): PlacedAttachmentPart => ({
  id, part: '30173', world: multiplyAttachmentMatrices(world, attachmentLocalMatrix(slot)),
});

const rotY = (a: number, x: number, y: number, z: number) => {
  const c = Math.cos(a), s = Math.sin(a);
  return [c,0,-s,0,0,1,0,0,s,0,c,0,x,y,z,1];
};

describe('exact-pose, nonstandard attachments', () => {
  it('recognises both documented 19141 slots, separately preserving parity', () => {
    expect(attachmentFit(I, sword('a').world, first)).not.toBeNull();
    expect(attachmentFit(I, sword('b', second).world, second)).not.toBeNull();
    expect(attachmentFit(I, sword('b', second).world, first)).toBeNull();
    expect(discoverPlacedAttachments([host, sword('a'), sword('b', second)])
      .map((x) => x.slot.id)).toEqual(['19141:sword:1', '19141:sword:2']);
  });

  it('composes into any rotated and translated host world frame', () => {
    const world = rotY(Math.PI / 2, 70, -20, -40);
    const h: PlacedAttachmentPart = { ...host, world };
    const s = sword('s', first, world);
    const fit = discoverPlacedAttachments([h, s]);
    expect(fit).toHaveLength(1);
    expect(fit[0].positionError).toBeLessThan(0.01);
    const inv = inverseAttachmentWorldMatrix(world)!;
    const product = multiplyAttachmentMatrices(inv, world);
    for (let i = 0; i < 16; i++) expect(product[i]).toBeCloseTo(I[i], 6);
  });

  it('rejects lookalikes, scaled bodies, wrong angles and near-but-not-seated parts', () => {
    const good = sword('s');
    expect(discoverPlacedAttachments([host, { ...good, part: '30173b' }])).toEqual([]);
    const offset = [...good.world]; offset[12] += 0.9;
    expect(attachmentFit(I, offset, first)).toBeNull();
    const turned = multiplyAttachmentMatrices(good.world, rotY(6 * Math.PI / 180, 0, 0, 0));
    expect(attachmentFit(I, turned, first)).toBeNull();
    const enlarged = [...I]; enlarged[0] = 2;
    expect(attachmentFit(enlarged, good.world, first)).toBeNull();
    expect(attachmentFit(I, good.world, second)).toBeNull();
  });

  it('protects occupancy, including pieces not visible in the current editing step', () => {
    const occupied = sword('existing');
    expect(availableAttachmentTargets({ ...sword('new'), world: I }, [host], false, false).map((t) => t.slot.id))
      .toEqual(['19141:sword:1']);
    const remaining = availableAttachmentTargets({ ...sword('new'), world: I }, [host, occupied], false, true);
    expect(remaining.map((t) => t.slot.id)).toEqual(['19141:sword:2']);
    expect(availableAttachmentTargets(sword('new'), [host, occupied, sword('also', second)], false, true)).toEqual([]);
  });

  it('never calls two swords on one exact pose a valid pair of insertions', () => {
    expect(discoverPlacedAttachments([host, sword('a'), sword('b')])).toEqual([]);
    const overlappingHost = { ...host, id: 'duplicate-host' };
    expect(discoverPlacedAttachments([host, overlappingHost, sword('a')])).toEqual([]);
  });

  it('requires a user opt-in for mirrored reference poses', () => {
    const moving = { ...sword('new'), world: I };
    expect(availableAttachmentTargets(moving, [host], false, false)).toHaveLength(1);
    const both = availableAttachmentTargets(moving, [host], false, true);
    expect(both).toHaveLength(2);
    expect(both.map((t) => t.slot.mirrored)).toEqual([false, true]);
    expect(attachmentFit(I, both[1].world, second)).not.toBeNull();
  });
});
