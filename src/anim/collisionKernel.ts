import type * as THREE from 'three';
import type { Shape } from './shapes';
import { triangleData } from './triangleData';

type Kernel = {memory:WebAssembly.Memory; __heap_base:WebAssembly.Global; abi_version():number;
 sweep_hits(from:number,into:number,args:number,limit:number,hint:number):number; last_probe():number};
let kernel:Kernel|null=null, loaded:Promise<Kernel|null>|null=null;
let next=0, scratch=0, shapes=new WeakMap<Shape,number>();
let hints=new WeakMap<Shape,WeakMap<Shape,number>>();
const MAX_BYTES=256*1024*1024;

/** Once per worker, then reset job-scoped geometry storage between requests.
 * Unsupported/CSP-blocked WebAssembly keeps the existing JS checker available. */
export async function initializeCollisionKernel(bytes?:BufferSource):Promise<boolean>{
 if(bytes)loaded=null;
 loaded??=(async()=>{
  try{
   const source=bytes??await (await fetch(new URL('./kernel/collision.wasm',import.meta.url),{signal:AbortSignal.timeout(3000)})).arrayBuffer();
   const result=await WebAssembly.instantiate(source,{}),exports=result.instance.exports as unknown as Kernel;
   return exports.abi_version()===1?exports:null;
  }catch{return null;}
 })();
 kernel=await loaded;
 if(!kernel)loaded=null; // Retry an optional asset on a later job after a transient failure.
 try{resetCollisionKernel();}catch{kernel=null;}
 return !!kernel;
}
export function resetCollisionKernel():void{
 shapes=new WeakMap();hints=new WeakMap();
 next=kernel?Number(kernel.__heap_base.value):0;
 if(kernel)scratch=allocate(37*8);
}
/** Tests/diagnostics can compare the complete JS and compiled paths explicitly. */
export function disableCollisionKernel():void{kernel=null;}
export function collisionKernelActive():boolean{return kernel!==null;}
function allocate(bytes:number):number{
 const start=(next+15)&~15;next=start+bytes;
 if(next>MAX_BYTES)throw Error('Collision kernel memory budget exceeded');
 const memory=kernel!.memory;
 if(next>memory.buffer.byteLength)memory.grow(Math.ceil((next-memory.buffer.byteLength)/65536));
 return start;
}
function copy(array:ArrayBufferView):number{
 const pointer=allocate(array.byteLength);
 new Uint8Array(kernel!.memory.buffer,pointer,array.byteLength).set(new Uint8Array(array.buffer,array.byteOffset,array.byteLength));
 return pointer;
}
function pack(shape:Shape):number{
 const known=shapes.get(shape);if(known!==undefined)return known;
 if(!shape.tris.every(Number.isFinite)||!shape.points.every(Number.isFinite))throw Error('Non-finite collision geometry');
 const pointer=allocate(32),tris=copy(shape.tris),data=copy(triangleData(shape.tris)),points=copy(shape.points),sides=copy(shape.twoSided);
 const nodes:Shape['tree'][]=[];
 const add=(node:Shape['tree']):number=>{const i=nodes.length;nodes.push(node);if(node.left){add(node.left);add(node.right!);}return i;};
 add(shape.tree);const indices=new Map(nodes.map((node,i)=>[node,i]));const tree=allocate(nodes.length*64);
 nodes.forEach((node,i)=>{
  if(![...node.min,...node.max].every(Number.isFinite))throw Error('Non-finite collision bounds');
  const base=tree+i*64;
  new Float64Array(kernel!.memory.buffer,base,6).set([...node.min,...node.max]);
  new Int32Array(kernel!.memory.buffer,base+48,4).set([node.left?indices.get(node.left)!:-1,node.right?indices.get(node.right)!:-1,node.first,node.count]);
 });
 new Uint32Array(kernel!.memory.buffer,pointer,8).set([tris,data,points,sides,tree,shape.points.length/3,nodes.length,shape.tris.length/9]);
 shapes.set(shape,pointer);return pointer;
}
/** Batch a complete surface sweep across the boundary once, not once per ray.
 * Localized joint-contact policies stay on the JS path until ported/verified. */
export function compiledSweepHits(from:Shape,into:Shape,worldDirection:readonly number[],maxT:number,
 toLocal:THREE.Matrix4,intoInv:THREE.Matrix4,contactTolerance:number,limit:number):number|undefined{
 if(!kernel||!Number.isFinite(maxT)||maxT<=0||!Number.isFinite(limit)||limit<0||limit>0xffffffff||
  ![...worldDirection,...toLocal.elements,...intoInv.elements,contactTolerance].every(Number.isFinite))return undefined;
 try{
  const a=pack(from),b=pack(into);
  const args=new Float64Array(kernel.memory.buffer,scratch,37);
  args.set(toLocal.elements,0);args.set(intoInv.elements,16);args.set(worldDirection,32);args[35]=maxT;args[36]=contactTolerance;
  const hint=limit===0?hints.get(from)?.get(into)??-1:-1;
  const result=kernel.sweep_hits(a,b,scratch,limit,hint);
  if(result>from.points.length/3)throw Error('Invalid collision-kernel result');
  if(limit===0&&result>0){let table=hints.get(from);if(!table)hints.set(from,(table=new WeakMap()));table.set(into,kernel.last_probe());}
  return result;
 }catch{kernel=null;return undefined;}
}
