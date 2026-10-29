/**
 * V6 experimental spatial linkage solver. A body has three translations (LDU)
 * and three rotations (radians). It is grounded ONLY if explicitly fixed.
 *
 * Ideal holonomic constraints: ball (3), hinge (5), slider (5), weld (6),
 * fixed-length link (1). V7 adds authored mechanical transmission, travel
 * limits and ratchet constraints inside the same damped nonlinear solve.
 * This deliberately does NOT claim collisions, forces, contact or dynamics.
 *
 * No dependencies on Three.js or the UI: deterministic offline benchmarks can
 * test actual constraint residuals without a graphics / browser environment.
 */
import { sliderCrankTravel,scotchYokeTravel,camProfileTravel,intermittentIndexTravel,differentialDriveTravel } from '../v8/mechanismLaws';
export type V3 = [number, number, number];
export type Q4 = [number, number, number, number]; // x,y,z,w
export type SpatialPose = { p: V3; q: Q4 };
export type SpatialBody = { id: string; rest: SpatialPose; fixed?: boolean };
export type SpatialPoint = { body: string; local: V3 };
export type SpatialConstraint = (
  | { kind: 'ball'; a: SpatialPoint; b: SpatialPoint }
  | { kind: 'hinge' | 'slider' | 'cylindrical' | 'universal' | 'planar'; a: SpatialPoint; b: SpatialPoint;
      axisA: V3; axisB: V3; refA?: V3; refB?: V3 }
  | { kind: 'distance'; a: SpatialPoint; b: SpatialPoint; lengthLdu: number }
  | { kind: 'weld'; a: string; b: string }
) & { id: string };

/** V7 ideal mechanical relationships between spatial joint coordinates.
 * These DO NOT imply physical tooth contact, string tension, or self-locking
 * from friction. All joint IDs reference existing hinge/slider constraints.
 */
export type SpatialMechanic = (
  | { kind: 'gear'; input: string; output: string; inputTeeth: number; outputTeeth: number; internal?: boolean }
  | { kind: 'bevel-gear'; input: string; output: string; inputTeeth: number; outputTeeth: number; reversed?: boolean }
  | { kind: 'belt' | 'chain'; input: string; output: string; inputTeeth: number; outputTeeth: number; crossed?: boolean }
  | { kind: 'worm'; input: string; output: string; starts: number; wheelTeeth: number; reversed?: boolean }
  | { kind: 'cv-joint'; input: string; output: string; reversed?: boolean }
  | { kind: 'clutch'; input: string; output: string; engaged: boolean; reversed?: boolean }
  | { kind: 'universal-drive'; input: string; output: string; bendAngleRad: number; reversed?: boolean }
  | { kind: 'rack-pinion'; rotary: string; linear: string; pitchRadiusLdu: number; reversed?: boolean }
  | { kind: 'wheel-rolling'; rotary: string; linear: string; wheelRadiusLdu: number; reversed?: boolean }
  | { kind: 'screw'; rotary: string; linear: string; leadLduPerTurn: number; reversed?: boolean }
  | { kind: 'winch'; rotary: string; linear: string; drumRadiusLdu: number; supportedSegments: number; reversed?: boolean }
  | { kind: 'differential'; carrier: string; left: string; right: string }
  | { kind: 'ackermann-steering'; input: string; left: string; right: string; wheelbaseLdu: number; trackWidthLdu: number }
  | { kind: 'planetary'; sun: string; ring: string; carrier: string; sunTeeth: number; ringTeeth: number }
  | { kind: 'cam-follower'; cam: string; follower: string; liftLdu: number; lobes: number; phaseRad?: number; reversed?: boolean }
  | { kind: 'stop'; joint: string; min: number; max: number }
  | { kind: 'brake'; joint: string; engaged: boolean }
  | { kind: 'ratchet'; joint: string; direction: 'positive' | 'negative'; engaged?: boolean }
  | { kind: 'slider-crank'; crank: string; slider: string; crankRadiusLdu: number; rodLengthLdu: number; guideOffsetLdu?: number; reversed?: boolean }
  | { kind: 'scotch-yoke'; crank: string; slider: string; radiusLdu: number; phaseRad?: number; reversed?: boolean }
  | { kind: 'linear-coupler'; input: string; output: string; ratio: number }
  | { kind: 'hydraulic-pair'; first: string; second: string; areaFirst: number; areaSecond: number }
  | { kind: 'backlash-gear'; input: string; output: string; inputTeeth: number; outputTeeth: number; clearanceRad: number; internal?: boolean }
  | { kind: 'detent'; joint: string; pitch: number; engaged: boolean }
  | { kind: 'cam-profile'; cam: string; follower: string; profileLdu: number[]; lobes?: number; phaseRad?: number; reversed?: boolean }
  | { kind: 'intermittent-indexer'; input: string; output: string; slots: number; activeFraction: number; phaseRad?: number; reversed?: boolean }
  | { kind: 'differential-drive'; left: string; right: string; forward: string; yaw: string; wheelRadiusLdu: number; trackWidthLdu: number }
) & { id: string };
export type SpatialModel = {
  bodies: SpatialBody[];
  constraints: SpatialConstraint[];
  mechanics?: SpatialMechanic[];
};
export type SpatialSolution = {
  poses: ReadonlyMap<string, SpatialPose>;
  /** Rest-relative hinge radians (unwrapped by accepted-pose continuation)
   * or slider LDU; never infer full turns from an isolated single pose. */
  jointPositions: ReadonlyMap<string, number>;
  status: 'converged' | 'failed';
  iterations: number;
  maxResidualLdu: number;
  residualByConstraint: ReadonlyMap<string, number>;
  /** Tangent-space unconstrained directions at this pose (approximate). */
  estimatedFreeDof: number;
  warning?: string;
};
const add=(a:V3,b:V3):V3=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const sub=(a:V3,b:V3):V3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const mul=(a:V3,s:number):V3=>[a[0]*s,a[1]*s,a[2]*s];
const dot=(a:V3,b:V3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a:V3,b:V3):V3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const mag=(a:V3)=>Math.hypot(...a);
const unit=(a:V3):V3=>{const l=mag(a);if(!Number.isFinite(l)||l<1e-10)throw Error('Invalid zero-length linkage axis');return mul(a,1/l);};
const finite3=(a:unknown):a is V3=>Array.isArray(a)&&a.length===3&&a.every(x=>typeof x==='number'&&Number.isFinite(x));
const qmul=(a:Q4,b:Q4):Q4=>[
 a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
 a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
 a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
 a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2],
];
const qconj=(q:Q4):Q4=>[-q[0],-q[1],-q[2],q[3]];
const qunit=(q:Q4):Q4=>{const n=Math.hypot(...q);if(n<1e-10||!Number.isFinite(n))throw Error('Invalid linkage quaternion');return q.map(v=>v/n) as Q4;};
const qexp=(v:V3):Q4=>{const n=mag(v);return n<1e-12?[v[0]/2,v[1]/2,v[2]/2,1]:[...mul(v,Math.sin(n/2)/n),Math.cos(n/2)];};
const rotate=(q:Q4,v:V3):V3=>{
 // Matrix-free unit-quaternion rotation.
 const xyz:V3=[q[0],q[1],q[2]],t=mul(cross(xyz,v),2);
 return add(v,add(mul(t,q[3]),cross(xyz,t)));
};
const worldPoint=(pose:SpatialPose,local:V3)=>add(pose.p,rotate(pose.q,local));
const basis=(axis:V3):[V3,V3]=>{
 const u=unit(Math.abs(axis[0])<.7?cross(axis,[1,0,0]):cross(axis,[0,1,0]));
 return [u,cross(axis,u)];
};
const perpendicular=(axis:V3)=>basis(axis)[0];
const wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a));
const angularDifference=(axis:V3,a:V3,b:V3):number=>{
 const pa=unit(sub(a,mul(axis,dot(a,axis)))),pb=unit(sub(b,mul(axis,dot(b,axis))));
 return Math.atan2(dot(axis,cross(pa,pb)),dot(pa,pb));
};
const orientationError=(actual:Q4,expected:Q4):V3=>{
 let d=qmul(actual,qconj(expected));
 if(d[3]<0)d=d.map(x=>-x) as Q4;
 const v:V3=[d[0],d[1],d[2]],len=mag(v);
 return len<1e-10?mul(v,2):mul(v,2*Math.atan2(len,d[3])/len);
};
const ORIENTATION_LDU=20;
const driveRef=(ref:V3|undefined,axis:V3)=>ref?unit(ref):perpendicular(unit(axis));
const finitePose=(p:SpatialPose)=>finite3(p?.p)&&Array.isArray(p?.q)&&p.q.length===4&&p.q.every(Number.isFinite);

