import { describe, expect, it } from 'vitest';
import { bevelSharpEdges } from '../../src/ldraw/bevel';
import { hiResName } from '../../src/ldraw/flatten';

type V = [number, number, number];
const quad = (a: V, b: V, c: V, d: V) => [...a, ...b, ...c, ...a, ...c, ...d];
/** Axis box with outward CCW faces (three's convention). */
function box(min: V, max: V): number[] {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  return [
    ...quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]), // +z
    ...quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]), // -z
    ...quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]), // +x
    ...quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]), // -x
    ...quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]), // +y
    ...quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), // -y
  ];
}
const area = (p: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < p.length; i += 9) {
    const u = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]];
    const v = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
    s += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return s;
};
const bentCorners = (n: Float32Array) => {
  const out: V[] = [];
  for (let i = 0; i < n.length; i += 3) if (!Number.isNaN(n[i])) out.push([n[i], n[i + 1], n[i + 2]]);
  return out;
};

describe('bevelSharpEdges', () => {
  it('rounds every edge of a box without changing its surface', () => {
    const pts = box([0, 0, 0], [20, 20, 20]);
    const r = bevelSharpEdges(pts, 0.5);
    expect(area(r.positions)).toBeCloseTo(area(pts), 3);
    for (let i = 0; i < r.positions.length; i++) {
      expect(r.positions[i]).toBeGreaterThanOrEqual(-1e-6);
      expect(r.positions[i]).toBeLessThanOrEqual(20 + 1e-6);
    }
    const bent = bentCorners(r.normals);
    expect(bent.length).toBeGreaterThan(0);
    // every bent normal is the bisector of two faces: two components of ±0.707
    for (const n of bent) {
      const big = n.filter((c) => Math.abs(Math.abs(c) - Math.SQRT1_2) < 1e-4);
      expect(big.length).toBe(2);
    }
    // all 12 edges, from both sides
    const keys = new Set(bent.map((n) => n.map((c) => Math.round(c * 10)).join(',')));
    expect(keys.size).toBe(12);
  });

  it('leaves a flat sheet alone', () => {
    const pts = quad([0, 0, 0], [20, 0, 0], [20, 0, 20], [0, 0, 20]);
    const r = bevelSharpEdges(pts);
    expect(Array.from(r.positions)).toEqual(pts);
    expect(bentCorners(r.normals)).toHaveLength(0);
  });

  it('keeps inside corners sharp', () => {
    // an L step: floor at y=0 (up +y), wall at x=10 facing -x, rising to y=10
    const floor = quad([0, 0, 20], [10, 0, 20], [10, 0, 0], [0, 0, 0]);
    const wall = quad([10, 0, 20], [10, 10, 20], [10, 10, 0], [10, 0, 0]);
    const r = bevelSharpEdges([...floor, ...wall]);
    expect(bentCorners(r.normals)).toHaveLength(0);
  });

  it('finds the neighbour across a T-junction', () => {
    // top face is one quad, the front face is split in two along the same edge
    const top = quad([0, 10, 10], [20, 10, 10], [20, 10, 0], [0, 10, 0]);
    const front = [
      ...quad([0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]),
      ...quad([10, 0, 10], [20, 0, 10], [20, 10, 10], [10, 10, 10]),
    ];
    const r = bevelSharpEdges([...top, ...front]);
    const bent = bentCorners(r.normals);
    expect(bent.length).toBeGreaterThan(0);
    for (const n of bent) {
      expect(n[0]).toBeCloseTo(0);
      expect(n[1]).toBeCloseTo(Math.SQRT1_2);
      expect(n[2]).toBeCloseTo(Math.SQRT1_2);
    }
  });
});

describe('hiResName', () => {
  it('maps round primitives to their 48-segment twins', () => {
    expect(hiResName('4-4cyli.dat')).toBe('48/4-4cyli.dat');
    expect(hiResName('1-4EDGE.DAT')).toBe('48/1-4edge.dat');
    expect(hiResName('48\\4-4cyli.dat')).toBeNull();
    expect(hiResName('stud.dat')).toBeNull();
    expect(hiResName('box5.dat')).toBeNull();
  });
});
