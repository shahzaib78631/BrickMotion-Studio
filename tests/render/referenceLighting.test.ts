import { expect, it } from 'vitest';
import * as THREE from 'three';
import { ReferenceLighting, DEFAULT_REFERENCE_LIGHTING } from '../../src/render/referenceLighting';
import { materialFor, setReferenceMaterialMode } from '../../src/render/materials';

it('reuses shadow depths for intensity/material edits, and invalidates for moving geometry or rig direction', () => {
  const rig = new ReferenceLighting(), camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 10, 20); camera.lookAt(0, 0, 0);
  const center = new THREE.Vector3();
  rig.update(camera, center, 10, 1, 1);
  for (const light of rig.casters) light.shadow.needsUpdate = false;
  rig.configure({ ...DEFAULT_REFERENCE_LIGHTING, strengths: [2, 2, 2, 2], roughness: 0.7 });
  rig.update(camera, center, 10, 1, 1);
  expect(rig.casters.every((light) => !light.shadow.needsUpdate)).toBe(true);
  rig.update(camera, center, 10, 1, 2);
  expect(rig.casters.every((light) => light.shadow.needsUpdate)).toBe(true);
  for (const light of rig.casters) light.shadow.needsUpdate = false;
  camera.position.set(20, 10, 0); camera.lookAt(0, 0, 0);
  rig.update(camera, center, 10, 1, 2);
  expect(rig.casters.every((light) => light.shadow.needsUpdate)).toBe(true);
  rig.dispose();
});

it('keeps angular source size independent of assembly scale', () => {
  const rig = new ReferenceLighting(), camera = new THREE.PerspectiveCamera();
  camera.position.z = 20; camera.lookAt(0, 0, 0);
  for (const radius of [1, 10, 100]) {
    rig.update(camera, new THREE.Vector3(), radius, 1, 1);
    const panel = rig.panels[0];
    const angle = 2 * Math.atan(panel.width / (2 * panel.position.length()));
    expect(angle).toBeCloseTo(DEFAULT_REFERENCE_LIGHTING.diameter, 6);
  }
  rig.dispose();
});

it('does not share shader programs across different fitted material responses', () => {
  setReferenceMaterialMode(true);
  const black = materialFor({ code: 0, name: 'Black', hex: '#000000', edge: '#333333', alpha: 255, finish: 'solid' }, false);
  const white = materialFor({ code: 15, name: 'White', hex: '#ffffff', edge: '#333333', alpha: 255, finish: 'solid' }, false);
  expect(black.customProgramCacheKey()).not.toBe(white.customProgramCacheKey());
  setReferenceMaterialMode(false);
  expect(black.customProgramCacheKey()).toBe(white.customProgramCacheKey());
});
