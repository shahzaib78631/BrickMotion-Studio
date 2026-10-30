/**
 * Spatial rigs: user-authored bodies, joints and mechanism laws (the former
 * v6/v7 spatial solver API), solved by the unified kinematic solver.
 *
 * Each hinge, slider, cylindrical, universal, planar, ball or weld constraint
 * becomes a joint with coordinates; a fixed-length link becomes a distance
 * equation; mechanics become laws and inequalities (laws.ts). Hinge angles
 * and slider travels ARE joint coordinates, so they keep winding past 2 pi
 * without unwrapping heuristics. A failed solve never replaces the last
 * accepted pose. Kinematics only: no forces, contact or dynamics.
 */
import { KinematicSystem, type Equation, type JointSpec, type State } from './system';
import { solve as solveKinematics } from './solve';
import { lawsFromMechanics, type SpatialMechanic } from './laws';
import { apply, compose, quatToR, rToQuat, type Frame } from './rigid';
export type { SpatialMechanic } from './laws';
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
const rotate=(q:Q4,v:V3):V3=>{
 const xyz:V3=[q[0],q[1],q[2]],t=mul(cross(xyz,v),2);
 return add(v,add(mul(t,q[3]),cross(xyz,t)));
};
const worldPoint=(pose:SpatialPose,local:V3)=>add(pose.p,rotate(pose.q,local));
const finitePose=(p:SpatialPose)=>finite3(p?.p)&&Array.isArray(p?.q)&&p.q.length===4&&p.q.every(Number.isFinite);
const ORIENTATION_LDU=20;

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


const restFrame = (pose: SpatialPose): Frame => ({ R: quatToR(pose.q), p: [...pose.p] as V3 });
/** Component of v along a, removed from v (for nearly perpendicular universal axes). */
const orthogonal = (v: V3, a: V3): V3 => unit(sub(v, mul(a, dot(v, a))));

export class SpatialMechanismSolver {
 readonly model: SpatialModel;
 readonly moving: readonly SpatialBody[];
 readonly bodies: ReadonlyMap<string, SpatialBody>;
 /** Legacy V7 rigs toggled brake/clutch/pawl engagement on the caller model.
  * Preserve this narrow behaviour; structural edits remain snapshot-isolated. */
 private readonly engagementSource: SpatialModel;
 private readonly system: KinematicSystem;
 /** Hinge and slider constraints: their coordinates are the joint positions. */
 private readonly kinds = new Map<string, 'hinge' | 'slider'>();
 private state: State;
 /** Pawls remember the most advanced accepted joint position (cleared on reset). */
 private readonly ratchetStops = new Map<string, number>();
 private readonly acceptedPositions = new Map<string, number>();

