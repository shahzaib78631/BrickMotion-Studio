import { describe, expect, it } from 'vitest';
import { candidates, rayAngle, MAX_TARGETS, type Aim } from '../../src/plan/aim';
import type { Target } from '../../src/plan/placementEngine';
import type { Vec3 } from '../../src/ldraw/parse';

const stud = (x: number, y = 0, axis: Vec3 = [0, -1, 0], owner = 'p'): Target => ({ pos: [x, y, 0], axis, gender: 'M', type: 'stud', owner });
// looking straight down from 500 LDU above the origin (LDraw: up is -Y)
const down = (hitDepth: number | null = null): Aim => ({ ray: { origin: [0, -500, 0], dir: [0, 1, 0] }, hitDepth, floorPoint: null, hitPoint: null });

describe('aim', () => {
  it('ranks targets by how near the ray they are', () => {
    const got = candidates([stud(30), stud(5), stud(15)], down());
    expect(got.map((t) => t.pos[0])).toEqual([5, 15]);
  });

  it('drops connectors facing away and ones behind the hit surface', () => {
    expect(candidates([stud(0, 0, [0, 1, 0])], down())).toHaveLength(0);
    expect(candidates([stud(0, 20)], down(500))).toHaveLength(0);
    expect(candidates([stud(0, 4)], down(500))).toHaveLength(1);
    expect(candidates([stud(0, 0, [1, 0, 0])], down())).toHaveLength(1);
  });

  it('keeps at most MAX_TARGETS', () => {
    const many = Array.from({ length: 10 }, (_, i) => stud(i * 2));
    expect(candidates(many, down())).toHaveLength(MAX_TARGETS);
  });

  it('rayAngle is distance over depth', () => {
    expect(rayAngle(down().ray, [10, 0, 0])).toBeCloseTo(10 / 500, 9);
    expect(rayAngle(down().ray, [0, -600, 0])).toBe(Infinity);
  });
});

describe('floorAim', () => {
  it('reaches no connection, only the floor spot', async () => {
    const { floorAim } = await import('../../src/plan/aim');
    const a = floorAim([100, 0, 20]);
    expect(candidates([stud(100, 0), stud(100, -8), stud(100, 8, [0, 1, 0])], a)).toHaveLength(0);
    expect(a.floorPoint).toEqual([100, 0, 20]);
  });
});

describe('aimPoint', () => {
  it('is the hit along the ray, or null', async () => {
    const { aimPoint } = await import('../../src/plan/aim');
    expect(aimPoint(down(500))).toEqual([0, 0, 0]);
    expect(aimPoint(down())).toBeNull();
  });
});
