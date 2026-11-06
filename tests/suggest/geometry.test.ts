import { describe, expect, it } from 'vitest';
import { angledWall, lowellSphere, pythagoreanTriples, roundWall, snotSpacing, technicPolygon, wedgeFor } from '../../src/suggest/geometry';

// expected values are the Brick Builder's Handbook's own worked numbers
describe('technique maths', () => {
  it('lists the exact triples up to 25', () => {
    // the handbook's list, plus 15-20-25 (3-4-5 × 5) which it leaves out
    expect(pythagoreanTriples(25)).toEqual([[3, 4, 5], [5, 12, 13], [6, 8, 10], [7, 24, 25], [8, 15, 17], [9, 12, 15], [12, 16, 20], [15, 20, 25]]);
  });

  it('finds 3-4-5 for 36.87° and a near triple for 45°', () => {
    const w = angledWall(36.87)[0];
    expect(w.exact).toBe(true);
    expect(w.span).toBe(5);
    expect(w.legs).toEqual([4, 3]);
    const f = angledWall(45)[0];
    expect(f.exact).toBe(false);
    expect(f.legs[0]).toBe(f.legs[1]);
  });

  it('closes an 18-stud round wall with 14 hinge plates at 12.86°', () => {
    const r = roundWall(18);
    expect(r.hinges).toBe(14);
    expect(r.sides).toBe(28);
    expect(r.turn).toBeCloseTo(12.857, 2);
  });

  it('gets 36.87° from two mirrored 6×3 wedges', () => {
    const best = wedgeFor(36.87).find((w) => w.pair && w.wedge.size === '6×3');
    expect(best).toBeDefined();
    expect(best!.error).toBeLessThan(0.01);
  });

  it('builds an octagon from #4 connectors', () => {
    const p = technicPolygon(8, 5);
    expect(p.connector?.part).toBe('32192');
    expect(p.apothem).toBeCloseTo(6.04, 1);
    expect(p.axle).toBe(4);
  });

  it('sizes the Taj Mahal Lowell sphere (16 core, 14-plate panels, 27.2 studs)', () => {
    expect(lowellSphere(27.2)).toEqual({ core: 16, panelPlates: 14, actual: 27.2 });
  });

  it('spaces side studs: 2 studs is a brick and 2 plates', () => {
    expect(snotSpacing(2)).toEqual({ plates: 5, fill: '1 brick + 2 plates', halfPlate: false });
    expect(snotSpacing(1).halfPlate).toBe(true);
  });
});