 constructor(model: SpatialModel) {
  const errors = validateSpatialModel(model);
  if (errors.length) throw Error(errors.join('; '));
  this.engagementSource = model;
  this.model = structuredClone(model);
  this.bodies = new Map(this.model.bodies.map(b => [b.id, b]));
  this.moving = this.model.bodies.filter(b => !b.fixed);
  // A model may be authored off-constraint. Do not silently redefine its rest.
  if (this.model.constraints.some(c => restGap(c, this.bodies) > .05))
   throw Error('Spatial assembly is not closed at rest; fix assembled anchors/axes before solving');
  const owner = (id: string) => (this.bodies.get(id)!.fixed ? null : id);
  const rest = (id: string) => this.bodies.get(id)!.rest;
  const world = (id: string, axis: V3) => unit(rotate(rest(id).q, unit(axis)));
  const joints: JointSpec[] = [], equations: Equation[] = [];
  for (const c of this.model.constraints) {
   if (c.kind === 'hinge' || c.kind === 'slider') this.kinds.set(c.id, c.kind);
   if (c.kind === 'weld') {
    const a = owner(c.a), b = owner(c.b);
    if (a === null && b === null) continue;
    joints.push({ id: c.id, parent: b === null ? b : a, child: (b === null ? a : b)!, kind: 'fixed', point: [0, 0, 0], axis: [0, 0, 1] });
    continue;
   }
   const pa = worldPoint(rest(c.a.body), c.a.local);
   if (c.kind === 'distance') {
    equations.push({ kind: 'distance', id: c.id, a: owner(c.a.body), pa, b: owner(c.b.body), pb: worldPoint(rest(c.b.body), c.b.local), length: c.lengthLdu });
    continue;
   }
   const a = owner(c.a.body), b = owner(c.b.body);
   if (a === null && b === null) continue;
   // The joint's coordinate measures b relative to a. When b is ground the
   // joint is stored from b to a with the axis reversed: same coordinate.
   const reversed = b === null, sign = reversed ? -1 : 1;
   const parent = reversed ? null : a, child = (reversed ? a : b)!;
   if (c.kind === 'ball') { joints.push({ id: c.id, parent, child, kind: 'spherical', point: pa, axis: [0, 0, 1] }); continue; }
   const aa = world(c.a.body, c.axisA), bb = world(c.b.body, c.axisB);
   const kind = ({ hinge: 'revolute', slider: 'prismatic', cylindrical: 'cylindrical', universal: 'universal', planar: 'planar' } as const)[c.kind];
   if (kind === 'universal') joints.push({ id: c.id, parent, child, kind, point: pa, axis: reversed ? bb : aa, axis2: reversed ? orthogonal(aa, bb) : orthogonal(bb, aa) });
   else joints.push({ id: c.id, parent, child, kind, point: pa, axis: mul(aa, sign) });
  }
  // A body held only by equations (a fixed-length link) gets all six freedoms.
  const reached = new Set<string | null>([null]);
  for (let grew = true; grew;) {
   grew = false;
   for (const j of joints) for (const [x, y] of [[j.parent, j.child], [j.child, j.parent]] as const)
    if (reached.has(x) && !reached.has(y)) { reached.add(y); grew = true; }
  }
  for (const b of this.moving) if (!reached.has(b.id)) {
   joints.push({ id: `free:${b.id}`, parent: null, child: b.id, kind: 'free', point: [...b.rest.p] as V3, axis: [0, 0, 1] });
   reached.add(b.id);
  }
  this.system = new KinematicSystem({ bodies: this.moving.map(b => b.id), joints, equations });
  this.state = this.system.zeroState();
 }

