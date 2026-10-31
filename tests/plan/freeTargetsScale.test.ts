import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { findPose, freeTargets } from '../../src/plan/placementEngine';
import type { Connector } from '../../src/plan/connectors';
import type { Solid } from '../../src/plan/collision';

/** A flat grid of 2x2 plates (studs up), each its own piece, plus a second layer on half of them. */
function grid(n: number) {
  const groups: { list: Connector[]; owner: string }[] = [];
  const solids: Solid[] = [];
  const add = (id: string, x: number, z: number, top: number) => {
    const list: Connector[] = [];
    for (const dx of [-10, 10]) for (const dz of [-10, 10]) {
      list.push({ pos: [x + dx, top, z + dz], axis: [0, -1, 0], gender: 'M', type: 'stud' });
      list.push({ pos: [x + dx, top + 8, z + dz], axis: [0, 1, 0], gender: 'F', type: 'stud' });
    }
    groups.push({ list, owner: id });
    const world = new THREE.Matrix4().makeTranslation(x, top, z).elements;
    solids.push({ id, world, body: { min: [-20, 0, -20], max: [20, 8, 20] }, studs: [], snaps: [], mesh: null } as unknown as Solid);
  };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    add(`a${i}_${j}`, i * 40, j * 40, 0);
    if ((i + j) % 2 === 0) add(`b${i}_${j}`, i * 40, j * 40, -8);
  }
  return { groups, solids };
}

describe('free targets on a big model', () => {
  it('drops mated and covered connectors on a stacked grid', () => {
    const { groups, solids } = grid(2);
    const t = freeTargets(groups, solids);
    // a-plates under a b-plate lose their studs (mated) and the b-plates lose their sockets
    expect(t.filter((c) => c.owner === 'a0_0')).toHaveLength(4);
    expect(t.filter((c) => c.owner === 'a0_0').every((c) => c.gender === 'F')).toBe(true);
    expect(t.filter((c) => c.owner === 'b0_0').every((c) => c.gender === 'M')).toBe(true);
    expect(t.filter((c) => c.owner === 'a0_1')).toHaveLength(8);
  });

  it('works out ~1100 pieces quickly enough to start a drag', () => {
    const { groups, solids } = grid(27); // 729 + 365 pieces, ~8700 connectors
    const t0 = performance.now();
    freeTargets(groups, solids);
    expect(performance.now() - t0).toBeLessThan(400); // the pairwise version took ~1300 ms
  });

  it('scores poses against thousands of targets quickly', () => {
    const { groups, solids } = grid(27);
    const targets = freeTargets(groups, solids);
    // the moving set: 200 plates' worth of connectors
    const g10 = grid(10);
    const mine = g10.groups.slice(0, 200).flatMap((g) => g.list);
    const t0 = performance.now();
    let pose = null as ReturnType<typeof findPose> | null;
    for (let i = 0; i < 10; i++) pose = findPose({
      moving: { solids: g10.solids.slice(0, 200), connectors: mine }, targets,
      aim: { ray: { origin: [40, -408, 40], dir: [0, 1, 0] }, hitDepth: 400, floorPoint: [40, 0, 40] }, ref: [180, 8, 180], lock: null, yaw: 0, world: null, before: new Set(), prev: null,
    });
    expect(pose!.valid).toBe(true);
    expect(pose!.mated).toBeGreaterThan(0);
    expect((performance.now() - t0) / 10).toBeLessThan(150); // the unindexed version took ~600 ms
  });
});
