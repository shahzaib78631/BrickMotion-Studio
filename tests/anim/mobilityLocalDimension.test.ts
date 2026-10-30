/** The local dimension test, checked against Wampler, Hauenstein & Sommese (2011), sec. 9.1, Table 2. */
import { describe, expect, it } from 'vitest';
import { SeriesSpace } from '../../src/anim/motion/mobility/series';
import { localDimension, macaulayCorank } from '../../src/anim/motion/mobility/localDimension';

type P = [number, number];
/** Their eq. (16): links of constant length; variables C, D, P (6 coordinates) around the pose of construction. */
function fourBar(A0: P, B0: P, C0: P, D0: P, P0: P) {
  const s = new SeriesSpace(6, 5);
  const h = [0, 1, 2, 3, 4, 5].map(k => s.variable(k));
  const pt = (z: P, i: number) => [s.constant(z[0]).plus(h[i]), s.constant(z[1]).plus(h[i + 1])];
  const C = pt(C0, 0), D = pt(D0, 2), Pp = pt(P0, 4);
  const sq = (a: ReturnType<typeof pt>, b: ReturnType<typeof pt>) => {
    const dx = a[0].minus(b[0]), dy = a[1].minus(b[1]);
    return dx.mul(dx).plus(dy.mul(dy));
  };
  const fixed = (z: P) => [s.constant(z[0]), s.constant(z[1])];
  const len = (a: P, b: P) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  return [
    sq(C, fixed(A0)).minus(s.constant(len(C0, A0))),
    sq(D, fixed(B0)).minus(s.constant(len(D0, B0))),
    sq(C, D).minus(s.constant(len(C0, D0))),
    sq(Pp, C).minus(s.constant(len(P0, C0))),
    sq(Pp, D).minus(s.constant(len(P0, D0))),
  ];
}

describe('local dimension test (Wampler et al. 2011, Table 2)', () => {
  it('a smooth point has corank sequence 1, 1 under one slice', () => {
    const f = fourBar([0, 0], [4, 0.3], [0.7, 2.1], [3.6, 2.9], [2.2, 4.4]);
    const r = localDimension(f, 1, 3, 5);
    expect(r.dimension).toBe(1);
    expect(r.sequences[0].coranks).toEqual([1, 1]);
  });
  it('the foldable four-bar in its folded pose: dimension 1, multiplicity 2 (1, 2, 2)', () => {
    // A0, B0, C0, D0 collinear: the folded pose is a self-crossing of the motion curve.
    const f = fourBar([0, 0], [5, 0], [2, 0], [7, 0], [3.1, 1.7]);
    const r = localDimension(f, 1, 3, 5);
    expect(r.dimension).toBe(1);
    expect(r.multiplicity).toBe(2);
    expect(r.sequences[0].coranks).toEqual([1, 2, 2]);
  });
  it('the degenerate four-bar (A0 = B0, C0 = D0) is really 2 DOF: k = 1 never stabilises (1..6)', () => {
    const f = fourBar([1, 1], [1, 1], [3.3, 2.5], [3.3, 2.5], [0.4, 3.9]);
    const r = localDimension(f, 1, 3, 5);
    expect(r.sequences[0]).toMatchObject({ k: 1, coranks: [1, 2, 3, 4, 5, 6], stabilised: false });
    expect(r.dimension).toBe(2);
    expect(r.multiplicity).toBe(1);
  });
  it('the Jacobian alone (depth 1) over-counts the folded pose', () => {
    // Corank of df at the folded pose is 2 although the motion is 1-dimensional.
    const f = fourBar([0, 0], [5, 0], [2, 0], [7, 0], [3.1, 1.7]);
    expect(macaulayCorank(f, 1) - 1).toBe(2);
  });
});

describe('LocalDimFinder manual example: f = x y^2, g = x z (Hauenstein 2010, Table 3)', () => {
  // Real stand-ins for the manual's complex points; the local structure is the same.
  const at = (z: [number, number, number]) => {
    const s = new SeriesSpace(3, 4);
    const [x, y, w] = [0, 1, 2].map(k => s.constant(z[k]).plus(s.variable(k)));
    return [x.mul(y).mul(y), x.mul(w)];
  };
  it('on the plane x = 0 away from the line: dimension 2, multiplicity 1, depth 0', () => {
    const r = localDimension(at([0, 1, -1]), 0, 2, 3);
    expect(r.sequences.map(q => q.coranks)).toEqual([[1, 3, 6, 10], [1, 2, 3, 4], [1, 1]]);
    expect(r).toMatchObject({ dimension: 2, multiplicity: 1, depth: 0 });
  });
  it('on the double line y = z = 0: dimension 1, multiplicity 2, depth 1', () => {
    const r = localDimension(at([2, 0, 0]), 0, 2, 3);
    expect(r.sequences.map(q => q.coranks)).toEqual([[1, 3, 5, 7], [1, 2, 2]]);
    expect(r).toMatchObject({ dimension: 1, multiplicity: 2, depth: 1 });
  });
});
