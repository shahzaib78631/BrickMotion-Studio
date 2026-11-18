import {expect,test}from'vitest';
import * as THREE from 'three';
import {minimumJerk}from'../../src/anim/easing';
import {flightPose,type Move}from'../../src/anim/timeline';

test('minimum-jerk progress is monotone, exact at the endpoints and C2 at the midpoint',()=>{
 expect(minimumJerk(0)).toBe(0);expect(minimumJerk(1)).toBe(1);expect(minimumJerk(.5)).toBe(.5);
 let previous=0;for(let i=0;i<=1000;i++){const y=minimumJerk(i/1000);expect(y).toBeGreaterThanOrEqual(previous-1e-14);previous=y;}
 const h=1e-4,velocity=(t:number)=>(minimumJerk(t+h)-minimumJerk(t-h))/(2*h);
 const acceleration=(t:number)=>(minimumJerk(t+h)-2*minimumJerk(t)+minimumJerk(t-h))/(h*h);
 expect(velocity(0)).toBeLessThan(1e-6);expect(velocity(1)).toBeLessThan(1e-6);
 expect(Math.abs(acceleration(0))).toBeLessThan(.002);expect(Math.abs(acceleration(1))).toBeLessThan(.002);
 expect(Math.abs(acceleration(.5-h)-acceleration(.5+h))).toBeLessThan(.02);
});
test.each([false,true])('phased flight keeps exact endpoints and smooth acceleration at all joins (lateral=%s)',lateral=>{
 const m:Move={unit:0,from:new THREE.Matrix4().makeTranslation(-80,0,0),to:new THREE.Matrix4(),rel:null,skyY:-100,hold:0,entry:lateral?[30,0,0]:[0,0,0]};
 const at=(u:number)=>new THREE.Vector3().setFromMatrixPosition(flightPose(m,u,new THREE.Matrix4()));
 const h=1e-6,accel=(u:number)=>at(u+h).add(at(u-h)).addScaledVector(at(u),-2).multiplyScalar(1/(h*h));
 expect(at(0).toArray()).toEqual([-80,0,0]);expect(at(1).toArray()).toEqual([0,0,0]);
 for(const join of lateral?[.24,.56,.8]:[.24,.76])expect(accel(join-h).distanceTo(accel(join+h))).toBeLessThan(2);
});
