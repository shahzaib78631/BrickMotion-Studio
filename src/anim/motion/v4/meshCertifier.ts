/**
 * Standard Motion v4 / phase 2: three-state, time-aware collision verification.
 *
 * A path is CLEAR only if every simultaneously occupied pair has a proof:
 * (a) disjoint conservative *continuous* swept envelopes, or (b) exact SAT
 * continuous mesh-translation / conservative triangle-arc checks from the
 * existing Construction MeshOracle. Neither sparse samples nor a contact hint
 * can produce a CLEAR certificate. Missing meshes, unsupported interpolation,
 * budget limits, uncertain final mates and dynamic proximity are UNVERIFIED.
 * An actual mesh contact during transport is BLOCKED.
 */
import * as THREE from 'three';
import type { Box } from '../../../ldraw/flatten';
import { SpatialHash } from '../../../model/spatialHash';
import { transformBox, unionBox, type Assembly, type Metrics } from '../../../model/assemble';
import { MeshOracle } from '../../construction/collision';
import type { ConstructionModel, ConstructionNode, SearchStats } from '../../construction/types';
import type { V3 } from '../../construction/math';
import { flightPose, poseAt, type Move, type Timeline } from '../../timeline';
import { interpolateJointSegment } from '../jointKinematics';
import type { MechanismGraph } from './mechanismGraph';

export type Verdict = 'clear' | 'blocked' | 'unverified';
export type Certificate = {
  status: Verdict;
  blockers: string[];
  /** First possible conflict, normalized to the checked flight. */
  firstHit?: number;
  reason?: string;
  /** Only geometry-complete, fully verified paths may report clear. */
  verifiedPairs: number;
  meshSweeps: number;
  examinedPairs: number;
};
type Piece = {
  key: string; part: string; track: NonNullable<ReturnType<Timeline['tracks']['get']>>;
  bounds: Box; hasMesh: boolean;
};
type Dynamic = { move: Move; u0: number; u1: number; segment: number | null; local0: number; local1: number };
type State = { bounds: Box | null; stationary?: THREE.Matrix4; dynamic?: Dynamic; supported: boolean };
const EPS = 1e-7;
const PAD = 0.002; // covers transformBox 0.001-LDU rounding and numeric slack
const IDENTITY: number[] = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const emptyStats = (): SearchStats => ({ states:0, candidates:0, backtracks:0, meshPairs:0, trianglePairs:0,
  cacheHits:0, milliseconds:0 });
const overlap = (a: Box, b: Box) => [0,1,2].every(k=>a.min[k] <= b.max[k] + PAD && b.min[k] <= a.max[k] + PAD);
const roundBox = (a: Box, margin: number): Box => ({
  min: [a.min[0]-margin,a.min[1]-margin,a.min[2]-margin],
  max: [a.max[0]+margin,a.max[1]+margin,a.max[2]+margin],
});
const validPose = (m: THREE.Matrix4): boolean => !!m && m.elements.length===16 && m.elements.every(Number.isFinite);
const validBounds = (b: Box): boolean => !!b && b.min.length===3 && b.max.length===3 &&
  [...b.min,...b.max].every(Number.isFinite) && [0,1,2].every(k=>b.min[k]<=b.max[k]);
/** A world rigid rotation preserves column dot products and handedness.
 * Reject discontinuous deformation that would invalidate a sphere envelope. */
const sameShape = (a:THREE.Matrix4,b:THREE.Matrix4):boolean => {
  const x=a.elements,y=b.elements;
  if(!validPose(a)||!validPose(b))return false;
  const gram=(m:readonly number[],i:number,j:number)=>[0,1,2].reduce((s,k)=>s+m[4*i+k]*m[4*j+k],0);
  const scale=Math.max(1,...[0,1,2].map(i=>gram(x,i,i)),...[0,1,2].map(i=>gram(y,i,i)));
  for(let i=0;i<3;i++)for(let j=i;j<3;j++)if(Math.abs(gram(x,i,j)-gram(y,i,j))>scale*1e-7)return false;
  const det=(m:readonly number[])=>m[0]*(m[5]*m[10]-m[9]*m[6])-m[4]*(m[1]*m[10]-m[9]*m[2])+m[8]*(m[1]*m[6]-m[5]*m[2]);
  return det(x)*det(y)>0 && Math.abs(det(x))>1e-10;
};
const sameLinear = (a: THREE.Matrix4,b: THREE.Matrix4) =>
  [0,1,2,4,5,6,8,9,10].every(k=>Math.abs(a.elements[k]-b.elements[k]) < 1e-7);
