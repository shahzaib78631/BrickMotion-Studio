/**
 * Smart editor constraints: connectivity is evidence, not physics certification.
 *
 * Finds mates in their AUTHORED LDraw pose, aggregates coaxial joints, then
 * computes the instantaneous six-dimensional twist nullspace across the cut
 * between selected and stationary pieces. Unlike a one-hinge heuristic this
 * correctly locks multiple non-coaxial pins, closes multi-joint loops and
 * recognizes a two-ball linkage's single free rotation axis.
 *
 * A SNAP_CYL `slide=true` authorizes sliding while SNAPPING, not necessarily
 * physical telescoping. Prismatic/cylindrical freedom requires an explicitly
 * reviewed rule; unknown mates default to mechanically conservative behavior.
 * No constraint grants a collision exemption or certifies an insertion path.
 */
import type { Box } from '../ldraw/flatten';
import type { PartMetrics } from '../ldraw/metrics';
import type { Snap } from '../ldraw/shadow';
import type { Vec3 } from '../ldraw/parse';
import { worldSnaps, mateAxis, type WorldSnap } from '../anim/snapMates';
import { profiledCylinderMate } from '../anim/construction/profiledCylinderMate';
import { discoverPlacedAttachments } from '../model/attachmentPlacements';

export type MotionKind = 'free' | 'locked' | 'revolute' | 'prismatic' | 'cylindrical' | 'ball';
export type JointEvidence = 'ldcad-shadow' | 'reviewed-attachment' | 'explicit-verified-rule';
export type EditorJoint = {
  a: string; b: string;
  kind: Exclude<MotionKind, 'free' | 'locked'> | 'fixed';
  axis: Vec3;
  pivot: Vec3;
  evidence: JointEvidence;
  /** Source connection count, not the number of remaining degrees of freedom. */
  mates: number;
};
export type SmartPart = {
  id: string; part: string;
  world: readonly number[];
  worldBox: Box;
  /** exact body bounds, local LDraw units; used by the selection cage */
  body?: Box;
};
export type JointRule = {
  /** Authored / independently reviewed motion declaration. Order-independent. */
  parts: readonly [string, string];
  kind: 'revolute' | 'prismatic' | 'cylindrical';
  evidence: 'verified';
  /** Never inferred from SNAP_CYL.slide. */
  note: string;
};
export type MotionGuide = {
  kind: MotionKind;
  /** In world LDraw units, never in Three.js view/stud units. */
  axis?: Vec3;
  pivot?: Vec3;
  selected: string[];
  /** For the user's explicit "Select rigid module" action. */
  rigidGroup: string[];
  interfaces: EditorJoint[];
  reason: string;
  knownJoints: number;
  unknownParts: number;
};
const EPS = 1e-7;
const add = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const scale = (a: readonly number[], k: number): Vec3 => [a[0]*k, a[1]*k, a[2]*k];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const length = (v: readonly number[]): number => Math.hypot(v[0],v[1],v[2]);
const unit = (v: readonly number[]): Vec3 => scale(v,1/(length(v)||1));
const mid = (a: readonly number[], b: readonly number[]): Vec3 => scale(add(a,b),.5);
const topId = (id: string) => id.split('/')[0];
const canon = (s: string) => s.toLowerCase().replace(/(?:^|\/)parts\//, '').replace(/\.dat$/, '');
const key = (a: string,b: string) => a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
const isNear = (a: Box,b: Box,margin=1.25) => [0,1,2].every(k => a.min[k]<=b.max[k]+margin && b.min[k]<=a.max[k]+margin);

/** Only real geometry/connector pairs are considered; sorted x-axis sweep
 * prunes distant AABBs, and each part's transformed snaps are calculated once. */
export function detectEditorJoints(parts: readonly SmartPart[], metrics: (part: string) => PartMetrics,
  verified: readonly JointRule[] = []): EditorJoint[] {
  const seen = new Map<string, EditorJoint[]>();
  const snaps = new Map<string, WorldSnap[]>();
  const sorted = [...parts].sort((a,b) => a.worldBox.min[0]-b.worldBox.min[0]);
  const forPart = (p: SmartPart) => {
    let s = snaps.get(p.id);
    if (!s) { s=worldSnaps(metrics(p.part).snaps, p.world); snaps.set(p.id,s); }
    return s;
  };
  const reviewed = new Map(verified.filter(r=>r.evidence==='verified' && r.note.trim())
    .map(r => [key(canon(r.parts[0]),canon(r.parts[1])),r]));
  for(let i=0;i<sorted.length;i++) {
    const a=sorted[i];
    for(let j=i+1;j<sorted.length && sorted[j].worldBox.min[0]<=a.worldBox.max[0]+1.25;j++) {
      const b=sorted[j];
      if(topId(a.id)===topId(b.id)||!isNear(a.worldBox,b.worldBox))continue;
      const found: EditorJoint[]=[];
      const rule=reviewed.get(key(canon(a.part),canon(b.part)));
      const aa=forPart(a),bb=forPart(b);
      for(const x of aa)for(const y of bb){
        const profile = x.snap.kind==='cyl' && y.snap.kind==='cyl' ? profiledCylinderMate(x,y) : null;
        const axis=profile?.axis ?? (x.snap.kind==='cyl' && y.snap.kind==='cyl' ? null : mateAxis(x,y));
        if(!axis)continue;
        const male = x.snap.gender==='M' ? x : y;
        const spot=profile ? add(profile.origin,scale(profile.axis,profile.length/2)) :
          mid(add(x.start,scale(x.axis,x.snap.length/2)),add(y.start,scale(y.axis,y.snap.length/2)));
        const kind = rule?.kind ?? connectorFreedom(x.snap,y.snap);
        found.push({a:topId(a.id),b:topId(b.id),kind,axis:unit(axis),pivot:spot,
          evidence:rule?'explicit-verified-rule':'ldcad-shadow',mates:1});
      }
      if(found.length) {
        const pkey=key(topId(a.id),topId(b.id));
        (seen.get(pkey)??seen.set(pkey,[]).get(pkey)!).push(...found);
      }
    }
  }
  // Reviewed, non-reflected exact accessory placements are fixed relations.
  // A reflected LDraw HELP reference can position a mesh but is not a physical
  // rotation or automatically certified joint.
  const matched=discoverPlacedAttachments(parts.map(p=>({id:p.id,part:p.part,world:p.world,
    hints:metrics(p.part).attachmentHints})));
  for(const m of matched) {
    if(m.slot.mirrored || m.slot.evidence==='unreviewed-ldraw-help')continue;
    const a=topId(m.host),b=topId(m.insert),pkey=key(a,b);
    (seen.get(pkey)??seen.set(pkey,[]).get(pkey)!).push({
      a,b,kind:'fixed',axis:[0,1,0],pivot:[0,0,0],mates:1,evidence:'reviewed-attachment',
    });
  }
  return [...seen.values()].map(aggregateJoint).filter((j):j is EditorJoint=>!!j);
}

/** No broad "slide" heuristics: that flag also marks perfectly stationary pin
 * and stud mates. A single stud is treated as fixed unless a reviewed rule
 * overrides it; round pins and clips can rotate, cross axles cannot. */
export function connectorFreedom(a: Pick<Snap,'kind'|'shapes'|'radius'|'length'|'slide'|'placement'>,
  b: Pick<Snap,'kind'|'shapes'|'radius'|'length'|'slide'|'placement'>): EditorJoint['kind'] {
  // SNAP_GEN means compatible geometry, NOT necessarily a spherical joint.
  // Tyres, rims, piston heads etc are generic too. Only explicit 'free'
  // placement on both mating definitions licenses a ball-joint inference.
  if(a.kind==='gen' && b.kind==='gen') {
    const spherical=[a,b].every(s=>s.shapes.some(shape=>shape==='GEN:sph'||shape==='GEN:pnt'));
    return spherical && a.placement?.toLowerCase()==='free' && b.placement?.toLowerCase()==='free' ? 'ball' : 'fixed';
  }
  if(a.kind==='clp'||b.kind==='clp'||a.kind==='fgr'||b.kind==='fgr')return 'revolute';
  if(a.kind!=='cyl'||b.kind!=='cyl')return 'fixed';
  const aHard=a.shapes.some(s=>s==='A'||s==='S');
  const bHard=b.shapes.some(s=>s==='A'||s==='S');
  if(aHard && bHard)return 'fixed';
  // Standard 6 LDU stud/anti-stud friction fit is not a loose axle bearing.
  const stud=[a,b].some(s=>s.radius>=5.3 && s.radius<=6.7 && s.length<=8.2 && s.shapes.some(x=>x==='R'));
  if(stud)return 'fixed';
  return 'revolute';
}

/** Multiple simultaneous contacts between two parts are the INTERSECTION of
 * their allowed twists, not a union. Rigid offset pins -> fixed; coincident
 * pins -> revolute. A ball at the same pivot as a hinge leaves the hinge. */
function aggregateJoint(joints: EditorJoint[]): EditorJoint | null {
  if(!joints.length)return null;
  const base=joints[0];
  if(joints.length===1)return base;
  const result=solveCut(joints);
  return { ...base, kind:result.kind==='free'||result.kind==='locked'?'fixed':result.kind,
    axis:result.axis??base.axis,pivot:result.pivot??base.pivot,
    mates:joints.reduce((sum,j)=>sum+j.mates,0),
    evidence:joints.some(j=>j.evidence==='reviewed-attachment')?'reviewed-attachment':base.evidence };
}

/** Nullspace of constraints on angular (w) + linear (v) body twist.
 * The linear component is velocity at the origin, in units of 20 LDU/radian.
 * RREF uses row scaling and partial pivoting for mixed world coordinate sizes. */
export function twistNullspace(rows: readonly (readonly number[])[]): number[][] {
  const m=rows.map(r=>Array.from(r).slice(0,6));
  for(const r of m){ const n=Math.hypot(...r);if(n>EPS)for(let k=0;k<6;k++)r[k]/=n; }
  let row=0;const pivots:number[]=[];
  for(let col=0;col<6 && row<m.length;col++){
    let best=row;
    for(let r=row+1;r<m.length;r++)if(Math.abs(m[r][col])>Math.abs(m[best][col]))best=r;
    if(Math.abs(m[best][col])<EPS)continue;
    [m[row],m[best]]=[m[best],m[row]];
    const pivot=m[row][col];for(let c=0;c<6;c++)m[row][c]/=pivot;
    for(let r=0;r<m.length;r++)if(r!==row){const t=m[r][col];if(Math.abs(t)<1e-13)continue;
      for(let c=0;c<6;c++)m[r][c]-=t*m[row][c];}
    pivots.push(col);row++;
  }
  const free=[0,1,2,3,4,5].filter(c=>!pivots.includes(c));
  return free.map(c=>{
    const out=new Array<number>(6).fill(0);out[c]=1;
    pivots.forEach((p,r)=>{out[p]=-m[r][c];});
    const n=Math.hypot(...out);return out.map(x=>x/n);
  });
}

type MotionPose = {kind:MotionKind;axis?:Vec3;pivot?:Vec3};
const triple = (v: readonly number[],at=0):Vec3 => [v[at],v[at+1],v[at+2]];
const near = (a:readonly number[],b:readonly number[],eps=.002) => length(cross(a,b))<eps;
/** Constrain point velocity: v + w×p = 0. p is relative to local origin, in studs. */
const pointRows=(p:Vec3):number[][] => [
  [0,p[2],-p[1],1,0,0],[-p[2],0,p[0],0,1,0],[p[1],-p[0],0,0,0,1]
];
const perp=(a:Vec3):[Vec3,Vec3]=>{
  const d=unit(a),seed=Math.abs(d[0])<.8?[1,0,0]:[0,1,0];
  const x=unit(cross(d,seed));return [x,unit(cross(d,x))];
};
function constraints(joint:EditorJoint,origin:Vec3):number[][] {
  const p=scale(sub(joint.pivot,origin),1/20),[px,py,pz]=pointRows(p);
  const [n1,n2]=perp(joint.axis);
  const angular=(n:Vec3):number[]=>[...n,0,0,0];
  const projected=(n:Vec3):number[]=>Array.from({length:6},(_,i)=>n[0]*px[i]+n[1]*py[i]+n[2]*pz[i]);
  switch(joint.kind){
    case 'fixed':return [[1,0,0,0,0,0],[0,1,0,0,0,0],[0,0,1,0,0,0],
      [0,0,0,1,0,0],[0,0,0,0,1,0],[0,0,0,0,0,1]];
    case 'ball':return [px,py,pz];
    case 'revolute':return [px,py,pz,angular(n1),angular(n2)];
    case 'cylindrical':return [projected(n1),projected(n2),angular(n1),angular(n2)];
    case 'prismatic':return [angular([1,0,0]),angular([0,1,0]),angular([0,0,1]),projected(n1),projected(n2)];
  }
}

/** True degrees of freedom across all simultaneous joints, not sum of labels. */
export function solveCut(joints: readonly EditorJoint[]): MotionPose {
  if(!joints.length)return {kind:'free'};
  const origin=joints[0].pivot;
  const basis=twistNullspace(joints.flatMap(j=>constraints(j,origin)));
  if(basis.length===0)return {kind:'locked'};
  if(basis.length===6)return {kind:'free'};
  if(basis.length===1){
    const [q]=basis,w=triple(q),v=triple(q,3),n=length(w);
    if(n<1e-5)return {kind:'prismatic',axis:unit(v),pivot:origin};
    // A screw has nonzero pitch. No supported hinge/mate should create one.
    if(Math.abs(dot(w,v))>1e-4)return {kind:'locked'};
    const delta=scale(cross(w,v),20/(n*n));
    return {kind:'revolute',axis:unit(w),pivot:add(origin,delta)};
  }
  if(basis.length===3 && joints.every(j=>j.kind==='ball')){
    return {kind:'ball',pivot:origin};
  }
  if(basis.length===2){
    // A cylindrical mate admits one pure slide and one pure rotation about the
    // same axis. Reject other 2D freedoms until a suitable UI exists.
    const w0=triple(basis[0]),w1=triple(basis[1]);
    if(length(w0)<1e-5 || length(w1)<1e-5 || near(w0,w1)){
      const slide=length(w0)<1e-5 ? triple(basis[0],3) : length(w1)<1e-5 ? triple(basis[1],3) :
        sub(scale(triple(basis[0],3),length(w1)),scale(triple(basis[1],3),dot(w0,w1)/(length(w0)||1)));
      const axis=unit(slide);
      if(length(axis)>0.9 && joints.every(j=>j.kind==='cylindrical'))
        return {kind:'cylindrical',axis:jointAxis(joints,axis),pivot:origin};
    }
  }
  return {kind:'locked'};
}
const jointAxis=(joints:readonly EditorJoint[],defaultAxis:Vec3):Vec3 =>
  joints.length?joints[0].axis:defaultAxis;

/** Rigid components are ONLY a selection suggestion, never silently moved. */
export function rigidModule(selection:readonly string[],joints:readonly EditorJoint[]):string[] {
  const found=new Set(selection),queue=[...selection];
  const links=new Map<string,string[]>();
  for(const j of joints)if(j.kind==='fixed'){
    (links.get(j.a)??links.set(j.a,[]).get(j.a)!).push(j.b);
    (links.get(j.b)??links.set(j.b,[]).get(j.b)!).push(j.a);
  }
  while(queue.length){ const id=queue.pop()!;for(const neighbor of links.get(id)??[])
    if(!found.has(neighbor)){found.add(neighbor);queue.push(neighbor);} }
  return [...found];
}

/** The edit's current selection is the moving body, EVERY non-selected part is
 * stationary. Nothing ever auto-moves a LEGO piece the user did not select. */
export function guideSelection(selection:readonly string[],parts:readonly SmartPart[],joints:readonly EditorJoint[],
  metrics?: (part:string)=>PartMetrics):MotionGuide {
  const ids=[...new Set(selection)];
  const selected=new Set(ids);
  const interfaces=joints.filter(j=>selected.has(j.a)!==selected.has(j.b));
  const raw=solveCut(interfaces);
  const rigidGroup=rigidModule(ids,joints);
  const missing = metrics ? parts.filter(p=>!metrics(p.part).snaps?.length && !metrics(p.part).attachmentHints?.length).length : 0;
  const reason=raw.kind==='free' ? 'No known joint crosses the selection; move or rotate freely. Missing connector data is not proof of disconnection.' :
    raw.kind==='locked' ? `${interfaces.length} constrained interface${interfaces.length===1?'':'s'} prevent an independent rigid-body move. Select the rigid module or turn Smart joints off to detach.` :
    raw.kind==='ball' ? 'Ball socket: rotate around its connector centre; translation is constrained.' :
    raw.kind==='revolute' ? 'Hinge/bearing: rotate about the detected joint axis only.' :
    raw.kind==='prismatic' ? 'Verified linear guide: translation along its joint axis only.' :
    'Verified cylindrical joint: rotate or slide along the shared axis.';
  return {...raw,selected:ids,interfaces,rigidGroup,reason,knownJoints:joints.length,unknownParts:missing};
}

/** A quick pure-data entrypoint, also used by the offline verification suite. */
export function analyseSelection(parts:readonly SmartPart[],ids:readonly string[],metrics:(part:string)=>PartMetrics,
  verified:readonly JointRule[]=[]):MotionGuide {
  const joints=detectEditorJoints(parts,metrics,verified);
  return guideSelection(ids,parts,joints,metrics);
}