 private positions(state: State): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of this.kinds.keys()) out.set(id, this.system.jointOf(id) ? this.system.value(state, id) : 0);
  return out;
 }
 private poses(state: State): Map<string, SpatialPose> {
  const D = this.system.deltas(state), poses = new Map<string, SpatialPose>();
  for (const b of this.model.bodies) {
   const f = b.fixed ? restFrame(b.rest) : compose(D.get(b.id)!, restFrame(b.rest));
   poses.set(b.id, { p: apply({ R: f.R, p: f.p }, [0, 0, 0]), q: rToQuat(f.R) });
  }
  return poses;
 }

 /** Solve driven hinge angles (unwrapped radians) and/or slider travels (LDU).
  * A failed solution never replaces the last converged pose. Each hinge step
  * must be < pi, as in v6 (continuation inside the step is the solver's).
  */
 solve(drives: Readonly<Record<string, number>>, options: { maxIterations?: number; toleranceLdu?: number } = {}): SpatialSolution {
  // Only validated engagement switches mirror legacy live-edit behaviour.
  for (const mechanism of this.model.mechanics ?? []) {
   if (mechanism.kind !== 'clutch' && mechanism.kind !== 'brake' && mechanism.kind !== 'ratchet' && mechanism.kind !== 'detent') continue;
   const source = this.engagementSource.mechanics?.find(m => m.id === mechanism.id && m.kind === mechanism.kind);
   if (source && 'engaged' in source && typeof source.engaged === 'boolean') mechanism.engaged = source.engaged;
  }
  for (const [id, v] of Object.entries(drives)) {
   const kind = this.kinds.get(id);
   if (!kind) throw Error(`Motor ${id} needs a defined hinge or slider`);
   const last = this.acceptedPositions.get(id) ?? 0;
   if (!Number.isFinite(v) || (kind === 'hinge' && (Math.abs(v) > 256 * Math.PI || Math.abs(v - last) >= Math.PI - .001)))
    throw Error(`Motor ${id}: invalid position or rotation jump >= pi. Advance unwrapped motor angles in smaller steps.`);
  }
  const tolerance = options.toleranceLdu ?? .04, maxIterations = options.maxIterations ?? 65;
  if (!Number.isFinite(tolerance) || !(tolerance > 0 && tolerance <= .5)) throw Error('Invalid spatial-solver tolerance');
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 150)
   throw Error('Spatial-solver maxIterations must be an integer from 1 to 150');
  const { laws, inequalities } = lawsFromMechanics(this.model.mechanics ?? [], {
   coordOf: id => id, isHinge: id => this.kinds.get(id) === 'hinge',
   accepted: id => this.acceptedPositions.get(id) ?? 0, drive: id => drives[id], ratchetStop: id => this.ratchetStops.get(id) ?? 0,
  });
  const drivers = new Map(Object.entries(drives).filter(([id]) => this.system.jointOf(id)));
  const result = solveKinematics(this.system, this.state, drivers, { laws, inequalities, tolerance, maxIterations });
  const ok = result.status === 'converged';
  if (ok) {
   this.state = result.state;
   const positions = this.positions(result.state);
   for (const [id, position] of positions) this.acceptedPositions.set(id, position);
   for (const m of this.model.mechanics ?? []) if (m.kind === 'ratchet' && m.engaged !== false) {
    const value = positions.get(m.joint)!, last = this.ratchetStops.get(m.id) ?? 0;
    this.ratchetStops.set(m.id, m.direction === 'positive' ? Math.max(last, value) : Math.min(last, value));
   }
  }
  const byConstraint = new Map<string, number>();
  for (const c of this.model.constraints) byConstraint.set(c.id, result.residuals.get(c.id) ?? 0);
  const mechanicIds = new Set((this.model.mechanics ?? []).map(m => m.id));
  for (const [id, v] of result.residuals) {
   if (mechanicIds.has(id) || mechanicIds.has(id.slice(0, id.lastIndexOf(':')))) byConstraint.set(`mechanic:${id}`, v);
   else if (id.startsWith('drive:')) byConstraint.set(id, v);
  }
  const max = Math.max(0, ...byConstraint.values());
  const worst = [...byConstraint].sort((a, b) => b[1] - a[1])[0]?.[0];
  // Never expose a rejected trial configuration as the rendered/accepted pose.
  const visible = ok ? result.state : this.state;
  return {
   poses: this.poses(visible), jointPositions: this.positions(visible), status: ok ? 'converged' : 'failed',
   iterations: result.iterations, maxResidualLdu: max, residualByConstraint: byConstraint,
   estimatedFreeDof: result.freeDof,
   ...(!ok ? { warning: `Spatial constraints cannot close${worst ? ` (${worst})` : ''}: max residual ${max.toFixed(4)} scaled LDU. ${result.status === 'singular' ? `${result.reason}. ` : ''}Check joint stops, one-way pawls and incompatible drives. Last valid pose is preserved.` } : {}),
  };
 }
 reset(): void { this.state = this.system.zeroState(); this.ratchetStops.clear(); this.acceptedPositions.clear(); }
}

/** How far a constraint is from closed at the authored rest pose (scaled LDU). */
function restGap(c: SpatialConstraint, bodies: ReadonlyMap<string, SpatialBody>): number {
 if (c.kind === 'weld') return 0;
 const A = bodies.get(c.a.body)!.rest, B = bodies.get(c.b.body)!.rest;
 const pa = worldPoint(A, c.a.local), pb = worldPoint(B, c.b.local), d = sub(pb, pa);
 if (c.kind === 'ball') return mag(d);
 if (c.kind === 'distance') return Math.abs(mag(d) - c.lengthLdu);
 const aa = unit(rotate(A.q, unit(c.axisA))), bb = unit(rotate(B.q, unit(c.axisB)));
 const transverse = mag(sub(d, mul(aa, dot(d, aa)))), tilt = ORIENTATION_LDU * mag(cross(aa, bb));
 switch (c.kind) {
  case 'hinge': return Math.hypot(mag(d), tilt);
  case 'slider': return transverse;
  case 'cylindrical': return Math.hypot(transverse, tilt);
  case 'universal': return Math.hypot(mag(d), ORIENTATION_LDU * dot(aa, bb));
  case 'planar': return tilt;
 }
}
