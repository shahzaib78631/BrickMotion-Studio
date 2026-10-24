import { describe, expect, it } from 'vitest';
import { identity, multiply, rotation, translation } from '../../src/anim/construction/math';
import type { M4 } from '../../src/anim/construction/math';
import { matchesReviewedSurface, verifyReviewedSurface, REVIEWED_5590_SURFACES } from '../../src/anim/construction/reviewedSurfaceContacts';
import type { ConstructionModel, ConstructionNode } from '../../src/anim/construction/types';
import type { MeshOracle } from '../../src/anim/construction/collision';

const B = { min: [-1,-1,-1] as [number,number,number], max: [1,1,1] as [number,number,number] };
const reviewed = REVIEWED_5590_SURFACES[0];
const node = (id: string, part: string, matrix: M4): ConstructionNode => ({
  id, part, matrix, model: 'test', step: 0, order: 0, body: B, bounds: B, leaves: [id],
});
const fixture = () => {
  const moving = node(reviewed.moving, reviewed.movingPart, [...reviewed.relativePose]);
  const obstacle = node(reviewed.obstacle, reviewed.obstaclePart, identity());
  const model: ConstructionModel = { nodes: [moving, obstacle],
    parts: new Map([[moving.id, moving], [obstacle.id, obstacle]]),
    bounds: B, metrics: () => { throw new Error('Metrics not needed for pose matching'); } };
  return { moving, obstacle, model };
};

describe('Reviewed contact certificates: exact relative placement only', () => {
  it('accepts precisely the reviewed instance IDs, parts, and relative pose', () => {
    const { moving, obstacle } = fixture();
    expect(matchesReviewedSurface(moving, obstacle, reviewed)).toBe(true);
    expect(matchesReviewedSurface({ ...moving, id: 'another-instance' }, obstacle, reviewed)).toBe(false);
    expect(matchesReviewedSurface({ ...moving, part: 'different-part' }, obstacle, reviewed)).toBe(false);
  });

  it('remains valid after any common world-space translation or rigid rotation', () => {
    const { moving, obstacle } = fixture();
    const world = multiply(translation([75, 12, -40]), rotation([0, 1, 0], Math.PI / 3));
    moving.matrix = multiply(world, moving.matrix);
    obstacle.matrix = multiply(world, obstacle.matrix);
    expect(matchesReviewedSurface(moving, obstacle, reviewed)).toBe(true);
  });

  it('invalidates when one part moves relative to the other', () => {
    const { moving, obstacle } = fixture();
    moving.matrix = multiply(translation([0.02, 0, 0]), moving.matrix);
    expect(matchesReviewedSurface(moving, obstacle, reviewed)).toBe(false);
  });

  it('does not create a joint, dependency or motion exemption', () => {
    const { model } = fixture();
    const calls: number[] = [];
    const fakeOracle = {clear: (_a: string, _b: string, offset: number[], obstacleOffset: number[], delta: number[]) => {
      expect(obstacleOffset).toEqual([0,0,0]);
      expect(delta).toEqual([0,0,0]);
      calls.push(Math.hypot(...offset));
      return Math.hypot(...offset) > 2.05;
    }} as unknown as MeshOracle;
    const certificate = verifyReviewedSurface(model, reviewed, fakeOracle);
    expect(certificate?.kind).toBe('surface');
    expect(certificate?.staticOnly).toBe(true);
    expect(certificate?.confidence).toBe('declared');
    expect(certificate?.surfaceTolerance).toBe(2.1);
    expect(certificate?.region).toBeUndefined();
    expect(certificate?.regions).toBeUndefined();
    expect(calls.every(x => x <= 2.5)).toBe(true);
  });

  it('refuses contacts that require more separation than reviewed', () => {
    const { model } = fixture();
    const blockedOracle = {clear: () => false} as unknown as MeshOracle;
    expect(verifyReviewedSurface(model, reviewed, blockedOracle)).toBeUndefined();
  });
});