/** Returns an actionable message for missing ground, invalid axes or topology. */
export function validateSpatialModel(model:SpatialModel):string[] {
 const errors:string[]=[];
 if(!Array.isArray(model?.bodies)||model.bodies.length<2||model.bodies.length>16)return ['Spatial solver requires 2–16 bodies'];
 if(!Array.isArray(model.constraints)||model.constraints.length>48)return ['Spatial solver supports up to 48 constraints'];
 if(model.mechanics!==undefined&&(!Array.isArray(model.mechanics)||model.mechanics.length>64))return ['Spatial solver supports at most 64 mechanical relationships'];
 const bodies=new Map<string,SpatialBody>();
 for(const body of model.bodies){
  if(typeof body?.id!=='string'||!body.id.trim()||bodies.has(body.id)||!finitePose(body.rest)||Math.abs(Math.hypot(...body.rest.q)-1)>1e-3)
   errors.push(`Invalid body ${body?.id??'?'} or nonunit rest quaternion`);
  else {
   if(body.fixed!==undefined&&typeof body.fixed!=='boolean')errors.push(`${body.id}: fixed must be a boolean`);
   bodies.set(body.id,body);
  }
 }
 if(!model.bodies.some(b=>b?.fixed===true))errors.push('Unanchored mechanism: mark at least one explicit ground body fixed');
 const connected=new Map([...bodies.keys()].map(id=>[id,new Set<string>()]));
 const names=new Set<string>();
 for(const c of model.constraints){
  if(!c||typeof c!=='object'||Array.isArray(c)){errors.push('Malformed spatial constraint entry');continue;}
  if(typeof c.id!=='string'||!c.id.trim()||names.has(c.id))errors.push('Missing or duplicate spatial constraint ID');
  names.add(c.id);
  if(!['ball','hinge','slider','cylindrical','universal','planar','distance','weld'].includes(c.kind)){
   errors.push(`${c.id}: unsupported spatial joint kind`);continue;
  }
  const a=c.kind==='weld'?c.a:c.a?.body, b=c.kind==='weld'?c.b:c.b?.body;
  if(!bodies.has(a)||!bodies.has(b)||a===b){errors.push(`${c.id}: expected two distinct existing bodies`);continue;}
  connected.get(a!)!.add(b!);connected.get(b!)!.add(a!);
  if(c.kind!=='weld'&&(!finite3(c.a.local)||!finite3(c.b.local)))errors.push(`${c.id}: invalid local anchor`);
  if(c.kind==='hinge'||c.kind==='slider'||c.kind==='cylindrical'||c.kind==='universal'||c.kind==='planar'){
   if(!finite3(c.axisA)||!finite3(c.axisB)||
      mag(c.axisA)<1e-9||mag(c.axisB)<1e-9||
      c.refA&&!finite3(c.refA)||c.refB&&!finite3(c.refB))
     errors.push(`${c.id}: invalid local axis/reference`);
   else if((c.refA && (mag(c.refA)<1e-9 ||
       Math.abs(dot(unit(c.refA),unit(c.axisA)))>.995)) ||
     (c.refB && (mag(c.refB)<1e-9 ||
       Math.abs(dot(unit(c.refB),unit(c.axisB)))>.995)))
     errors.push(`${c.id}: motor reference must be nonzero and perpendicular to the shaft`);
  }
  if(c.kind==='distance'&&(!Number.isFinite(c.lengthLdu)||c.lengthLdu<=0))errors.push(`${c.id}: invalid link length`);
 }
 const joints=new Map(model.constraints.filter(c=>c&&typeof c==='object').map(c=>[c.id,c]));
 const requireJoint=(mechanic:SpatialMechanic,id:string,kind:'hinge'|'slider')=>{
  if(joints.get(id)?.kind!==kind)errors.push(`${mechanic.id}: ${id} must reference an existing ${kind}`);
 };
 const positive=(mechanic:SpatialMechanic,field:string,value:number,max=100000)=>{
  if(!Number.isFinite(value)||value<=0||value>max)errors.push(`${mechanic.id}: invalid ${field}`);
 };
 for(const m of model.mechanics??[]){
  if(!m||typeof m!=='object'||typeof m.kind!=='string'){
   errors.push('Invalid mechanical relationship entry');continue;
  }
  if(typeof m.id!=='string'||!m.id.trim()||names.has(m.id))errors.push('Missing or duplicate mechanical relationship ID');
  names.add(m?.id);
  switch(m.kind){
   case 'gear':case 'bevel-gear':case 'belt':case 'chain':
    requireJoint(m,m.input,'hinge');requireJoint(m,m.output,'hinge');
    positive(m,'input teeth',m.inputTeeth,1000);positive(m,'output teeth',m.outputTeeth,1000);
    if(!Number.isInteger(m.inputTeeth)||!Number.isInteger(m.outputTeeth))errors.push(`${m.id}: tooth counts must be whole numbers`);
    if(m.input===m.output)errors.push(`${m.id}: input and output must differ`);
    if(m.kind==='gear'&&m.internal!==undefined&&typeof m.internal!=='boolean')errors.push(`${m.id}: internal must be boolean`);
    if(m.kind==='belt'&&m.crossed!==undefined&&typeof m.crossed!=='boolean')errors.push(`${m.id}: crossed must be boolean`);
    break;
   case 'worm':
    requireJoint(m,m.input,'hinge');requireJoint(m,m.output,'hinge');
    positive(m,'worm starts',m.starts,8);positive(m,'wheel teeth',m.wheelTeeth,1000);
    if(!Number.isInteger(m.starts)||!Number.isInteger(m.wheelTeeth))errors.push(`${m.id}: worm starts/teeth must be integers`);
    if(m.input===m.output)errors.push(`${m.id}: input and output must differ`);
    break;
   case 'cv-joint':case 'clutch':case 'universal-drive':
    requireJoint(m,m.input,'hinge');requireJoint(m,m.output,'hinge');
    if(m.input===m.output)errors.push(`${m.id}: input and output must differ`);
    if(m.reversed!==undefined&&typeof m.reversed!=='boolean')errors.push(`${m.id}: reversed must be boolean`);
    if(m.kind==='clutch'&&typeof (m as {engaged:unknown}).engaged!=='boolean')errors.push(`${m.id}: clutch engagement must be boolean`);
    if(m.kind==='universal-drive'&&(!Number.isFinite(m.bendAngleRad)||m.bendAngleRad<0||m.bendAngleRad>=Math.PI/2-.02))
     errors.push(`${m.id}: universal shaft bend must be between zero and 88 degrees`);
    break;
   case 'rack-pinion':case 'wheel-rolling':case 'screw':case 'winch':
    requireJoint(m,m.rotary,'hinge');requireJoint(m,m.linear,'slider');
    if(m.kind==='rack-pinion')positive(m,'pitch radius',m.pitchRadiusLdu);
    if(m.kind==='wheel-rolling')positive(m,'wheel radius',m.wheelRadiusLdu);
    if(m.kind==='screw')positive(m,'screw lead',m.leadLduPerTurn);
    if(m.kind==='winch'){
     positive(m,'drum radius',m.drumRadiusLdu);
     if(!Number.isInteger(m.supportedSegments)||m.supportedSegments<1||m.supportedSegments>12)
      errors.push(`${m.id}: supported rope segments must be an integer 1–12`);
    }
    break;
   case 'differential':
    for(const joint of [m.carrier,m.left,m.right])requireJoint(m,joint,'hinge');
    if(new Set([m.carrier,m.left,m.right]).size!==3)errors.push(`${m.id}: differential needs three distinct shafts`);
    break;
   case 'ackermann-steering':
    for(const joint of [m.input,m.left,m.right])requireJoint(m,joint,'hinge');
    if(new Set([m.input,m.left,m.right]).size!==3)errors.push(`${m.id}: Ackermann steering needs three distinct shaft joints`);
    positive(m,'wheelbase',m.wheelbaseLdu);positive(m,'track width',m.trackWidthLdu);
    break;
   case 'planetary':
    for(const joint of [m.sun,m.ring,m.carrier])requireJoint(m,joint,'hinge');
    if(new Set([m.sun,m.ring,m.carrier]).size!==3)errors.push(`${m.id}: planetary needs three distinct shafts`);
    positive(m,'sun teeth',m.sunTeeth,1000);positive(m,'ring teeth',m.ringTeeth,1000);
    if(!Number.isInteger(m.sunTeeth)||!Number.isInteger(m.ringTeeth))errors.push(`${m.id}: planetary teeth must be integers`);
    if(m.ringTeeth<=m.sunTeeth)errors.push(`${m.id}: ring gear must have more teeth than the sun`);
    break;
   case 'cam-follower':
    requireJoint(m,m.cam,'hinge');requireJoint(m,m.follower,'slider');
    positive(m,'cam lift',m.liftLdu);
    if(!Number.isInteger(m.lobes)||m.lobes<1||m.lobes>16)errors.push(`${m.id}: cam lobes must be an integer 1–16`);
    if(m.phaseRad!==undefined&&!Number.isFinite(m.phaseRad))errors.push(`${m.id}: invalid cam phase`);
    break;
   case 'stop':
    if(!['hinge','slider'].includes(joints.get(m.joint)?.kind??''))errors.push(`${m.id}: stop needs a hinge or slider`);
    if(!Number.isFinite(m.min)||!Number.isFinite(m.max)||m.min>0||m.max<0||m.min>=m.max)
     errors.push(`${m.id}: joint stops must straddle the assembled rest position (zero)`);
    break;
   case 'brake':
    if(!['hinge','slider'].includes(joints.get(m.joint)?.kind??''))errors.push(`${m.id}: brake needs a hinge or slider`);
    if(typeof (m as {engaged:unknown}).engaged!=='boolean')errors.push(`${m.id}: brake engagement must be boolean`);
    break;
   case 'ratchet':
    if(!['hinge','slider'].includes(joints.get(m.joint)?.kind??''))errors.push(`${m.id}: ratchet needs a hinge or slider`);
    if(m.direction!=='positive'&&m.direction!=='negative')errors.push(`${m.id}: invalid pawl direction`);
    if(m.engaged!==undefined&&typeof (m as {engaged:unknown}).engaged!=='boolean')errors.push(`${m.id}: pawl engagement must be boolean`);
    break;
   case 'slider-crank':
    requireJoint(m,m.crank,'hinge');requireJoint(m,m.slider,'slider');
    positive(m,'crank radius',m.crankRadiusLdu);positive(m,'rod length',m.rodLengthLdu);
    if(m.guideOffsetLdu!==undefined&&!Number.isFinite(m.guideOffsetLdu))errors.push(`${m.id}: invalid guide offset`);
    if(m.rodLengthLdu<=m.crankRadiusLdu+Math.abs(m.guideOffsetLdu??0))
     errors.push(`${m.id}: connecting rod must exceed crank radius plus guide offset for a complete safe revolution`);
    break;
   case 'scotch-yoke':
    requireJoint(m,m.crank,'hinge');requireJoint(m,m.slider,'slider');positive(m,'yoke radius',m.radiusLdu);
    if(m.phaseRad!==undefined&&!Number.isFinite(m.phaseRad))errors.push(`${m.id}: invalid yoke phase`);
    break;
   case 'linear-coupler':
    requireJoint(m,m.input,'slider');requireJoint(m,m.output,'slider');
    if(m.input===m.output)errors.push(`${m.id}: sliders must differ`);
    if(!Number.isFinite(m.ratio)||m.ratio===0||Math.abs(m.ratio)>100)
     errors.push(`${m.id}: linear-coupler ratio must be finite and nonzero, at most 100:1`);
    break;
   case 'hydraulic-pair':
    requireJoint(m,m.first,'slider');requireJoint(m,m.second,'slider');
    if(m.first===m.second)errors.push(`${m.id}: hydraulic pistons must differ`);
    positive(m,'first piston area',m.areaFirst);positive(m,'second piston area',m.areaSecond);
    break;
   case 'backlash-gear':
    requireJoint(m,m.input,'hinge');requireJoint(m,m.output,'hinge');
    if(m.input===m.output)errors.push(`${m.id}: backlash gear shafts must differ`);
    positive(m,'input teeth',m.inputTeeth,1000);positive(m,'output teeth',m.outputTeeth,1000);
    if(!Number.isInteger(m.inputTeeth)||!Number.isInteger(m.outputTeeth))errors.push(`${m.id}: teeth must be integers`);
    if(!Number.isFinite(m.clearanceRad)||m.clearanceRad<=0||m.clearanceRad>Math.PI/3)
     errors.push(`${m.id}: backlash clearance must be in (0, pi/3] radians`);
    break;
   case 'detent':
    if(!['hinge','slider'].includes(joints.get(m.joint)?.kind??''))errors.push(`${m.id}: detent needs hinge or slider`);
    positive(m,'detent pitch',m.pitch);
    if(typeof (m as {engaged:unknown}).engaged!=='boolean')errors.push(`${m.id}: detent engagement must be boolean`);
    break;
   case 'cam-profile':
    requireJoint(m,m.cam,'hinge');requireJoint(m,m.follower,'slider');
    if(!Array.isArray(m.profileLdu)||m.profileLdu.length<4||m.profileLdu.length>64||
       !m.profileLdu.every(v=>Number.isFinite(v)&&v>=0&&v<=10000))
     errors.push(`${m.id}: cam profile needs 4–64 finite nonnegative lift samples`);
    if(m.lobes!==undefined&&(!Number.isInteger(m.lobes)||m.lobes<1||m.lobes>16))
     errors.push(`${m.id}: cam lobes must be integers 1–16`);
    if(m.phaseRad!==undefined&&!Number.isFinite(m.phaseRad))errors.push(`${m.id}: invalid cam phase`);
    break;
   case 'intermittent-indexer':
    requireJoint(m,m.input,'hinge');requireJoint(m,m.output,'hinge');
    if(m.input===m.output)errors.push(`${m.id}: indexer shafts must differ`);
    if(!Number.isInteger(m.slots)||m.slots<3||m.slots>24)errors.push(`${m.id}: indexer slots must be an integer 3–24`);
    if(!Number.isFinite(m.activeFraction)||m.activeFraction<.1||m.activeFraction>.9)
     errors.push(`${m.id}: indexer active fraction must be 0.1–0.9`);
    if(m.phaseRad!==undefined&&!Number.isFinite(m.phaseRad))errors.push(`${m.id}: invalid index phase`);
    break;
   case 'differential-drive':
    requireJoint(m,m.left,'hinge');requireJoint(m,m.right,'hinge');
    requireJoint(m,m.yaw,'hinge');requireJoint(m,m.forward,'slider');
    if(new Set([m.left,m.right,m.yaw,m.forward]).size!==4)
     errors.push(`${m.id}: differential drive requires four distinct joints`);
    positive(m,'wheel radius',m.wheelRadiusLdu);positive(m,'track width',m.trackWidthLdu);
    break;
   default: errors.push(`${(m as {id?:string}).id}: unsupported mechanical relationship`);
  }
 }
 const reached=new Set(model.bodies.filter(b=>b.fixed).map(b=>b.id));
 const pending=[...reached];
 for(let i=0;i<pending.length;i++)for(const next of connected.get(pending[i])??[]){
  if(!reached.has(next)){reached.add(next);pending.push(next);}
 }
 for(const b of model.bodies)if(b&&!b.fixed&&!reached.has(b.id))
  errors.push(`${b.id}: free-floating component has no connection to an explicit ground`);
 return errors;
}