const xyz = (m: THREE.Matrix4): V3 => [m.elements[12],m.elements[13],m.elements[14]];
const deltaOf = (a: THREE.Matrix4,b: THREE.Matrix4): V3 =>
  [b.elements[12]-a.elements[12],b.elements[13]-a.elements[13],b.elements[14]-a.elements[14]];
const cubic = (v: number): number => v < 0.5 ? 4*v*v*v : 1 - Math.pow(-2*v+2,3)/2;
const clamp = (v:number) => Math.max(0,Math.min(1,v));
const phase = (move: Move, u: number, n:number): number =>
  cubic(clamp((u - move.hold) / (1 - move.hold))) * (n-1);
const corners = (box: Box): V3[] => {
  const out: V3[] = [];
  for (const x of [box.min[0],box.max[0]]) for (const y of [box.min[1],box.max[1]])
    for (const z of [box.min[2],box.max[2]]) out.push([x,y,z]);
  return out;
};
const transformedRadius = (b: Box, pose: THREE.Matrix4): number => {
  const origin = new THREE.Vector3(...xyz(pose));
  let largest = 0;
  for (const p of corners(b)) largest = Math.max(largest,
    new THREE.Vector3(...p).applyMatrix4(pose).distanceTo(origin));
  return largest;
};

/** Exact swept AABB of an affine rigid body's *box* on a circular arc.
 * Coordinate extrema of every corner occur at the endpoints and where the
 * derivative of A*cos(theta)+B*sin(theta) vanishes. Includes long arcs and
 * signed angles; unlike point sampling this cannot miss an intermediate bow.
 */
export function revoluteEnvelope(box: Box, from: THREE.Matrix4, pivot: V3, axis: V3, travel: number): Box {
  if (![...pivot,...axis,travel].every(Number.isFinite) || Math.hypot(...axis)<1e-8 ||
      !validPose(from) || Math.abs(travel)>Math.PI*2+EPS) throw new Error('Invalid hinge sweep');
  const u = new THREE.Vector3(...axis).normalize(), p = new THREE.Vector3(...pivot);
  const lo = Math.min(0,travel), hi = Math.max(0,travel);
  const min: V3 = [Infinity,Infinity,Infinity], max: V3 = [-Infinity,-Infinity,-Infinity];
  for (const corner of corners(box)) {
    const x = new THREE.Vector3(...corner).applyMatrix4(from).sub(p);
    const h = u.clone().multiplyScalar(u.dot(x));
    const a = x.clone().sub(h), b = u.clone().cross(a);
    const base = p.clone().add(h);
    for (let k=0;k<3;k++) {
      const A = a.getComponent(k), B = b.getComponent(k), C = base.getComponent(k);
      const angles = [lo,hi];
      const root = Math.atan2(B,A);
      const start = Math.ceil((lo-root)/Math.PI), end = Math.floor((hi-root)/Math.PI);
      for (let n=start;n<=end;n++) angles.push(root+n*Math.PI);
      for (const theta of angles) {
        const value = C + A*Math.cos(theta) + B*Math.sin(theta);
        min[k] = Math.min(min[k],value); max[k] = Math.max(max[k],value);
      }
    }
  }
  return roundBox({min,max},PAD);
}

