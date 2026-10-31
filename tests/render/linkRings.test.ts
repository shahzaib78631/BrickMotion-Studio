import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LinkRings } from '../../src/render/linkRings';

describe('link rings', () => {
  it('places one ring per link facing its axis', () => {
    const scene = new THREE.Scene();
    const rings = new LinkRings(scene);
    // LDraw → view: studs, y up, z flipped
    const toView = new THREE.Matrix4().makeScale(1 / 20, -1 / 20, -1 / 20);
    rings.show([{ pos: [20, -8, 0], axis: [0, -1, 0] }, { pos: [0, 10, -10], axis: [0, 0, -1] }], toView);
    const shown = rings.group.children.filter((c) => c.visible);
    expect(shown).toHaveLength(2);
    expect(shown[0].position.toArray().map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 0.4, 0]);
    // a ring's own z is its axis: the first faces up in the view, the second toward +z
    const normal = (o: THREE.Object3D) => new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
    expect(Math.abs(normal(shown[0]).y)).toBeCloseTo(1, 6);
    expect(Math.abs(normal(shown[1]).z)).toBeCloseTo(1, 6);
    rings.clear();
    expect(rings.group.children.filter((c) => c.visible)).toHaveLength(0);
    rings.dispose();
    expect(scene.children).not.toContain(rings.group);
  });
});
