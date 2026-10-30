/** SNAP_GEN mates: LDCad pairs groupless generic snaps by size (`match=size`), like an engine piston on its connecting rod. */
import { describe, expect, it } from 'vitest';
import { mateAxis } from '../../src/anim/snapMates';
import type { Snap } from '../../src/ldraw/shadow';

type V3 = [number, number, number];
const ball = (gender: 'M' | 'F', at: V3, radius = 8, extra: Partial<Snap> = {}) => ({
  snap: { kind: 'gen', gender, start: at, axis: [0, 1, 0], length: 0, radius, shapes: ['GEN:sph'], slide: false, center: true, match: 'size', placement: 'free', ...extra } as Snap,
  start: at, axis: [0, 1, 0] as V3,
});

describe('generic snap mates', () => {
  it('groupless balls of one size mate where their centres meet', () => {
    expect(mateAxis(ball('M', [25, -119, 470]) as never, ball('F', [25.2, -119, 470]) as never)).not.toBeNull();
  });
  it('but not balls of another size, far apart, or without match=size', () => {
    expect(mateAxis(ball('M', [0, 0, 0]) as never, ball('F', [0, 0, 0], 6) as never)).toBeNull();
    expect(mateAxis(ball('M', [0, 0, 0]) as never, ball('F', [0, 10, 0]) as never)).toBeNull();
    expect(mateAxis(ball('M', [0, 0, 0], 8, { match: undefined }) as never, ball('F', [0, 0, 0], 8, { match: undefined }) as never)).toBeNull();
  });
  it('a ball sits in its socket up to half the ball radius off (a 42000 pushrod 3.6 LDU short of its wishbone ball)', () => {
    expect(mateAxis(ball('M', [-180, -20, 650]) as never, ball('F', [-182.3, -17.4, 650.9]) as never)).not.toBeNull();
    expect(mateAxis(ball('M', [0, 0, 0]) as never, ball('F', [4.5, 0, 0]) as never)).toBeNull();
  });
  it('grouped snaps still need the same group', () => {
    expect(mateAxis(ball('M', [0, 0, 0], 8, { group: 'a' }) as never, ball('F', [0, 0, 0], 8, { group: 'b' }) as never)).toBeNull();
  });
});