const segmentPose = (m: Move, i: number, t:number): THREE.Matrix4 => {
  const poses=m.posePath!;
  const k=m.kinematicSegments?.find(s=>s.index===i);
  if (k) {
    const out=new THREE.Matrix4();
    if (!interpolateJointSegment(poses[i],k,t,out)) throw new Error('Malformed joint segment');
    return m.rel ? out.multiply(m.rel) : out;
  }
  // For the conservative bound only endpoints are needed for linear motion;
  // this interpolation is used to produce the same translation as playback.
  const a=poses[i],b=poses[i+1];
  if (!sameLinear(a,b)) throw new Error('Slerp requires a general orientation envelope');
  const out=a.clone();
  for (let k=12;k<=14;k++) out.elements[k] += (b.elements[k]-a.elements[k])*t;
  return m.rel ? out.multiply(m.rel) : out;
};

/** Sound continuous bound on a SINGLE posePath segment, possibly partially used. */
function edgeEnvelope(m: Move, body: Box, index: number, lo:number, hi:number): Box {
  const segment=m.kinematicSegments?.find(s=>s.index===index);
  const a=m.posePath![index],b=m.posePath![index+1];
  if(!sameShape(a,b))throw new Error('Part shape or handedness changes in flight');
  if(segment){
    const expected=segmentPose(m,index,1);
    if(!expected.elements.every((v:number,j:number)=>Math.abs(v-b.elements[j])<1e-4))
      throw new Error('Kinematic endpoint does not agree with playback');
  }
  if (segment?.kind==='revolute' && segment.pivot) {
    const start=segmentPose(m,index,lo);
    return revoluteEnvelope(body,start,segment.pivot,segment.axis,segment.travel*(hi-lo));
  }
  if (segment?.kind==='prismatic' || sameLinear(a,b)) {
    const p0=segmentPose(m,index,lo),p1=segmentPose(m,index,hi);
    return roundBox(unionBox(transformBox(body,p0),transformBox(body,p1)),PAD);
  }
  // A generic preview's orientation is SLERP, not an affine blend of the
  // endpoint AABBs. Bound any orientation by the maximum distance of a part
  // vertex from the interpolated origin. Position is a straight interpolation.
  // endpointPair guarantees the same part shape at both ends.
  const radius = Math.max(transformedRadius(body,a),transformedRadius(body,b));
  const aa=xyz(a),bb=xyz(b);
  return roundBox({
    min: [Math.min(aa[0]+(bb[0]-aa[0])*lo,aa[0]+(bb[0]-aa[0])*hi)-radius,
      Math.min(aa[1]+(bb[1]-aa[1])*lo,aa[1]+(bb[1]-aa[1])*hi)-radius,
      Math.min(aa[2]+(bb[2]-aa[2])*lo,aa[2]+(bb[2]-aa[2])*hi)-radius],
    max: [Math.max(aa[0]+(bb[0]-aa[0])*lo,aa[0]+(bb[0]-aa[0])*hi)+radius,
      Math.max(aa[1]+(bb[1]-aa[1])*lo,aa[1]+(bb[1]-aa[1])*hi)+radius,
      Math.max(aa[2]+(bb[2]-aa[2])*lo,aa[2]+(bb[2]-aa[2])*hi)+radius],
  },PAD);
}

