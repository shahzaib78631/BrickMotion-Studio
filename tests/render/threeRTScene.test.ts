import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { describeMaterial, instanceWorldMatrices, shown, uploadGeometry } from '../../src/render/threert/scene';

describe('ThreeRT scene bridge', () => {
  it('preserves affine world transforms, reflection and zero-scale hidden instances', () => {
    const root = new THREE.Group(); root.rotation.x = Math.PI; root.scale.setScalar(0.05);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 3);
    root.add(mesh);
    const local = new THREE.Matrix4().set(-1, 0.2, 0, 20, 0, 1, 0, 24, 0, 0, 1, -5, 0, 0, 0, 1);
    mesh.setMatrixAt(0, local); mesh.setMatrixAt(1, new THREE.Matrix4().makeScale(0, 0, 0));
    mesh.setMatrixAt(2, new THREE.Matrix4().makeTranslation(40, 0, 0)); root.updateMatrixWorld(true);
    const matrices = instanceWorldMatrices(mesh);
    const expected = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, local);
    Array.from(matrices.slice(0, 16)).forEach((value, i) => expect(value).toBeCloseTo(expected.elements[i], 6));
    expect(new THREE.Matrix4().fromArray(matrices, 0).determinant()).toBeLessThan(0);
    expect(new THREE.Matrix4().fromArray(matrices, 16).determinant()).toBe(0);
    expect(matrices[44]).toBeCloseTo(2);
  });
  it('uploads draw ranges, material groups and generated normals without mutating the source', () => {
    const geometry = new THREE.BoxGeometry().toNonIndexed(); geometry.deleteAttribute('normal');
    geometry.clearGroups(); geometry.addGroup(0, 6, 0); geometry.addGroup(6, 6, 1); geometry.setDrawRange(3, 9);
    let call: unknown[] = [];
    uploadGeometry({ geometry: (...args) => { call = args; } }, 7, geometry);
    expect(call[0]).toBe(7); expect((call[2] as Float32Array).length).toBe(108);
    expect(Array.from(call[4] as Uint32Array)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(Array.from(call[5] as Uint32Array)).toEqual([0, 3, 0, 3, 6, 1]);
    expect(geometry.getAttribute('normal')).toBeUndefined();
  });
  it('uses linear material values and respects ancestor visibility', () => {
    const m = new THREE.MeshPhysicalMaterial({ color: '#7799bb', transmission: 1, ior: 1.52, roughness: 0.07, side: THREE.DoubleSide });
    const d = describeMaterial(m);
    expect(d.color).toEqual(m.color.toArray()); expect(d.transmission).toBe(1); expect(d.ior).toBe(1.52); expect(d.doubleSided).toBe(true);
    const parent = new THREE.Group(), child = new THREE.Group(); parent.add(child); expect(shown(child)).toBe(true);
    parent.visible = false; expect(shown(child)).toBe(false);
  });
});