// A bounded pivoting linear solver for the LM normal equations. Returns null
// on ill-conditioned/unbounded inputs instead of generating NaN poses.
function linearSolve(A:number[][],b:number[]):number[]|null {
 const n=b.length, M=A.map((row,i)=>[...row,b[i]]);
 for(let col=0;col<n;col++){
  let pivot=col;
  for(let row=col+1;row<n;row++)if(Math.abs(M[row][col])>Math.abs(M[pivot][col]))pivot=row;
  if(Math.abs(M[pivot][col])<1e-15)return null;
  [M[col],M[pivot]]=[M[pivot],M[col]];
  const scale=M[col][col];for(let j=col;j<=n;j++)M[col][j]/=scale;
  for(let row=col+1;row<n;row++){
   const k=M[row][col];for(let j=col;j<=n;j++)M[row][j]-=k*M[col][j];
  }
 }
 const result=Array<number>(n).fill(0);
 for(let i=n-1;i>=0;i--){let value=M[i][n];for(let j=i+1;j<n;j++)value-=M[i][j]*result[j];result[i]=value;}
 return result.every(Number.isFinite)?result:null;
}

/** Numerically rank the constraint Jacobian to report local mobility. The
 * count includes requested motor equations; near singularities are flagged. */
function numericalRank(columns:number[][]):number {
 const rows=columns.length?columns[0].length:0;
 const m=Array.from({length:rows},(_,r)=>columns.map(col=>col[r]));
 let rank=0;
 for(let c=0;c<columns.length&&rank<rows;c++){
  let pivot=rank;for(let r=rank+1;r<rows;r++)if(Math.abs(m[r][c])>Math.abs(m[pivot][c]))pivot=r;
  if(Math.abs(m[pivot][c])<1e-5)continue;
  [m[rank],m[pivot]]=[m[pivot],m[rank]];
  const x=m[rank][c];for(let j=c;j<columns.length;j++)m[rank][j]/=x;
  for(let r=rank+1;r<rows;r++){
   const a=m[r][c];for(let j=c;j<columns.length;j++)m[r][j]-=a*m[rank][j];
  }
  rank++;
 }
 return rank;
}

