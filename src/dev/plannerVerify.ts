import * as THREE from 'three';
import { buildTimeline } from '../anim/timeline';
import { encodeTimeline } from '../anim/timelineCodec';
import { assemble } from '../model/assemble';
import { ensureIds } from '../plan/ids';
import type { Plan } from '../plan/types';
import type { PartMetrics } from '../ldraw/metrics';
import type { ColorDef } from '../ldraw/colors';
import type { PlanRequest, PlanResponse } from '../anim/timeline.worker';
const state={ready:true,error:'',shaderErrors:[] as string[],results:[] as unknown[]};
const worker=new Worker(new URL('../anim/timeline.worker.ts',import.meta.url),{type:'module'});
const geometry=new THREE.BoxGeometry(20,8,20).toNonIndexed();
const metric:PartMetrics={id:'test',body:{min:[-10,-4,-10],max:[10,4,10]},full:{min:[-10,-4,-10],max:[10,4,10]},footprint:{w:1,d:1},heightPlates:1,placeholder:false,mesh:new Float32Array(geometry.attributes.position.array),meshTwoSidedFrom:12};geometry.dispose();
const color:ColorDef={code:4,name:'Red',hex:'#c41a17',edge:'#333333',alpha:255,finish:'solid'};
const colors=new Map([[4,color]]),opts={targetSeconds:15,heroOrbit:false,accessSearchAttempts:0};
let nextId=1;
async function verify(){
 for(const mirror of [false,true]){
  const plan:Plan=ensureIds({format:'brickmotion-plan',version:1,name:'worker',steps:[{pieces:[
   {part:'test',color:4,ldu:[0,0,0],matrix:mirror?[-1,0,0,0,1,0,0,0,1]:[1,0,0,0,1,0,0,0,1]},
   {part:'test',color:4,ldu:[20,0,0],matrix:[1,0,0,0,1,0,0,0,1]},
  ]},{pieces:[{part:'test',color:4,ldu:[0,-8,0],matrix:[1,0,0,0,1,0,0,0,1]}]}]});
  const assembly=assemble(plan,()=>metric,colors),expected=encodeTimeline(buildTimeline(assembly,()=>metric,opts));
  const id=nextId++,start=performance.now();let progress=0;
  const reply=await new Promise<Extract<PlanResponse,{ok:true}>>((resolve,reject)=>{
   worker.onerror=e=>reject(Error(e.message));worker.onmessage=({data}:MessageEvent<PlanResponse>)=>{
    if(data.id!==id)return;if('progress'in data){progress++;return;}
    if(data.ok===false)reject(Error(data.error));else resolve(data);
   };
   const request:PlanRequest={id,plan,opts,metrics:[['test',metric]],colors:[...colors]};worker.postMessage(request);
  });
  if(reply.collisionBackend!=='wasm')throw Error('Compiled worker backend unavailable');
  if(JSON.stringify(reply.result)!==JSON.stringify(expected))throw Error('Worker/main timeline mismatch');
  state.results.push({mirror,backend:reply.collisionBackend,identical:true,ms:performance.now()-start,progress});
 }
 document.getElementById('results')!.textContent=JSON.stringify(state,null,2);return state;
}
Object.assign(window,{__aoBench:state,aoBench:{verify}});