/** Full or partial time-window bound. A null bound forces UNVERIFIED, never clear. */
function moveEnvelope(move: Move, body: Box, u0:number,u1:number): Box | null {
  if (!Number.isFinite(move.hold) || move.hold < 0 || move.hold >= 1 ||
      !validPose(move.from) || !validPose(move.to) || !validBounds(body)) return null;
  if (move.stationary) return transformBox(body,move.rel ? move.from.clone().multiply(move.rel) : move.from);
  if (move.rigidDeltas?.length) return null; // Unsupported shared-rigid interpolation => unverified.
  // All segment bounds below are in the *leaf's* local coordinates. A rel
  // transform changes the body frame, so do not silently certify it.
  if (move.rel) return null;
  if (move.posePath?.length && !move.translationPath) {
    if (move.posePath.length < 2 || move.posePath.some(p=>!validPose(p))) return null;
    const n=move.posePath.length, a=phase(move,u0,n), b=phase(move,u1,n);
    const min=Math.min(a,b),max=Math.max(a,b);
    let box: Box | null=null;
    for (let i=Math.floor(min);i<=Math.min(n-2,Math.floor(max));i++) {
      const lo=clamp(min-i),hi=clamp(max-i);
      if (hi+EPS<lo) continue;
      try { box=unionBox(box,edgeEnvelope(move,body,i,lo,hi)); } catch { return null; }
    }
    // Entire interval may lie within the before-lift hold (phase=0).
    return box ?? transformBox(body,move.rel ? move.from.clone().multiply(move.rel) : move.from);
  }
  // Translation path and legacy three-stage routing: the whole trajectory
  // remains inside these broad hulls, regardless of easing or subinterval.
  // They can prove clearance even if their narrow phase is unsupported.
  const from=move.rel?move.from.clone().multiply(move.rel):move.from;
  if (move.translationPath?.length && !move.rel) {
    if(!sameLinear(from,move.to) || !validPose(from) || !validPose(move.to))return null;
    let full: Box|null=unionBox(transformBox(body,from),transformBox(body,move.to));
    for (const offset of move.translationPath) {
      if (offset.length!==3 || offset.some(v=>!Number.isFinite(v))) return null;
      const at=from.clone(); at.elements[12]+=offset[0];at.elements[13]+=offset[1];at.elements[14]+=offset[2];
      full=unionBox(full,transformBox(body,at));
    }
    return full;
  }
  const end=move.to;
  const r=Math.max(transformedRadius(body,from),transformedRadius(body,end));
  const a=xyz(from),b=xyz(end),e=move.entry ?? [0,0,0];
  if (![...a,...b,move.skyY,...e].every(Number.isFinite)) return null;
  return { min:[Math.min(a[0],b[0],b[0]+e[0])-r,Math.min(a[1],b[1],move.skyY,b[1]+e[1])-r,
    Math.min(a[2],b[2],b[2]+e[2])-r],
    max:[Math.max(a[0],b[0],b[0]+e[0])+r,Math.max(a[1],b[1],move.skyY,b[1]+e[1])+r,
      Math.max(a[2],b[2],b[2]+e[2])+r] };
}

/** Pairwise oracle with *local*, identity-transform meshes and world-space poses. */
class PairOracle {
  private oracle: MeshOracle;
  constructor(a: Piece,b: Piece,metrics: Metrics) {
    const nodes = [a,b].map((p): ConstructionNode=>({id:p.key,part:p.part,model:'',step:0,order:0,
      matrix: IDENTITY.slice() as ConstructionNode['matrix'], bounds:metrics(p.part).full,
      body:metrics(p.part).body,leaves:[p.key]}));
    const parts=new Map(nodes.map(n=>[n.id,n]));
    const model: ConstructionModel={nodes,parts,bounds: unionBox(nodes[0].bounds,nodes[1].bounds),metrics};
    this.oracle=new MeshOracle(model,emptyStats());
  }
  checkTranslation(a:Piece,b:Piece,from:THREE.Matrix4,fixed:THREE.Matrix4,delta:V3):boolean {
    return this.oracle.clearPosed(a.key,b.key,from.elements,fixed.elements,delta);
  }
  checkArc(a:Piece,b:Piece,from:THREE.Matrix4,fixed:THREE.Matrix4,pivot:V3,axis:V3,angle:number):boolean {
    // The Construction oracle stores triangles transformed by the *linear*
    // pose matrix and applies body translation afterwards. Its arc pivot is
    // therefore local to that intermediate frame, not a world pivot.
    const localPivot: V3=[pivot[0]-from.elements[12],pivot[1]-from.elements[13],pivot[2]-from.elements[14]];
    return this.oracle.arcClear(a.key,b.key,from.elements,fixed.elements,localPivot,axis,angle,12);
  }
}

const poseFor=(tl:Timeline,key:string,t:number)=>poseAt(tl,t)(key);
/** Every distinct occupancy or routing phase MUST be split; never apply a
 * stationary triangle certificate while the other body is still in motion. */