export class SpatialMechanismSolver {
 readonly model:SpatialModel;
 readonly moving:readonly SpatialBody[];
 readonly bodies:ReadonlyMap<string,SpatialBody>;
 private state:number[];
 /** Legacy V7 rigs toggled brake/clutch/pawl engagement on the caller model.
  * Preserve this narrow behaviour; structural edits remain snapshot-isolated. */
 private readonly engagementSource:SpatialModel;
 /** Pawls remember the most advanced accepted joint position. Their state is
  * updated only on successful solves and cleared on reset. */
 private readonly ratchetStops=new Map<string,number>();
 /** Unwrapped joint winding is defined by the ordered sequence of accepted
  * solutions, not by the orientation quaternion alone. Reset clears it. */
 private readonly acceptedPositions=new Map<string,number>();
 constructor(model:SpatialModel){
  const errors=validateSpatialModel(model);
  if(errors.length)throw Error(errors.join('; '));
  // Iteration 4: reject mutations of the caller-owned rig after solver creation.
  // This also makes the solver's cached body map and constraint arrays consistent.
  this.engagementSource=model;
  this.model=structuredClone(model);
  this.bodies=new Map(this.model.bodies.map(b=>[b.id,b]));
  this.moving=this.model.bodies.filter(b=>!b.fixed);
  this.state=Array(this.moving.length*6).fill(0);
  // A model may be authored off-constraint. Do not silently redefine its rest.
  const rest=this.measure(this.state,{});
  if(Math.max(0,...rest.parts.map(p=>magOf(p)))>.05)
   throw Error('Spatial assembly is not closed at rest; fix assembled anchors/axes before solving');
 }
 private poses(state:readonly number[]):Map<string,SpatialPose>{
  const poses=new Map<string,SpatialPose>();
  for(const b of this.model.bodies)poses.set(b.id,{p:[...b.rest.p],q:[...b.rest.q]});
  this.moving.forEach((b,i)=>{
   const off=i*6;
   const p=add(b.rest.p,[state[off],state[off+1],state[off+2]]);
   const q=qunit(qmul(qexp([state[off+3],state[off+4],state[off+5]]),b.rest.q));
   poses.set(b.id,{p,q});
  });
  return poses;
 }
 private measure(state:readonly number[],drives:Readonly<Record<string,number>>){
  const poses=this.poses(state);
  const parts:{id:string;values:number[]}[]=[];
  const jointPositions=new Map<string,number>();
  for(const c of this.model.constraints){
   const a=c.kind==='weld'?poses.get(c.a)!:poses.get(c.a.body)!;
   const b=c.kind==='weld'?poses.get(c.b)!:poses.get(c.b.body)!;
   if(c.kind==='weld'){
    const restA=this.bodies.get(c.a)!.rest,restB=this.bodies.get(c.b)!.rest;
    const relative=qmul(a.q,qconj(restA.q));
    const expectedP=add(a.p,rotate(relative,sub(restB.p,restA.p)));
    const expectedQ=qmul(relative,restB.q);
    parts.push({id:c.id,values:[...sub(b.p,expectedP),...mul(orientationError(b.q,expectedQ),ORIENTATION_LDU)]});
    continue;
   }
   const pa=worldPoint(a,c.a.local),pb=worldPoint(b,c.b.local);
   if(c.kind==='distance'){parts.push({id:c.id,values:[mag(sub(pa,pb))-c.lengthLdu]});continue;}
   if(c.kind==='ball'){parts.push({id:c.id,values:[...sub(pb,pa)]});continue;}
   const aa=unit(rotate(a.q,unit(c.axisA))), bb=unit(rotate(b.q,unit(c.axisB)));
   const [u,v]=basis(aa);
   if(c.kind==='hinge'){
    const diff=sub(pb,pa), alignment=cross(aa,bb);
    parts.push({id:c.id,values:[...diff,ORIENTATION_LDU*dot(alignment,u),ORIENTATION_LDU*dot(alignment,v)]});
   }else if(c.kind==='slider'){
    // Slider: lock all relative orientation and both translations transverse
    // to its axis, leaving ONLY signed travel along the axis free.
    const restA=this.bodies.get(c.a.body)!.rest,restB=this.bodies.get(c.b.body)!.rest;
    const expectedQ=qmul(qmul(a.q,qconj(restA.q)),restB.q);
    const diff=sub(pb,pa);
    parts.push({id:c.id,values:[dot(diff,u),dot(diff,v),
      ...mul(orientationError(b.q,expectedQ),ORIENTATION_LDU)]});
   }else if(c.kind==='cylindrical'){
    // Axial translation AND shaft rotation remain free: four constraints.
    const diff=sub(pb,pa), alignment=cross(aa,bb);
    parts.push({id:c.id,values:[dot(diff,u),dot(diff,v),
      ORIENTATION_LDU*dot(alignment,u),ORIENTATION_LDU*dot(alignment,v)]});
   }else if(c.kind==='universal'){
    // Hooke cross: coincident centres and two shaft axes at right angles.
    parts.push({id:c.id,values:[...sub(pb,pa),ORIENTATION_LDU*dot(aa,bb)]});
   }else{
    // Planar contact: two translations and normal rotation remain free.
    const ra=this.bodies.get(c.a.body)!.rest,rb=this.bodies.get(c.b.body)!.rest;
    const restAxis=unit(rotate(ra.q,unit(c.axisA)));
    const gapAtRest=dot(sub(worldPoint(rb,c.b.local),worldPoint(ra,c.a.local)),restAxis);
    const alignment=cross(aa,bb);
    parts.push({id:c.id,values:[dot(sub(pb,pa),aa)-gapAtRest,
      ORIENTATION_LDU*dot(alignment,u),ORIENTATION_LDU*dot(alignment,v)]});
   }
   if(c.kind==='hinge'){
    const localRefA=driveRef(c.refA,c.axisA),localRefB=driveRef(c.refB,c.axisB);
    const current=angularDifference(aa,rotate(a.q,localRefA),rotate(b.q,localRefB));
    const ra=this.bodies.get(c.a.body)!.rest,rb=this.bodies.get(c.b.body)!.rest;
    const restAxis=unit(rotate(ra.q,unit(c.axisA)));
    const initial=angularDifference(restAxis,rotate(ra.q,localRefA),rotate(rb.q,localRefB));
    const wrapped=wrap(current-initial);
    const last=this.acceptedPositions.get(c.id)??0;
    jointPositions.set(c.id,wrapped+2*Math.PI*Math.round((last-wrapped)/(2*Math.PI)));
   }else if(c.kind==='slider'){
    const ra=this.bodies.get(c.a.body)!.rest,rb=this.bodies.get(c.b.body)!.rest;
    const initial=dot(sub(worldPoint(rb,c.b.local),worldPoint(ra,c.a.local)),unit(rotate(ra.q,unit(c.axisA))));
    jointPositions.set(c.id,dot(sub(pb,pa),aa)-initial);
   }
   if(drives[c.id]!==undefined){
    const target=drives[c.id];if(!Number.isFinite(target))throw Error(`Nonfinite motor target ${c.id}`);
    if(c.kind==='hinge'){
     parts.push({id:`drive:${c.id}`,values:[ORIENTATION_LDU*(jointPositions.get(c.id)!-target)]});
    }else{
     parts.push({id:`drive:${c.id}`,values:[jointPositions.get(c.id)!-target]});
    }
   }
  }
  const angle=(id:string)=>jointPositions.get(id)!;
  const relation=(m:SpatialMechanic,value:number,rotational:boolean)=>{
   // Convert radians to the same characteristic length scale as the other
   // spatial constraints. Extremely high ratios are normalized to avoid
   // allowing one relation to overpower an entire linkage.
   const scale=rotational?ORIENTATION_LDU:1;
   parts.push({id:`mechanic:${m.id}`,values:[scale*value]});
  };
  for(const m of this.model.mechanics??[]){
   switch(m.kind){
    case 'gear':{
     const factor=(m.internal?1:-1)*m.inputTeeth/m.outputTeeth;
     relation(m,(angle(m.output)-factor*angle(m.input))/Math.max(1,Math.abs(factor)),true);break;
    }
    case 'bevel-gear':{
     const factor=(m.reversed?-1:1)*m.inputTeeth/m.outputTeeth;
     relation(m,(angle(m.output)-factor*angle(m.input))/Math.max(1,Math.abs(factor)),true);break;
    }
    case 'belt':case 'chain':{
     const factor=(m.kind==='belt'&&m.crossed?-1:1)*m.inputTeeth/m.outputTeeth;
     relation(m,(angle(m.output)-factor*angle(m.input))/Math.max(1,Math.abs(factor)),true);break;
    }
    case 'worm':{
     const factor=(m.reversed?-1:1)*m.starts/m.wheelTeeth;
     relation(m,angle(m.output)-factor*angle(m.input),true);break;
    }
    case 'cv-joint':
     relation(m,angle(m.output)-(m.reversed?-1:1)*angle(m.input),true);break;
    case 'clutch':
     if(m.engaged)relation(m,angle(m.output)-(m.reversed?-1:1)*angle(m.input),true);
     break;
    case 'universal-drive':{
     const input=angle(m.input),c=Math.cos(m.bendAngleRad);
     const expected=Math.atan2(c*Math.sin(input),Math.cos(input));
     // Unwrap the Cardan shaft relative to the INPUT revolution count, not
     // merely to the last output. The latter can snap to the wrong pi-branch
     // after crossing quadrants. atan2 gives a principal angle; the nearest
     // full revolution of the input defines the physically continuous branch.
     const continuous=expected+2*Math.PI*Math.round((input-expected)/(2*Math.PI));
     relation(m,angle(m.output)-(m.reversed?-1:1)*continuous,true);break;
    }
    case 'rack-pinion':
     relation(m,angle(m.linear)-(m.reversed?-1:1)*m.pitchRadiusLdu*angle(m.rotary),false);break;
    case 'wheel-rolling':
     // An authored rolling wheel is constrained to its chassis's single
     // translation coordinate. This enforces no-slip distance only; it does
     // NOT detect tire-ground contact, steering, scrubbing or load.
     relation(m,angle(m.linear)-(m.reversed?-1:1)*m.wheelRadiusLdu*angle(m.rotary),false);break;
    case 'screw':
     relation(m,angle(m.linear)-(m.reversed?-1:1)*m.leadLduPerTurn/(2*Math.PI)*angle(m.rotary),false);break;
    case 'winch':
     relation(m,angle(m.linear)-(m.reversed?-1:1)*m.drumRadiusLdu/m.supportedSegments*angle(m.rotary),false);break;
    case 'differential':
     relation(m,(angle(m.left)+angle(m.right)-2*angle(m.carrier))/2,true);break;
    case 'ackermann-steering':{
     // Ideal tangent-turning-wheel geometry. The steering input is the angle
     // of the hypothetical centre wheel; positive means the left wheel is
     // the inside wheel. This is NOT a rack/tie-rod or tyre contact solver.
     const steer=angle(m.input),sin=Math.sin(steer),cos=Math.cos(steer);
     const numer=m.wheelbaseLdu*sin,halfTrack=m.trackWidthLdu/2;
     const left=Math.atan2(numer,m.wheelbaseLdu*cos-halfTrack*sin);
     const right=Math.atan2(numer,m.wheelbaseLdu*cos+halfTrack*sin);
     parts.push({id:`mechanic:${m.id}:left`,values:[ORIENTATION_LDU*wrap(angle(m.left)-left)]});
     parts.push({id:`mechanic:${m.id}:right`,values:[ORIENTATION_LDU*wrap(angle(m.right)-right)]});
     break;
    }
    case 'planetary':
     relation(m,(m.sunTeeth*angle(m.sun)+m.ringTeeth*angle(m.ring)-
       (m.sunTeeth+m.ringTeeth)*angle(m.carrier))/(m.sunTeeth+m.ringTeeth),true);break;
    case 'cam-follower':{
     const phase=m.phaseRad??0,t=m.lobes*angle(m.cam);
     const displacement=m.liftLdu/2*(Math.cos(phase)-Math.cos(t+phase));
     relation(m,angle(m.follower)-(m.reversed?-1:1)*displacement,false);break;
    }
    case 'stop':{
     const q=angle(m.joint),error=q<m.min?q-m.min:q>m.max?q-m.max:0;
     relation(m,error,this.isHinge(m.joint));break;
    }
    case 'brake':
     if(m.engaged)relation(m,angle(m.joint),this.isHinge(m.joint));
     break;
    case 'ratchet':{
     if(m.engaged===false)break;
     const q=angle(m.joint),stop=this.ratchetStops.get(m.id)??0;
     const error=m.direction==='positive'?Math.min(0,q-stop):Math.max(0,q-stop);
     relation(m,error,this.isHinge(m.joint));break;
    }
    case 'slider-crank':
     relation(m,angle(m.slider)-(m.reversed?-1:1)*sliderCrankTravel(angle(m.crank),
       m.crankRadiusLdu,m.rodLengthLdu,m.guideOffsetLdu??0),false);break;
    case 'scotch-yoke':
     relation(m,angle(m.slider)-(m.reversed?-1:1)*scotchYokeTravel(angle(m.crank),
       m.radiusLdu,m.phaseRad??0),false);break;
    case 'linear-coupler':
     relation(m,angle(m.output)-m.ratio*angle(m.input),false);break;
    case 'hydraulic-pair':
     relation(m,(m.areaFirst*angle(m.first)+m.areaSecond*angle(m.second))/
       Math.max(m.areaFirst,m.areaSecond),false);break;
    case 'backlash-gear':{
     const factor=(m.internal?1:-1)*m.inputTeeth/m.outputTeeth;
     const error=angle(m.output)-factor*angle(m.input);
     relation(m,Math.sign(error)*Math.max(0,Math.abs(error)-m.clearanceRad),true);
     // This is pose-continuation, not static friction: leave an un-driven
     // output near its last accepted position inside the tooth clearance.
     // Hold is weak and releases at driven tooth flank engagement.
     const old=this.acceptedPositions.get(m.output)??0;
     const inGap=Math.abs(error)<=m.clearanceRad+1e-5;
     parts.push({id:`mechanic:${m.id}:continuation`,values:[
      inGap&&drives[m.output]===undefined?ORIENTATION_LDU*.12*(angle(m.output)-old):0]});
     break;
    }
    case 'detent':{
     // An indexed selector chooses its nearest discrete target from the
     // command (or the last accepted pose), not from the trial variable.
     // Recomputing the target from every trial pose creates discontinuous
     // Jacobians at half-steps and can trap an otherwise valid exact click.
     if(m.engaged){
      const desired=drives[m.joint]??this.acceptedPositions.get(m.joint)??0;
      const index=m.pitch*Math.round(desired/m.pitch);
      relation(m,angle(m.joint)-index,this.isHinge(m.joint));
     }
     break;
    }
    case 'cam-profile':
     relation(m,angle(m.follower)-(m.reversed?-1:1)*camProfileTravel(angle(m.cam),
       m.profileLdu,m.phaseRad??0,m.lobes??1),false);break;
    case 'intermittent-indexer':
     relation(m,angle(m.output)-(m.reversed?-1:1)*intermittentIndexTravel(angle(m.input),
       m.slots,m.activeFraction,m.phaseRad??0),true);break;
    case 'differential-drive':{
     const motion=differentialDriveTravel(angle(m.left),angle(m.right),m.wheelRadiusLdu,m.trackWidthLdu);
     parts.push({id:`mechanic:${m.id}:forward`,values:[angle(m.forward)-motion.forward]});
     parts.push({id:`mechanic:${m.id}:yaw`,values:[ORIENTATION_LDU*(angle(m.yaw)-motion.yaw)]});
     break;
    }
   }
  }
  return {poses,jointPositions,parts,flat:parts.flatMap(p=>p.values)};
 }
 private isHinge(id:string):boolean{return this.model.constraints.some(c=>c.id===id&&c.kind==='hinge');}
 /** Solve driven hinge angles (unwrapped radians) and/or slider travels (LDU).
  * A failed solution never replaces the last converged pose. Each hinge step
  * must be < pi: a single isolated quaternion cannot determine its winding.
  */
 solve(drives:Readonly<Record<string,number>>,options:{maxIterations?:number;toleranceLdu?:number}={}):SpatialSolution{
  // Only validated engagement switches mirror legacy live-edit behaviour.
  for(const mechanism of this.model.mechanics??[]){
   if(mechanism.kind!=='clutch'&&mechanism.kind!=='brake'&&mechanism.kind!=='ratchet'&&mechanism.kind!=='detent')continue;
   const source=this.engagementSource.mechanics?.find(m=>m.id===mechanism.id&&m.kind===mechanism.kind);
   if(source&&'engaged' in source&&typeof source.engaged==='boolean')mechanism.engaged=source.engaged;
  }
  const joints=new Map(this.model.constraints.map(c=>[c.id,c]));
  for(const [id,v]of Object.entries(drives)){
   const c=joints.get(id);
   if(!c||(c.kind!=='hinge'&&c.kind!=='slider'))throw Error(`Motor ${id} needs a defined hinge or slider`);
   const last=this.acceptedPositions.get(id)??0;
   if(!Number.isFinite(v)||(c.kind==='hinge'&&(
     Math.abs(v)>256*Math.PI||Math.abs(v-last)>=Math.PI-.001)))
     throw Error(`Motor ${id}: invalid position or rotation jump >= pi. Advance unwrapped motor angles in smaller steps.`);
  }
  const tolerance=options.toleranceLdu??.04,maxIterations=options.maxIterations??65;
  if(!Number.isFinite(tolerance)||!(tolerance>0&&tolerance<=.5))throw Error('Invalid spatial-solver tolerance');
  if(!Number.isSafeInteger(maxIterations)||maxIterations<1||maxIterations>150)
   throw Error('Spatial-solver maxIterations must be an integer from 1 to 150');
  let state=[...this.state],evaluation=this.measure(state,drives);
  // Continuation preference is NOT a physical force. It selects the solution
  // closest to the last accepted state when a clutch/backlash introduces free
  // motion, reducing arbitrary jumps in rank-deficient configurations.
  const previous=[...this.state],continuationWeight=.002;
  const norm2=(xs:readonly number[])=>xs.reduce((v,x)=>v+x*x,0);
  const objective=(state:readonly number[],flat:readonly number[])=>
   [...flat,...state.map((x,i)=>continuationWeight*(x-previous[i]))];
  let residual=objective(state,evaluation.flat),err=norm2(residual),iteration=0,lambda=.2;
  const gradient=(x:readonly number[],r:readonly number[],mobility=false)=>{
   const columns:number[][]=[];
   for(let i=0;i<x.length;i++){
    const candidate=[...x],h=i%6<3?1e-4:1e-5;candidate[i]+=h;
    const raw=this.measure(candidate,drives).flat;
    const values=mobility?raw:objective(candidate,raw);
    columns.push(values.map((val,j)=>(val-r[j])/h));
   }
   return columns;
  };
  for(;iteration<maxIterations;iteration++){
   if(Math.sqrt(norm2(evaluation.flat))<tolerance)break;
   const jac=gradient(state,residual),n=state.length;
   const rhs=Array(n).fill(0).map((_,i)=>-dotArray(jac[i],residual));
   const gram=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>dotArray(jac[i],jac[j])));
   let improved=false;
   for(let trial=0;trial<9;trial++){
    const M=gram.map((row,i)=>row.map((v,j)=>v+(i===j?lambda*lambda:0)));
    const step=linearSolve(M,rhs);
    if(!step)break;
    const candidate=state.map((x,i)=>x+Math.max(i%6<3?-6:-.3,Math.min(i%6<3?6:.3,step[i])));
    const test=this.measure(candidate,drives),trial=objective(candidate,test.flat),next=norm2(trial);
    if(Number.isFinite(next)&&next<err-1e-12){state=candidate;evaluation=test;residual=trial;err=next;
      lambda=Math.max(.003,lambda*.45);improved=true;break;
    }
    lambda*=4;
   }
   if(!improved)break;
  }
  const byConstraint=new Map(evaluation.parts.map(p=>[p.id,magOf(p)]));
  const max=Math.max(0,...byConstraint.values()),ok=max<=tolerance;
  const cols=gradient(state,evaluation.flat,true);
  const dof=Math.max(0,state.length-numericalRank(cols));
  if(ok){
   this.state=state;
   for(const [id,position]of evaluation.jointPositions)this.acceptedPositions.set(id,position);
   for(const m of this.model.mechanics??[])if(m.kind==='ratchet'&&m.engaged!==false){
    const value=evaluation.jointPositions.get(m.joint)!;
    const last=this.ratchetStops.get(m.id)??0;
    this.ratchetStops.set(m.id,m.direction==='positive'?Math.max(last,value):Math.min(last,value));
   }
  }
  const worst=[...byConstraint].sort((a,b)=>b[1]-a[1])[0]?.[0];
  // Never expose a rejected trial configuration as the rendered/accepted pose.
  // Residuals still describe the rejected trial for actionable diagnostics.
  const visible=ok?evaluation:this.measure(this.state,{});
  return {poses:visible.poses,jointPositions:visible.jointPositions,status:ok?'converged':'failed',iterations:iteration,
    maxResidualLdu:max,residualByConstraint:byConstraint,estimatedFreeDof:dof,
    ...(!ok?{warning:`Spatial constraints cannot close${worst?` (${worst})`:''}: max residual ${max.toFixed(4)} scaled LDU. Check joint stops, one-way pawls and incompatible drives. Last valid pose is preserved.`}:{}),
  };
 }
 reset():void{this.state.fill(0);this.ratchetStops.clear();this.acceptedPositions.clear();}
}
const dotArray=(a:readonly number[],b:readonly number[]):number=>a.reduce((s,v,i)=>s+v*b[i],0);
const magOf=(x:{values:readonly number[]})=>Math.hypot(...x.values);
