import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { placingPointOf, placingRayOf } from '../../src/ui/modelPlacement';
import { rayAngle } from '../../src/plan/aim';

const r = (p: number[]) => p.map((v) => Math.round(v * 1000) / 1000 || 0);

describe('placing point', () => {
  // the main model shown at a spot: 100 LDU along x and a quarter turn (a display-only move)
  const root = new THREE.Matrix4().makeTranslation(100, 0, 0).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  const bay = new THREE.Matrix4().makeTranslation(0, 0, 300);
  const placements = new Map([['b/1', bay]]);
  // the model point (20, 0, 0) where each is drawn, in view units (studs, y up, z flipped)
  const viewOf = (m: THREE.Matrix4) => { const p = new THREE.Vector3(20, 0, 0).applyMatrix4(m); return new THREE.Vector3(p.x / 20, -p.y / 20, -p.z / 20); };

  it('maps empty floor back through the model root', () => {
    expect(r(placingPointOf(viewOf(root), null, placements, root))).toEqual([20, 0, 0]);
  });

  it('maps a hit piece back through its own placement, else the root', () => {
    expect(r(placingPointOf(viewOf(bay), 'b/1', placements, root))).toEqual([20, 0, 0]);
    expect(r(placingPointOf(viewOf(root), 'loose', placements, root))).toEqual([20, 0, 0]);
  });

  it("maps the ray through the hit piece's placement", () => {
    const target = (m: THREE.Matrix4) => viewOf(m);
    for (const [key, m] of [['b/1', bay], [null, root], ['loose', root]] as const) {
      const at = target(m);
      const origin = at.clone().add(new THREE.Vector3(3, 7, -2));
      const dir = at.clone().sub(origin).multiplyScalar(5); // not unit length on purpose
      const ray = placingRayOf(origin, dir, key, placements, root);
      expect(Math.hypot(...ray.dir)).toBeCloseTo(1, 9);
      expect(rayAngle(ray, [20, 0, 0])).toBeLessThan(1e-6);
    }
  });
});