function splitTimes(tl:Timeline,key:string,lo:number,hi:number):number[] {
  const track=tl.tracks.get(key);
  if (!track) return [];
  const result:number[]=[];
  for(const m of track.moves){
    const u=tl.units[m.unit];if(!u||u.dur<=0)continue;
    const start=u.start,end=start+u.dur;
    for (const t of [start,end,start+m.hold*u.dur]) if(t>lo+EPS&&t<hi-EPS)result.push(t);
    if(m.posePath?.length && !m.translationPath) {
      const count=m.posePath.length-1;
      for(let i=1;i<count;i++) {
        // Invert the monotone cubic to locate exact playback segment changes.
        const x=i/count;
        const f=x<.5 ? Math.cbrt(x/4) : 1-Math.cbrt((1-x)/4);
        const time=start+(m.hold+(1-m.hold)*f)*u.dur;
        if(time>lo+EPS&&time<hi-EPS)result.push(time);
      }
    }
  }
  return result;
}

export type VerificationBudget = {
  maxExactPairs?: number; maxDepth?: number; maxIntervals?: number;
  /** Limits the amount of geometric proof attempted on crowded flights. */
  maxCandidatePairs?: number;
  /** A verifier budget is NOT permission to certify an unvisited pair. */
  maxMilliseconds?: number;
};
export class TimedMeshCertifier {
  private pieces: Piece[];
  private missingTracks: string[]=[];
  private byKey=new Map<string,Piece>();
  private oracles=new Map<string,PairOracle>();
  /** All-time conservative occupancy: safe for querying at any flight time.
   * Unlike a frame sample this cannot miss a piece flying between keyframes. */
  private globalIndex=new SpatialHash(192);
  private globallyUnknown:number[]=[];
  private exactPairsInFlight=0;
  constructor(private asm:Assembly, private tl:Timeline, private metrics:Metrics,
    private graph:MechanismGraph, private budget:VerificationBudget={}) {
    this.pieces=asm.instances.flatMap(inst=>{
      const track=tl.tracks.get(inst.key);
      if(!track){this.missingTracks.push(inst.key);return [];}
      const pm=metrics(inst.part);
      return [{key:inst.key,part:inst.part,track,bounds:pm.full,
        hasMesh:!pm.placeholder&&validBounds(pm.full)&&!!pm.mesh?.length}];
    });
    this.pieces.forEach((p,i)=>{
      this.byKey.set(p.key,p);
      const tr=p.track;
      let swept:Box|null=unionBox(transformBox(p.bounds,tr.final),transformBox(p.bounds,tr.floor));
      let supported=validBounds(swept) && (tr.ctx??0)===0 && p.hasMesh;
      for(const move of tr.moves){
        const b=moveEnvelope(move,p.bounds,0,1);
        if(!b){supported=false;break;}
        swept=unionBox(swept,b);
      }
      if(supported&&swept&&validBounds(swept))this.globalIndex.insert(i,swept);
      else this.globallyUnknown.push(i); // Never spatially cull unsupported movement.
    });
  }
  /** Extend, never shrink, the broad phase after a route edit. Stale entries
   * can produce extra work, but cannot hide a collision. */
  noteUpdatedMove(key:string,move:Move):void {
    const i=this.pieces.findIndex(p=>p.key===key);
    if(i<0)return;
    const b=moveEnvelope(move,this.pieces[i].bounds,0,1);
    if(b&&validBounds(b))this.globalIndex.insert(i,b);
    else if(!this.globallyUnknown.includes(i))this.globallyUnknown.push(i);
  }
  private state(key:string,lo:number,hi:number,alternative?:Move): State {
    const p=this.byKey.get(key);
    if(!p)return {bounds:null,supported:false};
    const tr=p.track;
    if (!validPose(tr.floor)||!validPose(tr.final)||Number.isNaN(tr.appear))
      return {bounds:null,supported:false};
    if (hi < tr.appear-EPS) return {bounds:null,supported:true};
    const pieces: Box[]=[];
    let stationary:THREE.Matrix4|undefined, dyn:Dynamic|undefined;
    const origin=tr.moves[0];
    const first=origin?this.tl.units[origin.unit]:undefined;
    const last=tr.moves.at(-1);const lastUnit=last?this.tl.units[last.unit]:undefined;
    if(!origin)return {bounds:transformBox(p.bounds,tr.final),stationary:tr.final,supported:true};
    if(!first||!lastUnit||!Number.isFinite(first.start)||!Number.isFinite(lastUnit.start)||
      !(first.dur>0)||!(lastUnit.dur>0))return {bounds:null,supported:false};
    if(lo>=lastUnit.start+lastUnit.dur-EPS)
      return {bounds:transformBox(p.bounds,tr.final),stationary:tr.final,supported:true};
    if(hi<=first.start+EPS) return {bounds:transformBox(p.bounds,tr.floor),stationary:tr.floor,supported:true};
    if (lo < first.start && hi > tr.appear)pieces.push(transformBox(p.bounds,tr.floor));
    if (hi > lastUnit.start+lastUnit.dur)pieces.push(transformBox(p.bounds,tr.final));
    // Completed earlier attach phases can remain motionless before a later
    // attach starts; these idle periods are occupied, never empty space.
    for(let i=1;i<tr.moves.length;i++){
      const prev=tr.moves[i-1],next=tr.moves[i];
      const prevUnit=this.tl.units[prev.unit],nextUnit=this.tl.units[next.unit];
      if(!prevUnit||!nextUnit)continue;
      const restBegin=prevUnit.start+prevUnit.dur,restEnd=nextUnit.start;
      if(hi>restBegin&&lo<restEnd)pieces.push(transformBox(p.bounds,
        prev.rel?prev.to.clone().multiply(prev.rel):prev.to));
    }
    for(const m of tr.moves){
      const u=this.tl.units[m.unit];if(!u||u.hidden)continue;
      const begin=Math.max(lo,u.start),end=Math.min(hi,u.start+u.dur);
      if(end<begin-EPS)continue;
      const active=(m===origin&&alternative)?alternative:m;
      const u0=clamp((begin-u.start)/Math.max(EPS,u.dur));
      const u1=clamp((end-u.start)/Math.max(EPS,u.dur));
      const bound=moveEnvelope(active,p.bounds,u0,u1);
      if(!bound)return {bounds:null,supported:false};
      pieces.push(bound);
      if (lo>=u.start-EPS&&hi<=u.start+u.dur+EPS) {
        const progress0=active.posePath?.length?phase(active,u0,active.posePath.length):0;
        const progress1=active.posePath?.length?phase(active,u1,active.posePath.length):0;
        const seg=Math.min(active.posePath?.length ? active.posePath.length-2 : 0,Math.floor(progress0+EPS));
        const same=!!active.posePath?.length && Math.floor(progress1-EPS)<=seg;
        dyn={move:active,u0,u1,segment:same?seg:null,
          local0:clamp(progress0-seg),local1:clamp(progress1-seg)};
      }
    }
    // Idle intervals between explicit moves retain the previous move's final pose.
    // If we cannot cover an entire window, do NOT certify it from an empty box.
    if(!pieces.length)return {bounds:null,supported:false};
    return {bounds:pieces.reduce((a,b)=>unionBox(a,b)),dynamic:pieces.length===1?dyn:undefined,supported:true};
  }
  private oracle(a:Piece,b:Piece):PairOracle|undefined {
    const key=[a.key,b.key].sort().join('\u0000');
    const found=this.oracles.get(key);
    if(found){this.oracles.delete(key);this.oracles.set(key,found);return found;}
    if(this.exactPairsInFlight>=(this.budget.maxExactPairs??160))return undefined;
    try {
      const fresh=new PairOracle(a,b,this.metrics);
      this.oracles.set(key,fresh);this.exactPairsInFlight++;
      // Never let expensive mesh solids for hundreds of huge pieces live forever.
      if(this.oracles.size>24)this.oracles.delete(this.oracles.keys().next().value!);
      return fresh;
    } catch { return undefined; }
  }
  /** Certify the ACTUAL playback flight against every simultaneously occupied
   * part, including staged pieces, subassemblies and concurrent flights.
   * `alternative` enables safe candidate evaluation without mutating playback.
   */
  verify(key:string,move:Move,alternative?:Move):Certificate {
    this.exactPairsInFlight=0; // budget is per flight, never exhausted forever on large MPDs
    const moving=this.byKey.get(key),unit=this.tl.units[move.unit];
    const report:Certificate={status:'clear',blockers:[],verifiedPairs:0,meshSweeps:0,examinedPairs:0};
    if(this.missingTracks.length)return {...report,status:'unverified',
      blockers:this.missingTracks.slice(0,8),reason:'Assembly instances have no timeline track'};
    if(!moving||!unit||!moving.hasMesh)return {...report,status:'unverified',reason:'Missing moving-part collision mesh'};
    if(moving.track.ctx!==0 && unit.kind==='piece')return {...report,status:'unverified',reason:'Nested-workbench transform is not in world space'};
    const flight=alternative??move;
    const start=unit.start,end=start+unit.dur;
    if(end<=start)return {...report,status:'unverified',reason:'Invalid flight duration'};
    const full=this.state(key,start,end,flight);
    if(!full.bounds)return {...report,status:'unverified',reason:'Unsupported motion geometry'};
    const maxCandidatePairs=this.budget.maxCandidatePairs??Infinity;
    const now=()=>typeof performance==='undefined'?Date.now():performance.now();
    const deadline=this.budget.maxMilliseconds==null?Infinity:now()+this.budget.maxMilliseconds;
    const budgetExceeded=()=>now()>deadline;
    const outOfBudget=(reason:string):Certificate=>({ ...report,
      status:report.status==='blocked'?'blocked':'unverified',
      reason:report.status==='blocked'?report.reason:reason,
      blockers:report.blockers.length?report.blockers:['(verification budget)'],
    });
    const maxDepth=this.budget.maxDepth??8,maxIntervals=this.budget.maxIntervals??160;
    const intervalWork={n:0};
    const record=(status:Verdict,other:string,t:number,reason:string) => {
      if(status==='blocked'||report.status==='clear'||status==='unverified'&&report.status!=='blocked'){
        if(status==='blocked'||report.status==='clear')report.status=status;
        if(report.blockers.length<8&&!report.blockers.includes(other))report.blockers.push(other);
        if(report.firstHit===undefined||t<report.firstHit)report.firstHit=t;
        if(status==='blocked' || report.reason===undefined)report.reason=reason;
      }
    };
    // Spatially prune only by envelopes that cover each part's ENTIRE
    // staging, flight and installed lifetime. Unbounded motions are always
    // examined; a current-time AABB or keyframe sample would be unsound.
    const candidates=new Set(this.globalIndex.query(full.bounds));
    for(const i of this.globallyUnknown)candidates.add(i);
    for(const i of candidates){
      const other=this.pieces[i];
      if(!other||other.key===key)continue;
      if(budgetExceeded())return outOfBudget('Time budget reached before all candidate bodies could be certified');
      if(report.examinedPairs>=maxCandidatePairs)return outOfBudget('Pair budget reached before all candidate bodies could be certified');
      // The pieces of one rigid attach unit preserve their authored relative
      // transform. The joint is not waived: absence of a pairwise independent
      // motion proof means the *whole unit* remains unverified instead.
      if(other.track.moves.some(m=>m.unit===move.unit)) {
        record('unverified',other.key,0,'Shared subassembly motion requires a rigid-cluster certificate');
        continue;
      }
      const initial=this.state(other.key,start,end);
      // Placeholder bounds are NOT a proof of a missing part's physical
      // extent. Even if those boxes are far away, the path is unverified.
      if(!other.hasMesh){record('unverified',other.key,0,'Missing obstacle collision mesh');continue;}
      if(initial.supported&&initial.bounds&&!overlap(full.bounds,initial.bounds))continue;
      if(!initial.bounds&&initial.supported)continue;
      report.examinedPairs++;
      const splits=[start,end,...splitTimes(this.tl,key,start,end),...splitTimes(this.tl,other.key,start,end)]
        .sort((a,b)=>a-b).filter((t,i,arr)=>i===0||t-arr[i-1]>EPS);
      const mate=this.graph.isMate(key,other.key);
      const check=(lo:number,hi:number,depth:number):Verdict=>{
        if(budgetExceeded()||++intervalWork.n>maxIntervals)return 'unverified';
        const a=this.state(key,lo,hi,flight),b=this.state(other.key,lo,hi);
        if(!a.bounds||!b.bounds)return a.supported&&b.supported?'clear':'unverified';
        if(!overlap(a.bounds,b.bounds))return 'clear';
        const one=this.oracle(moving,other);
        if(!one)return 'unverified';
        // Use exact continuous mesh sweeps only inside ONE joint/pose segment
        // while the obstacle really is stationary throughout the interval.
        if(a.dynamic?.segment!==null && a.dynamic?.segment!==undefined && b.stationary){
          const info=a.dynamic,seg=info.move.kinematicSegments?.find(s=>s.index===info.segment);
          const first=flightPose(info.move,info.u0,new THREE.Matrix4());
          const last=flightPose(info.move,info.u1,new THREE.Matrix4());
          if(seg?.kind==='revolute'&&seg.pivot){
            report.meshSweeps++;
            if(one.checkArc(moving,other,first,b.stationary,seg.pivot,seg.axis,
              seg.travel*(info.local1-info.local0)))return 'clear';
          } else if(sameLinear(first,last)){
            report.meshSweeps++;
            if(one.checkTranslation(moving,other,first,b.stationary,deltaOf(first,last)))return 'clear';
          }
        } else if(a.stationary&&b.stationary){
          report.meshSweeps++;
          if(one.checkTranslation(moving,other,a.stationary,b.stationary,[0,0,0]))return 'clear';
        }
        if(depth>=maxDepth||hi-lo<unit.dur/4096){
          // Midpoint narrow phase is a WITNESS to a collision, not evidence of
          // clearance. A negative sample remains UNVERIFIED, never CLEAR.
          const mid=(lo+hi)/2;
          const pa=alternative?flightPose(flight,clamp((mid-start)/unit.dur),new THREE.Matrix4()):poseFor(this.tl,key,mid);
          const pb=poseFor(this.tl,other.key,mid);
          if(pa&&pb){
            report.meshSweeps++;
            const intersects=!one.checkTranslation(moving,other,pa,pb,[0,0,0]);
            if(intersects)return mate && mid > start + unit.dur*0.965?'unverified':'blocked';
          }
          return 'unverified';
        }
        const mid=(lo+hi)/2;
        const left=check(lo,mid,depth+1);
        if(left==='blocked')return left;
        const right=check(mid,hi,depth+1);
        return right==='blocked'||left==='clear'?right:left;
      };
      let pairStatus:Verdict='clear';
      for(let i=1;i<splits.length;i++){
        const lo=splits[i-1],hi=splits[i];if(hi-lo<EPS)continue;
        const status=check(lo,hi,0);
        if(status==='blocked'){pairStatus='blocked';record(status,other.key,clamp((lo-start)/unit.dur),
          'Mesh intersection during occupied motion');break;}
        if(status==='unverified')pairStatus='unverified';
      }
      if(budgetExceeded() || intervalWork.n>maxIntervals)
        return outOfBudget('Interval/time budget reached before the full flight could be certified');
      if(pairStatus==='clear')report.verifiedPairs++;
      else if(pairStatus==='unverified')record('unverified',other.key,0,
        mate?'Connector seating cannot be waived without verified contact geometry':
          'Continuous mesh clearance could not be proven');
      if(report.status==='blocked'&&report.blockers.length>=8)break;
    }
    return report;
  }
}
