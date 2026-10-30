/** V6 review-only bridge from LDCad rigid clusters to the spatial solver.
 * The user must select both the driving joint and grounded component. There
 * are intentionally strict caps: omitting a connected body would invent DOF.
 */
import type { Assembly } from '../../../model/assemble';
import type { MechanismGraph, MechanismEdge } from '../v4/mechanismGraph';
import type { SpatialConstraint, SpatialModel, V3 } from '../kinematics/spatialModel';

export type SpatialLinkagePreview = {
  model: SpatialModel;
  members: Readonly<Record<string,readonly string[]>>;
  driver: string;
  kind: 'hinge'|'slider';
  source: 'ldcad-shadow-review'|'user-authored-json';
  warning: string;
};
const v=(a:readonly number[]):V3=>[a[0],a[1],a[2]];
const sub=(a:V3,b:V3):V3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const centre=(b:{min:readonly number[];max:readonly number[]}):V3=>[
  (b.min[0]+b.max[0])/2,(b.min[1]+b.max[1])/2,(b.min[2]+b.max[2])/2];
const moving=(e:MechanismEdge)=>e.motion==='revolute'||e.motion==='sliding'||e.motion==='ball';

export function createSpatialLinkagePreview(asm:Assembly,graph:MechanismGraph,
  driverEdgeId:string,groundMember:string):SpatialLinkagePreview {
 const instances=new Map(asm.instances.map(i=>[i.key,i]));
 if(!instances.has(groundMember))throw Error('Ground must be a real placed part');
 const groups=graph.rigidClusters;
 const owners=new Map<string,string>();
 for(const cluster of groups)for(const member of cluster){
  if(owners.has(member)&&owners.get(member)!==cluster[0])
   throw Error(`Part ${member} belongs to multiple rigid clusters; review LDCad connections`);
  owners.set(member,cluster[0]);
 }
 // Test graphs may omit isolated clusters; use individual instance IDs instead.
 for(const key of instances.keys())if(!owners.has(key))owners.set(key,key);
 const owner=(key:string)=>owners.get(key)??key;
 const driverEdge=graph.edges.find(e=>e.id===driverEdgeId&&moving(e));
 if(!driverEdge)throw Error('Choose a real detected hinge / slider / ball joint to drive');
 if(driverEdge.motion==='ball')throw Error('Ball joints are not single-angle motors; select a hinge or slider');
 const all=graph.edges.filter(e=>moving(e)&&owner(e.a)!==owner(e.b));
 const ground=owner(groundMember);
 if(![driverEdge.a,driverEdge.b].some(k=>owner(k)===ground) &&
   !all.some(e=>owner(e.a)===ground||owner(e.b)===ground))
   throw Error('Selected ground is not part of the detected moving mechanism');
 const links=new Map<string,MechanismEdge[]>();
 for(const e of all)for(const side of [owner(e.a),owner(e.b)]){
  const list=links.get(side)??[];list.push(e);links.set(side,list);
 }
 const connected=new Set([ground]),queue=[ground];
 for(let i=0;i<queue.length;i++){
  for(const e of links.get(queue[i])??[]){
   const other=owner(e.a)===queue[i]?owner(e.b):owner(e.a);
   if(connected.has(other))continue;
   connected.add(other);queue.push(other);
   if(connected.size>13)throw Error('Detected moving component has over 13 rigid bodies; isolate a smaller submodel. No joints were silently ignored.');
  }
 }
 if(!connected.has(owner(driverEdge.a))||!connected.has(owner(driverEdge.b)))
  throw Error('Chosen motor is not connected to the explicitly grounded component');
 const memberMap=new Map<string,string[]>();
 for(const key of instances.keys()){
  const id=owner(key);if(!connected.has(id))continue;
  const members=memberMap.get(id)??[];members.push(key);memberMap.set(id,members);
 }
 if([...memberMap.values()].reduce((n,a)=>n+a.length,0)>180)
  throw Error('This linkage contains over 180 placed parts; open a smaller assembly to preview safely');
 const bodies=[...connected].sort().map(id=>{
  const cluster=memberMap.get(id)!;
  // The identity rest orientation gives each grouped body world-aligned local
  // coordinates. This preserves arbitrary source LDraw transformations exactly
  // when applying a rigid delta to all its member instances in the viewport.
  const average=cluster.reduce((p,key)=>{
   const c=centre(instances.get(key)!.worldBox);return [p[0]+c[0],p[1]+c[1],p[2]+c[2]] as V3;
  },[0,0,0] as V3);
  const p=v(average.map(n=>n/cluster.length));
  return {id,rest:{p,q:[0,0,0,1] as [number,number,number,number]},fixed:id===ground};
 });
 const byBody=new Map(bodies.map(b=>[b.id,b]));
 const selected=all.filter(e=>connected.has(owner(e.a))&&connected.has(owner(e.b)))
   .sort((a,b)=>a.id.localeCompare(b.id));
 const constraints:SpatialConstraint[]=[];
 for(const e of selected){
  const a=owner(e.a),b=owner(e.b),left=byBody.get(a)!,right=byBody.get(b)!;
  // Duplicate snaps at one physical joint are one constraint. Distinct axes /
  // anchors remain separate and may expose a genuinely locked mechanism.
  const duplicate=selected.some(other=>other!==e&&other.id<e.id&&
   owner(other.a)===a&&owner(other.b)===b&&other.motion===e.motion&&
   Math.hypot(...sub(v(other.centre),v(e.centre)))<.35&&
   Math.abs(other.axis.reduce((sum,n,i)=>sum+n*e.axis[i],0))>.995);
  if(duplicate)continue;
  const start={body:a,local:sub(v(e.centre),left.rest.p)};
  const end={body:b,local:sub(v(e.centre),right.rest.p)};
  if(e.motion==='ball')constraints.push({id:e.id,kind:'ball',a:start,b:end});
  else constraints.push({id:e.id,kind:e.motion==='sliding'?'slider':'hinge',
   a:start,b:end,axisA:v(e.axis),axisB:v(e.axis)});
 }
 if(constraints.length>42)throw Error('Over 42 simultaneous joint constraints; isolate a smaller mechanism');
 const driver=constraints.find(c=>c.id===driverEdgeId);
 if(!driver||(driver.kind!=='hinge'&&driver.kind!=='slider'))
  throw Error('Chosen joint was merged or is not a rotatable/sliding driver');
 return {model:{bodies,constraints},
  members:Object.fromEntries([...memberMap].map(([k,v])=>[k,v])),driver:driver.id,
  kind:driver.kind,source:'ldcad-shadow-review',
  warning:'This is a reviewed LDCad joint hypothesis, not verified bearings, linkage stops, forces, collision clearance or motion continuity.'};
}
