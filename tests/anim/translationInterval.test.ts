import { expect, test } from 'vitest';
import * as THREE from 'three';
import { canonicalTranslationInterval } from '../../src/anim/translationInterval';
import type { Box } from '../../src/ldraw/flatten';
import { shapeOf, translationClear } from '../../src/anim/shapes';
import { transformBox } from '../../src/model/assemble';

const bounds:Box={min:[-5,-5,-5],max:[5,5,5]};
test('empty-space extensions share an interval without merging partially traversed obstacles',()=>{
 expect(canonicalTranslationInterval(bounds,bounds,1,-100,100)).toEqual([-12,12]);
 expect(canonicalTranslationInterval(bounds,bounds,1,-200,200)).toEqual([-12,12]);
 expect(canonicalTranslationInterval(bounds,bounds,1,-100,0)).toEqual([-12,0]);
 expect(canonicalTranslationInterval(bounds,bounds,1,100,-100)).toEqual([12,-12]);
 expect(canonicalTranslationInterval(bounds,bounds,1,0,2)).toEqual([0,2]);
});
test('clipping empty travel agrees with full mesh sweeps for rotations, scales, misses and blocked walls',()=>{
 const raw=new THREE.BoxGeometry(10,10,10).toNonIndexed();
 const shape=shapeOf(new Float32Array(raw.getAttribute('position').array));raw.dispose();
 for(const scale of [1,2,.5])for(const angle of [0,.4,Math.PI/2])for(const x of [0,4,9,11,30]){
  const rotation=new THREE.Matrix4().makeRotationZ(angle).scale(new THREE.Vector3(scale,scale,scale));
  const ownBounds=transformBox(bounds,rotation),fixedBounds=bounds;
  const [lo,hi]=canonicalTranslationInterval(ownBounds,fixedBounds,1,-100,100);
  const fixed={shape,world:new THREE.Matrix4(),box:bounds};
  const run=(from:number,to:number)=>{
   const world=rotation.clone().setPosition(x,from,0);
   return translationClear({shape,world,box:transformBox(bounds,world)},fixed,[0,to-from,0]);
  };
  expect(run(-100,100)).toBe(run(lo,hi));
  expect(run(100,-100)).toBe(run(hi,lo));
 }
});
