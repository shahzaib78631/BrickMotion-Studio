import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { boxSelect } from '../../src/ui/boxSelect';
import type { Box } from '../../src/ldraw/flatten';

// looking straight down at the origin; 200 px across shows 20 studs (400 LDU)
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
camera.position.set(0, 50, 0);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const size = { w: 200, h: 200 };
/** a 1x1 brick footprint centred at LDraw (x, z) */
const at = (key: string, x: number, z: number): { key: string; box: Box } => ({ key, box: { min: [x - 10, -24, z - 10], max: [x + 10, 0, z + 10] } });

describe('box select', () => {
  it('selects pieces whose centre is inside the rectangle', () => {
    // LDraw +x is screen right; LDraw +z is world -z, which this camera shows downward
    const items = [at('a', -100, 0), at('b', -60, 0), at('c', 120, 0)];
    expect(boxSelect(items, camera, { x0: 0, y0: 80, x1: 100, y1: 120 }, size, new Set()).sort()).toEqual(['a', 'b']);
  });

  it('accepts a rectangle dragged in any direction', () => {
    const items = [at('a', -100, 0)];
    expect(boxSelect(items, camera, { x0: 100, y0: 120, x1: 0, y1: 80 }, size, new Set())).toEqual(['a']);
  });

  it('skips hidden pieces', () => {
    const items = [at('a', -100, 0), at('b', -60, 0)];
    expect(boxSelect(items, camera, { x0: 0, y0: 80, x1: 100, y1: 120 }, size, new Set(['b']))).toEqual(['a']);
  });

  it('returns each submodel use once', () => {
    const items = [at('s/0', -100, 0), at('s/1', -60, 0)];
    expect(boxSelect(items, camera, { x0: 0, y0: 80, x1: 100, y1: 120 }, size, new Set())).toEqual(['s']);
  });
});
