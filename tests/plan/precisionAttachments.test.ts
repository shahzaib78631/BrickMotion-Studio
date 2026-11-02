import { describe, expect, it } from 'vitest';
import { availableAttachmentTargets } from '../../src/model/attachmentPlacements';
import { findPose, type PoseQuery } from '../../src/plan/placementEngine';
import type { CollisionWorld, Solid } from '../../src/plan/collision';
import type { Aim } from '../../src/plan/aim';

const I = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const host = { id: 'scabbard', part: '19141', world: I };
const sword = { id: 'sword', part: '30173', world: I };
const target = availableAttachmentTargets(sword, [host])[0];
const solid: Solid = { id: 'sword', world: I, body: { min: [-1, -1, -1], max: [1, 1, 1] } };
const aim: Aim = {
  ray: { origin: [target.anchor[0], target.anchor[1] - 150, target.anchor[2]], dir: [0, 1, 0] },
  hitDepth: 150, hitPoint: target.anchor, floorPoint: null,
};
const query = (world: CollisionWorld | null, override: Partial<PoseQuery> = {}): PoseQuery => ({
  moving: { solids: [solid], connectors: [] },
  targets: [], precisionTargets: [target], aim,
  ref: [0, 0, 0], lock: null, yaw: 0, world, before: new Set(),
  prev: null, floor: 100, ...override,
});

describe('non-cylindrical attachments in Studio-style drag placement', () => {
  it('produces exact world placement without any SNAP_CYL on the sword', () => {
    const pose = findPose(query(null));
    expect(pose.valid).toBe(true);
    expect(pose.mated).toBe(1);
    expect(pose.handle).toBe(-2);
    expect(pose.owners).toEqual(['scabbard']);
    expect(pose.attachment?.slot).toBe('19141:sword:1');
    expect(pose.delta).toEqual(expect.arrayContaining(target.world));
  });

  it('cannot bypass the editor collision guard', () => {
    const blocked: CollisionWorld = { hits: () => new Set(['scabbard']) };
    const pose = findPose(query(blocked));
    expect(pose.valid).toBe(false);
    expect(pose.with).toEqual(['scabbard']);
    expect(pose.attachment?.slot).toBe(target.slot.id);
  });

  it('does not claim a precision attachment when a cylindrical grip is locked or turned', () => {
    expect(findPose(query(null, { lock: 0 })).attachment).toBeUndefined();
    expect(findPose(query(null, { yaw: 90 })).attachment).toBeUndefined();
  });

  it('does not snap into a completely hidden host far beyond the hit surface', () => {
    const ray = { ...aim, hitDepth: 1 };
    expect(findPose(query(null, { aim: ray })).attachment).toBeUndefined();
  });
});
