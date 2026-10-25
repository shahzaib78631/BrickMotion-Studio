/**
 * Continuous, conservative *surface* clearance for post-assembly mechanisms.
 *
 * All moving-vs-parked AND moving-vs-moving pairs are examined. Within each
 * saved playback segment, the viewport uses a linear translation plus a
 * quaternion SLERP. Each BVH node is bounded for EVERY intermediate time by
 * endpoint AABBs enlarged by R * theta^2 / 8 (linear-interpolation error of
 * a rotating point). Hence a CLEAR is based on an all-times separation proof,
 * NEVER on a collection of negative frame samples. Mesh intersection at an
 * interior time is a BLOCKED witness. Tight contacts, unsupported geometry,
 * resource budgets and existing assembled mates remain UNVERIFIED.
 *
 * This is a geometric surface proof against the rendered LDraw triangles,
 * not a manufactured-tolerance, watertight-solid or contact-force guarantee.
 */
import * as THREE from 'three';
import type { Assembly, Metrics } from '../../../model/assemble';
import type { Box } from '../../../ldraw/flatten';
import type { MechanismStage } from '../../timelineData';
import type { MechanismGraph } from './mechanismGraph';
import type { MechanismProgram, Vec3 } from './mechanismProgram';
import { mechanismPoseAt } from './mechanismPlayback';
import { MeshOracle } from '../../construction/collision';
import type { ConstructionNode, ConstructionModel, SearchStats } from '../../construction/types';

export type MechanismCollisionIssue = {
  a: string; b: string; time: number;
  status: 'blocked' | 'unverified'; reason: string;
};
export type MechanismCollisionReport = {
  status: 'clear' | 'blocked' | 'unverified';
  checkedPairs: number;
  clearPairs: number;
  blockedPairs: number;
  unverifiedPairs: number;
  testedIntervals: number;
  triangleNodeTests: number;
  staticWitnesses: number;
  issues: MechanismCollisionIssue[];
};
export type MechanismCollisionBudget = {
  /** On large CAD models, reaching any limit returns UNVERIFIED, not CLEAR. */
  maxIntervals?: number;
  maxNodeTests?: number;
  maxWitnesses?: number;
  maxDepth?: number;
};

type Tree = { box: Box; count: number; left?: Tree; right?: Tree };
type Part = { key: string; part: string; rest: THREE.Matrix4; tree: Tree | null;
  full: Box; valid: boolean; moving: boolean; deltas?: number[][];
  segments?: Box[]; trajectory?: Box; };
const EPS = 0.0005; // geometry and transform numerical slack in LDraw units
const IDENTITY = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const stats = (): SearchStats => ({states:0,candidates:0,backtracks:0,meshPairs:0,trianglePairs:0,cacheHits:0,milliseconds:0});
const emptyBox = (): Box => ({min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]});
const expand = (b:Box,m:number):Box => ({min:[b.min[0]-m,b.min[1]-m,b.min[2]-m],max:[b.max[0]+m,b.max[1]+m,b.max[2]+m]});
const merge = (a:Box,b:Box):Box => ({
  min:[Math.min(a.min[0],b.min[0]),Math.min(a.min[1],b.min[1]),Math.min(a.min[2],b.min[2])],
  max:[Math.max(a.max[0],b.max[0]),Math.max(a.max[1],b.max[1]),Math.max(a.max[2],b.max[2])],
});
const intersects = (a:Box,b:Box) => [0,1,2].every(k => a.min[k] <= b.max[k] && b.min[k] <= a.max[k]);
const usableBox = (b:Box) => !!b && b.min.length===3 && b.max.length===3 &&
  [...b.min,...b.max].every(Number.isFinite) && [0,1,2].every(k=>b.max[k]>=b.min[k]);
const boxOfTriangle = (mesh: Float32Array, start:number):Box => {
  const b=emptyBox();
  for(let j=0;j<9;j+=3)for(let k=0;k<3;k++){
    b.min[k]=Math.min(b.min[k],mesh[start+j+k]);b.max[k]=Math.max(b.max[k],mesh[start+j+k]);
  }
  return b;
};
const extent = (b:Box,k:number) => b.max[k]-b.min[k];
const bboxUnion = (boxes:readonly Box[]):Box => boxes.reduce((a,b)=>merge(a,b));

