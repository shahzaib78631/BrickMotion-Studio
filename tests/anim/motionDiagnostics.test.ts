import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Instance } from '../../src/model/assemble';
import { checkEditedMotion } from '../../src/anim/motionDiagnostics';
import { emptyAnimation, insertKeys } from '../../src/anim/keyframes';

const part = (key: string, x: number): Instance => ({ key, itemId: key, model: '', part: '3001', color: 4,
  placeholder: false, grid: true, world: new THREE.Matrix4().makeTranslation(x, 0, 0),
  worldBox: { min: [x, -24, 0], max: [x + 20, 0, 20] } });

describe('conservative authored-motion review', () => {
  it('detects a newly swept crossing, labels it advisory', () => {
    const parts = [part('moving', 0), part('fixed', 80)];
    const animation = insertKeys(insertKeys(emptyAnimation(), 1, [
      { model: '', target: 'moving', channel: 'location.x', value: 0 },
    ], 'linear'), 24, [
      { model: '', target: 'moving', channel: 'location.x', value: 6 },
    ], 'linear');
    const report = checkEditedMotion(parts, new Map(), animation, '', null);
    expect(report.method).toBe('swept-bounds-advisory');
    expect(report.checkedFrames).toBeGreaterThan(1);
    expect(report.warnings.some((w) => w.first === 'moving' && w.second === 'fixed')).toBe(true);
  });
  it('does not warn when connected bricks translate as one rigid assembly', () => {
    const parts = [part('a', 0), part('b', 10)];
    const start = insertKeys(emptyAnimation(), 1, [
      { model: '', target: 'a', channel: 'location.x', value: 0 },
      { model: '', target: 'b', channel: 'location.x', value: 0 },
    ], 'linear');
    const moved = insertKeys(start, 24, [
      { model: '', target: 'a', channel: 'location.x', value: 5 },
      { model: '', target: 'b', channel: 'location.x', value: 5 },
    ], 'linear');
    expect(checkEditedMotion(parts, new Map(), moved, '', null).warnings).toHaveLength(0);
  });

  it('skips hidden pieces and unchanged static object tracks', () => {
    const parts = [part('moving', 0), part('fixed', 80)];
    const hidden = insertKeys(emptyAnimation(), 1, [
      { model: '', target: 'moving', channel: 'visibility', value: 0 },
    ]);
    expect(checkEditedMotion(parts, new Map(), hidden, '', null).warnings).toHaveLength(0);
  });
});
