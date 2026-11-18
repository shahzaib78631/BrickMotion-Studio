import { expect, test } from 'vitest';
import * as THREE from 'three';
import { ShadowCache } from '../../src/render/shadowCache';

test('camera-only motion reuses shadows; poses, lighting and material edits invalidate them', () => {
 const scene=new THREE.Scene(), root=new THREE.Group(), light=new THREE.DirectionalLight();
 light.castShadow=true;scene.add(root,light,light.target);
 const cache=new ShadowCache();
 const update=(structure=1,pose=1,revision=1)=>cache.update(scene,root,structure,pose,revision);
 const rendered=()=>{light.shadow.needsUpdate=false;};
 update();expect(light.shadow.needsUpdate).toBe(true);expect(light.shadow.autoUpdate).toBe(false);
 rendered();update();expect(light.shadow.needsUpdate).toBe(false);
 const camera=new THREE.PerspectiveCamera();scene.add(camera);camera.position.x=10;
 update();expect(light.shadow.needsUpdate).toBe(false);
 update(1,2);expect(light.shadow.needsUpdate).toBe(true);
 rendered();update(1,2);expect(light.shadow.needsUpdate).toBe(false);
 update(2,2);expect(light.shadow.needsUpdate).toBe(true);
 rendered();update(2,2,2);expect(light.shadow.needsUpdate).toBe(true);
 rendered();light.position.y=5;update(2,2,2);expect(light.shadow.needsUpdate).toBe(true);
 rendered();light.target.position.x=3;update(2,2,2);expect(light.shadow.needsUpdate).toBe(true);
 rendered();root.position.z=9;update(2,2,2);expect(light.shadow.needsUpdate).toBe(true);
 rendered();light.shadow.camera.far=80;light.shadow.camera.updateProjectionMatrix();update(2,2,2);expect(light.shadow.needsUpdate).toBe(true);
});
