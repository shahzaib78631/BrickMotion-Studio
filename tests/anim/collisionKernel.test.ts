import{expect,test,vi}from'vitest';
import{readFileSync}from'node:fs';
import{createHash}from'node:crypto';
import * as THREE from'three';
import{shapeOf,translationClear,crossings,type Placed}from'../../src/anim/shapes';
import{initializeCollisionKernel,disableCollisionKernel,collisionKernelActive,compiledSweepHits}from'../../src/anim/collisionKernel';
import{transformBox}from'../../src/model/assemble';
import type{Box}from'../../src/ldraw/flatten';

const bytes=()=>readFileSync('src/anim/kernel/collision.wasm');
test('compiled sweeps match JS scores and verdicts on solids, holes, scales, mirrors and direction changes',async()=>{
 const definitions=[new THREE.BoxGeometry(10,10,10),new THREE.TorusGeometry(7,2,6,12)];
 const shapes=definitions.map(g=>{const raw=g.toNonIndexed(),positions=new Float32Array(raw.getAttribute('position').array);raw.computeBoundingBox();const b=raw.boundingBox!;
  const body:Box={min:b.min.toArray(),max:b.max.toArray()};const shape=shapeOf(positions);g.dispose();raw.dispose();return{shape,body};});
 const cases:{a:Placed;b:Placed;delta:[number,number,number]}[]=[];
 for(const a of shapes)for(const b of shapes)for(const scale of [1,.5,-1])for(const y of [0,4.9,5.1,9.9,10,10.1,15]){
  const world=new THREE.Matrix4().makeRotationZ(.3).scale(new THREE.Vector3(scale,Math.abs(scale),1)).setPosition(-15,y,0);
  const fixed=new THREE.Matrix4().makeRotationY(.2);
  for(const delta of [[30,0,0],[-30,0,0],[20,20,0]] as [number,number,number][]){
   const moving=world.clone();if(delta[0]<0)moving.elements[12]=15;
   cases.push({a:{shape:a.shape,world:moving,box:transformBox(a.body,moving)},b:{shape:b.shape,world:fixed,box:transformBox(b.body,fixed)},delta});
  }
 }
 const run=()=>cases.map(({a,b,delta})=>{
  const length=Math.hypot(...delta),direction=delta.map(v=>v/length) as [number,number,number];
  const scratch=()=>({inv:new THREE.Matrix4(),rel:new THREE.Matrix4()});
  return[translationClear(a,b,delta),...([0,.085,1]as const).map(cap=>crossings(a,[b],direction,scratch(),cap,length))];
 });
 disableCollisionKernel();const reference=run();
 expect(await initializeCollisionKernel(bytes())).toBe(true);const compiled=run();
 expect(collisionKernelActive()).toBe(true);expect(compiled).toEqual(reference);
 disableCollisionKernel();
},30000);
test('invalid or unavailable binary safely leaves JavaScript enabled',async()=>{
 expect(await initializeCollisionKernel(new Uint8Array([0,1,2]))).toBe(false);
 expect(collisionKernelActive()).toBe(false);
});

test('checked-in binary is built from the current reviewed source',()=>{
 const manifest=JSON.parse(readFileSync('src/anim/kernel/manifest.json','utf8'));
 const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
 expect(hash('src/anim/kernel/collision.rs')).toBe(manifest.sourceSha256);
 expect(hash('src/anim/kernel/collision.wasm')).toBe(manifest.binarySha256);
 expect(manifest.abi).toBe(1);
});

test('numeric overflow falls back instead of returning a native clear certificate',async()=>{
 const geometry=new THREE.BoxGeometry(10,10,10).toNonIndexed();
 const shape=shapeOf(new Float32Array(geometry.attributes.position.array));geometry.dispose();
 expect(await initializeCollisionKernel(bytes())).toBe(true);
 const result=compiledSweepHits(shape,shape,[1,0,0],30,new THREE.Matrix4().makeScale(1e308,1,1),new THREE.Matrix4(),.3,0);
 expect(result).toBeUndefined();expect(collisionKernelActive()).toBe(false);
});

test('optional asset failures fall back and can recover on the next job',async()=>{
 await initializeCollisionKernel(new Uint8Array([0,1,2]));
 const fetch=vi.spyOn(globalThis,'fetch');
 try{
  fetch.mockRejectedValueOnce(Error('offline'));
  expect(await initializeCollisionKernel()).toBe(false);
  fetch.mockResolvedValueOnce(new Response(new Uint8Array(bytes())));
  expect(await initializeCollisionKernel()).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
 }finally{fetch.mockRestore();disableCollisionKernel();}
});
