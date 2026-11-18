import {expect,test}from'vitest';
import * as THREE from 'three';
import {spreadProbeOrder}from'../../src/anim/probeOrder';
import {shapeOf,translationClear,crossings,type Shape,type Placed}from'../../src/anim/shapes';
import {transformBox}from'../../src/model/assemble';
import type{Box}from'../../src/ldraw/flatten';

test.each([0,1,2,7,32,33,1500,1501])('all %i collision probes are retained once',count=>{
 const order=Array.from(spreadProbeOrder(count));
 expect([...order].sort((a,b)=>a-b)).toEqual(Array.from({length:count},(_,i)=>i));
 if(count>32){
  const bins=new Set(order.slice(0,32).map(n=>Math.floor(n/count*8)));
  expect(bins.size).toBe(8);
  const remaining=order.slice(32);expect(remaining).toEqual([...remaining].sort((a,b)=>a-b));
 }
});
test('probe order and remembered witnesses cannot change clear/blocked decisions or crossing scores',()=>{
 const geometry=new THREE.BoxGeometry(10,10,10).toNonIndexed();const base=shapeOf(new Float32Array(geometry.getAttribute('position').array));geometry.dispose();
 const points=base.points;const reversed=new Float32Array(points.length);
 for(let i=0;i<points.length;i+=3)reversed.set(points.subarray(i,i+3),points.length-3-i);
 const shuffled:Shape={...base,points:reversed};
 const body:Box={min:[-5,-5,-5],max:[5,5,5]};
 const placed=(shape:Shape,x:number,y:number):Placed=>{const world=new THREE.Matrix4().makeTranslation(x,y,0);return{shape,world,box:transformBox(body,world)};};
 for(const x of [-12,-5,0,5,12])for(const y of [0,4.9,5.1,10]){
  const a=placed(base,-15,0),b=placed(base,x,y),c=placed(shuffled,-15,0),e=placed(shuffled,x,y);
  for(const cap of [0,.085,Infinity]){
   const scratch=()=>({inv:new THREE.Matrix4(),rel:new THREE.Matrix4()});
   expect(crossings(a,[b],[1,0,0],scratch(),cap,30)).toBe(crossings(c,[e],[1,0,0],scratch(),cap,30));
  }
  expect(translationClear(a,b,[30,0,0])).toBe(translationClear(c,e,[30,0,0]));
 }
 // A witness from a previous obstruction is rechecked after the obstacle moves.
 expect(translationClear(placed(base,-15,0),placed(base,0,0),[30,0,0])).toBe(false);
 expect(translationClear(placed(base,-15,0),placed(base,0,30),[30,0,0])).toBe(true);
});