/** Spatial BVH: no triangles are discarded (including double-sided faces). */
export function meshBoxTree(mesh: Float32Array): Tree | null {
  if(!mesh || mesh.length<9 || mesh.length%9!==0 || mesh.some(v=>!Number.isFinite(v))) return null;
  const leaves:Box[]=[];
  let hasSurface=false;
  for(let i=0;i<mesh.length;i+=9){
    const ax=mesh[i+3]-mesh[i],ay=mesh[i+4]-mesh[i+1],az=mesh[i+5]-mesh[i+2];
    const bx=mesh[i+6]-mesh[i],by=mesh[i+7]-mesh[i+1],bz=mesh[i+8]-mesh[i+2];
    const cross2=(ay*bz-az*by)**2+(az*bx-ax*bz)**2+(ax*by-ay*bx)**2;
    if(cross2>1e-18)hasSurface=true;
    leaves.push(boxOfTriangle(mesh,i));
  }
  // A list of zero-area triangles is not a usable collision surface.
  if(!hasSurface)return null;
  const indices=leaves.map((_,i)=>i);
  const build=(ids:number[]):Tree=>{
    const b=bboxUnion(ids.map(i=>leaves[i]));
    if(ids.length<=8)return {box:b,count:ids.length};
    const axis=[0,1,2].sort((a,bAxis)=>extent(b,bAxis)-extent(b,a))[0];
    ids.sort((a,b)=>(leaves[a].min[axis]+leaves[a].max[axis])-(leaves[b].min[axis]+leaves[b].max[axis]));
    const middle=ids.length>>>1;
    return {box:b,count:ids.length,left:build(ids.slice(0,middle)),right:build(ids.slice(middle))};
  };
  return build(indices);
}

const transformBound = (b:Box,m:THREE.Matrix4):Box => {
  const e=m.elements,c=[0,1,2].map(k=>(b.min[k]+b.max[k])/2),h=[0,1,2].map(k=>(b.max[k]-b.min[k])/2);
  const p=[0,1,2].map(k=>e[k]*c[0]+e[k+4]*c[1]+e[k+8]*c[2]+e[k+12]);
  const d=[0,1,2].map(k=>Math.abs(e[k])*h[0]+Math.abs(e[k+4])*h[1]+Math.abs(e[k+8])*h[2]);
  return {min:[p[0]-d[0],p[1]-d[1],p[2]-d[2]],max:[p[0]+d[0],p[1]+d[1],p[2]+d[2]]};
};
const maxWorldRadius = (box:Box,rest:THREE.Matrix4) => {
  // All eight transformed corners are enclosed by this world-space AABB.
  // AABB radius is conservative even under a non-orthogonal authored basis,
  // without allocating 8 temporary Vector3 objects for every BVH query.
  const b=transformBound(box,rest);
  return Math.hypot(...[0,1,2].map(i=>Math.max(Math.abs(b.min[i]),Math.abs(b.max[i]))));
};
const rotationAngle = (a:THREE.Matrix4,b:THREE.Matrix4) => {
  const q0=new THREE.Quaternion(),q1=new THREE.Quaternion();
  a.decompose(new THREE.Vector3(),q0,new THREE.Vector3());
  b.decompose(new THREE.Vector3(),q1,new THREE.Vector3());
  const dot=Math.abs(q0.x*q1.x+q0.y*q1.y+q0.z*q1.z+q0.w*q1.w);
  return 2*Math.acos(Math.max(-1,Math.min(1,dot)));
};
/** SLERP second-derivative proof: deviation from its endpoint chord <= R theta²/8. */
export function playbackSweptBox(box:Box,rest:THREE.Matrix4,fromDelta:THREE.Matrix4,toDelta:THREE.Matrix4):Box {
  const start=fromDelta.clone().multiply(rest),end=toDelta.clone().multiply(rest);
  const angle=rotationAngle(fromDelta,toDelta);
  const margin=maxWorldRadius(box,rest)*angle*angle/8+EPS;
  return expand(merge(transformBound(box,start),transformBound(box,end)),margin);
}
const rigidDelta=(values: readonly number[])=>{
  if(values.length!==16||values.some(v=>!Number.isFinite(v)))return false;
  const r=(i:number,j:number)=>[0,1,2].reduce((s,k)=>s+values[4*i+k]*values[4*j+k],0);
  for(let i=0;i<3;i++)for(let j=i;j<3;j++)if(Math.abs(r(i,j)-(i===j?1:0))>1e-4)return false;
  const det=values[0]*(values[5]*values[10]-values[9]*values[6])-
    values[4]*(values[1]*values[10]-values[9]*values[2])+
    values[8]*(values[1]*values[6]-values[5]*values[2]);
  return Math.abs(det-1)<1e-4 && values[3]===0 && values[7]===0 && values[11]===0 && Math.abs(values[15]-1)<1e-8;
};
const pairKey=(a:string,b:string)=>a<b?`${a.length}:${a}|${b}`:`${b.length}:${b}|${a}`;

