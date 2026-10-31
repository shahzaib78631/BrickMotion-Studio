import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { accumulateWeights, movedPixels, subframeOffsets, subframeCount } from '../../src/render/motionBlur';
import type { CameraShot } from '../../src/anim/cameraTrack/types';

describe('subframeCount', () => {
  it('one frame when the shutter is closed or nothing moves', () => {
    expect(subframeCount(0, 100, 12)).toBe(1);
    expect(subframeCount(0.5, 0.5, 12)).toBe(1);
  });
  it('more sub-frames the further the picture moves, within the limit', () => {
    expect(subframeCount(0.5, 60, 12)).toBe(10);
    expect(subframeCount(1, 1000, 4)).toBe(4);
    expect(subframeCount(0.5, 2, 12)).toBe(2);
  });
});

describe('accumulateWeights', () => {
  it('sum to one and are the same from either end', () => {
    for (const n of [1, 2, 5, 12]) {
      const w = accumulateWeights(n);
      expect(w).toHaveLength(n);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      for (let i = 0; i < n; i++) expect(w[i]).toBeCloseTo(w[n - 1 - i], 10);
    }
  });
});

describe('subframeOffsets', () => {
  it('spread across the open shutter, centred on the frame', () => {
    expect(subframeOffsets(1, 0.5, 30)).toEqual([0]);
    const o = subframeOffsets(3, 0.5, 30);
    expect(o[0]).toBeCloseTo(-0.25 / 30);
    expect(o[1]).toBeCloseTo(0);
    expect(o[2]).toBeCloseTo(0.25 / 30);
  });
});

describe('movedPixels', () => {
  const shot = (az: number): CameraShot => {
    const target = new THREE.Vector3();
    const a = THREE.MathUtils.degToRad(az);
    return { position: new THREE.Vector3(Math.sin(a) * 40, 10, Math.cos(a) * 40), target, fov: 30, roll: 0, lensMm: 50, focus: 0.5, blur: 0, shutter: 0.5 };
  };
  const box = new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 10, 5));
  it('is zero for a still camera', () => {
    expect(movedPixels(shot(0), shot(0), box, 1080, 1920, 0)).toBeCloseTo(0, 6);
  });
  it('grows with the camera move and adds the bricks\' own movement', () => {
    const small = movedPixels(shot(0), shot(1), box, 1080, 1920, 0);
    const big = movedPixels(shot(0), shot(5), box, 1080, 1920, 0);
    expect(small).toBeGreaterThan(1);
    expect(big).toBeGreaterThan(small * 3);
    expect(movedPixels(shot(0), shot(0), box, 1080, 1920, 7)).toBeCloseTo(7, 6);
  });
});
