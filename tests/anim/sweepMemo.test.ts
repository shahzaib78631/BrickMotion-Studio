import {expect,test}from'vitest';
import {assemble}from'../../src/model/assemble';
import {ensureIds}from'../../src/plan/ids';
import type{Plan}from'../../src/plan/types';
import {buildTimeline}from'../../src/anim/timeline';
import {encodeTimeline}from'../../src/anim/timelineCodec';
import {fixtureMetrics,fixtureColors}from'../helpers/fixtureMetrics';

class NoCache extends Map<string,boolean>{override get(_key:string):boolean|undefined{return undefined;}override set(_key:string,_value:boolean):this{return this;}}
test.each([false,true])('sweep certificate reuse preserves the complete timeline (overlapping=%s)',async overlapping=>{
 const metrics=await fixtureMetrics();
 const plan:Plan=ensureIds({format:'brickmotion-plan',version:1,name:'memo',steps:Array.from({length:overlapping?3:4},(_,level)=>({pieces:[
  {part:'3001',color:4,x:overlapping?level*.25:0,y:overlapping?0:level*3,z:0,rot:0 as const},
  ...(!overlapping?[{part:'3001',color:4,x:4,y:level*3,z:0,rot:0 as const}]:[]),
 ]}))});
 const assembly=assemble(plan,metrics,fixtureColors),opts={targetSeconds:15,heroOrbit:false,accessSearchAttempts:0};
 const cached=buildTimeline(assembly,metrics,opts,undefined,null,{}, {insertion:new Map(),translation:new Map()});
 const uncached=buildTimeline(assembly,metrics,opts,undefined,null,{}, {insertion:new NoCache(),translation:new NoCache()});
 expect(encodeTimeline(cached)).toEqual(encodeTimeline(uncached));
},30000);