/** Incremental, budget-controlled verifier. It never upgrades an unsupported
 * shape, metadata hint, sampled non-contact, or resource exhaustion to CLEAR. */
export function verifyMechanismCollision(asm: Assembly,metrics:Metrics,stage:MechanismStage,
  graph?:MechanismGraph,program?:MechanismProgram,budget:MechanismCollisionBudget={}):MechanismCollisionReport {
  const limits={maxIntervals:budget.maxIntervals??60000,maxNodeTests:budget.maxNodeTests??600000,
    maxWitnesses:budget.maxWitnesses??900,maxDepth:budget.maxDepth??8};
  const report:MechanismCollisionReport={status:'clear',checkedPairs:0,clearPairs:0,blockedPairs:0,
    unverifiedPairs:0,testedIntervals:0,triangleNodeTests:0,staticWitnesses:0,issues:[]};
  const treeByPart=new Map<string,Tree|null>();
  const byTrack=new Map(stage.tracks.map(t=>[t.key,t]));
  const uniqueTracks=byTrack.size===stage.tracks.length;
  const instances=asm.instances;
  const stageFrames=stage.frames;
  const countValid=uniqueTracks&&Number.isSafeInteger(stageFrames)&&stageFrames>=2&&
    Number.isFinite(stage.start)&&Number.isFinite(stage.duration)&&stage.duration>0&&
    stage.tracks.every(t=>t.deltas.length===stageFrames&&t.deltas.every(rigidDelta));
  const parts:Part[]=instances.map(i=>{
    const m=metrics(i.part);
    const moving=byTrack.has(i.key);
    if(!treeByPart.has(i.part))treeByPart.set(i.part,m.placeholder||!m.mesh?null:meshBoxTree(m.mesh));
    const tree=treeByPart.get(i.part)!;
    // Geometry's own BVH bounds are the source of truth. PartMetrics.full can
    // exclude incidental render triangles or be stale after library updates;
    // accepting clearance from that smaller broad-phase box is unsound.
    const exactBox=tree?.box??m.full;
    const matrix=i.world?.elements;
    const matrixValid=!!matrix && matrix.length===16 && matrix.every(Number.isFinite) &&
      matrix[3]===0 && matrix[7]===0 && matrix[11]===0 && Math.abs(matrix[15]-1)<1e-8;
    const p:Part={key:i.key,part:i.part,rest:i.world,full:exactBox,
      tree,valid:!!tree&&usableBox(exactBox)&&!!matrixValid&&!i.placeholder&&countValid,moving,
      ...(moving?{deltas:byTrack.get(i.key)!.deltas}:{}),
    };
    if(p.valid&&moving){
      const deltas=p.deltas!;
      p.segments=[];
      for(let f=0;f<stageFrames-1;f++)
        p.segments.push(playbackSweptBox(p.full,p.rest,new THREE.Matrix4().fromArray(deltas[f]),new THREE.Matrix4().fromArray(deltas[f+1])));
      p.trajectory=bboxUnion(p.segments);
    }else if(p.valid){p.trajectory=expand(transformBound(p.full,p.rest),EPS);}
    return p;
  });
  const allByKey=new Map(parts.map(p=>[p.key,p]));
  const expected=new Set<string>();
  for(const j of program?.gears??[]){
    const a=program?.joints.find(x=>x.id===j.a)?.body,b=program?.joints.find(x=>x.id===j.b)?.body;
    if(a&&b)expected.add(pairKey(a,b));
  }
  for(const f of program?.rigidFollowers??[])for(const body of f.bodies)expected.add(pairKey(f.leader,body));
  const pose=(p:Part,index:number,u:number)=>{
    if(!p.moving)return p.rest;
    // Match the exact viewport/export quaternion SLERP, not an FK re-solve.
    const t=stage.start+stage.duration*(index+u)/(stageFrames-1);
    const out=mechanismPoseAt(stage,t,p.key,p.rest);
    if(!out)throw Error('Unreplayable mechanism segment');
    return out;
  };
  const delta=(p:Part,index:number,u:number)=>p.moving
    ?pose(p,index,u).clone().multiply(p.rest.clone().invert())
    :new THREE.Matrix4();
  const bound=(p:Part,node:Tree,index:number,lo:number,hi:number)=>p.moving
    ?playbackSweptBox(node.box,p.rest,delta(p,index,lo),delta(p,index,hi))
    :expand(transformBound(node.box,p.rest),EPS);
  const oracleCache=new Map<string,MeshOracle>();
  const getOracle=(a:Part,b:Part):MeshOracle=>{
    const key=pairKey(a.key,b.key);
    let oracle=oracleCache.get(key);
    if(oracle)return oracle;
    const nodes=[a,b].map((p):ConstructionNode=>({id:p.key,part:p.part,model:'',step:0,order:0,
      matrix:IDENTITY.slice() as ConstructionNode['matrix'],bounds:metrics(p.part).full,
      body:metrics(p.part).body,leaves:[p.key]}));
    const model:ConstructionModel={nodes,parts:new Map(nodes.map(n=>[n.id,n])),
      bounds:merge(nodes[0].bounds,nodes[1].bounds),metrics};
    oracle=new MeshOracle(model,stats());
    if(oracleCache.size>=12)oracleCache.delete(oracleCache.keys().next().value!);
    oracleCache.set(key,oracle);
    return oracle;
  };
  // No negative point sample is ever used to prove clearance. The oracle is
  // invoked solely for a positive collision witness or existing mate warning.
  const witness=(a:Part,b:Part,i:number,u:number):boolean|null=>{
    if(report.staticWitnesses>=limits.maxWitnesses)return null;
    report.staticWitnesses++;
    try{
      const pa=pose(a,i,u),pb=pose(b,i,u);
      return !getOracle(a,b).clearPosed(a.key,b.key,pa.elements,pb.elements,[0,0,0]);
    }catch{return null;}
  };
  // Find possible surface overlap within the *entire* interval using two
  // hierarchical bounding-box trees. A negative result is a rigorous proof.
  const possible=(a:Part,b:Part,i:number,lo:number,hi:number):boolean|null=>{
    if(!a.tree||!b.tree)return null;
    const walk=(x:Tree,y:Tree):boolean|null=>{
      if(++report.triangleNodeTests>limits.maxNodeTests)return null;
      if(!intersects(bound(a,x,i,lo,hi),bound(b,y,i,lo,hi)))return false;
      if(!x.left&&!y.left)return true;
      // Descend a single BVH at a time to avoid a quadratic Cartesian expansion.
      if(x.left && (!y.left||x.count>=y.count)){
        const left=walk(x.left,y);
        if(left===true)return true;
        const right=walk(x.right!,y);
        return right===true?true:left===null||right===null?null:false;
      }
      if(y.left){
        const left=walk(x,y.left);
        if(left===true)return true;
        const right=walk(x,y.right!);
        return right===true?true:left===null||right===null?null:false;
      }
      return true;
    };
    return walk(a.tree,b.tree);
  };
  const setPair=(a:Part,b:Part,status:'clear'|'blocked'|'unverified',at:number,reason:string)=>{
    report.checkedPairs++;
    if(status==='clear'){report.clearPairs++;return;}
    if(status==='blocked'){report.blockedPairs++;report.status='blocked';}
    else{report.unverifiedPairs++;if(report.status==='clear')report.status='unverified';}
    if(report.issues.length<40)report.issues.push({a:a.key,b:b.key,time:at,status,reason});
  };
  const moving=parts.filter(p=>p.moving);
  // A one-body mechanism has no obstacle pairs; it is still NOT certified
  // unless its animated geometry and every delta have been validated.
  for(const part of moving)if(!part.valid){
    report.status='unverified';report.unverifiedPairs++;
    if(report.issues.length<40)report.issues.push({a:part.key,b:'(geometry)',
      time:stage.start,status:'unverified',reason:'Animated body has missing mesh or invalid rigid playback data'});
  }
  if(!moving.length){
    report.status='unverified';report.unverifiedPairs++;
    if(report.issues.length<40)report.issues.push({a:'(mechanism)',b:'(tracks)',
      time:stage.start,status:'unverified',reason:'No moving instances have valid playback tracks'});
  }
  // A mechanism does not certify stationary-vs-stationary assembly joints.
  for(const a of moving)for(const b of parts){
    if(a===b||(b.moving && a.key>b.key))continue;
    if(!a.valid||!b.valid){setPair(a,b,'unverified',stage.start,'Missing/invalid mesh, rigid delta or playback data');continue;}
    if(!intersects(a.trajectory!,b.trajectory!)){
      setPair(a,b,'clear',stage.start,'Disjoint entire-motion envelopes');continue;
    }
    const mate=(graph?.isMate(a.key,b.key)??false)||expected.has(pairKey(a.key,b.key));
    // If an assembled pair already interpenetrates (e.g. stylized LDraw snap
    // geometry), a collision witness at t=0 cannot be called a NEW collision.
    const existing=witness(a,b,0,0);
    if(existing===null){setPair(a,b,'unverified',stage.start,'Exact assembled contact could not be checked');continue;}
    if(existing){setPair(a,b,'unverified',stage.start,'Assembled surfaces already overlap; contact requires reviewed geometry');continue;}
    let result:'clear'|'blocked'|'unverified'='clear';
    let first=stage.start,reason='Continuous BVH bounds separate all moving triangles';
    const recurse=(i:number,lo:number,hi:number,depth:number):'clear'|'blocked'|'unverified'=>{
      if(++report.testedIntervals>limits.maxIntervals)return 'unverified';
      const hint=possible(a,b,i,lo,hi);
      if(hint===false)return 'clear';
      if(hint===null)return 'unverified';
      const mid=(lo+hi)/2;
      const collision=witness(a,b,i,mid);
      if(collision===true){
        first=stage.start+stage.duration*(i+mid)/(stageFrames-1);
        reason=mate?'Expected mechanical contact cannot be certified as a collision-free sweep':
          'Triangle-mesh collision witnessed during mechanism playback';
        return mate?'unverified':'blocked';
      }
      if(depth>=limits.maxDepth)return 'unverified';
      const left=recurse(i,lo,mid,depth+1);
      if(left==='blocked')return 'blocked';
      const right=recurse(i,mid,hi,depth+1);
      if(right==='blocked')return 'blocked';
      return left==='unverified'||right==='unverified'?'unverified':'clear';
    };
    for(let i=0;i<stageFrames-1;i++){
      if(!intersects(a.segments![i],b.moving?b.segments![i]:b.trajectory!))continue;
      const verdict=recurse(i,0,1,0);
      if(verdict==='blocked'){result='blocked';break;}
      if(verdict==='unverified')result='unverified';
    }
    if(result==='unverified'&&reason==='Continuous BVH bounds separate all moving triangles')
      reason='Tight swept triangles, expected contact, or verification budget prevented a clearance proof';
    setPair(a,b,result,first,reason);
  }
  // If the mechanism data contains unknown/missing instances, no per-instance
  // check was possible and the stage cannot be described as certified clear.
  for(const track of stage.tracks)if(!allByKey.has(track.key)){
    report.status=report.status==='blocked'?'blocked':'unverified';report.unverifiedPairs++;
    if(report.issues.length<40)report.issues.push({a:track.key,b:'(missing part)',
      time:stage.start,status:'unverified',reason:'Animated instance missing from assembled model'});
  }
  return report;
}
