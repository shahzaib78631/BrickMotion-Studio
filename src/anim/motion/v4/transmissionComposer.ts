/** V5 guided network composer: many mechanisms may share the same driven shaft.
 * The program is explicitly user-authored. Only structural consistency and
 * algebraic solvability can be checked; contact and clearance remain unknown.
 */
import type { Assembly } from '../../../model/assemble';
import type { MechanismGraph } from './mechanismGraph';
import type { DetectedPart } from './autoMechanics';
import type { JointDrive, MechanismProgram, TransmissionConstraint, Vec3 } from './mechanismProgram';
import { validateMechanismProgram } from './mechanismProgram';

export type TransmissionDraft = {
  kind: TransmissionConstraint['kind'];
  a: string;
  b: string;
  c?: string;
  /** World-frame fallback orientation if no trustworthy connector axis exists. */
  axis: Vec3;
  teethA?: number;
  teethB?: number;
  starts?: number;
  pitchRadiusLdu?: number;
  leadLduPerTurn?: number;
  /** Explicit direction of chassis motion for an ideal straight-line wheel roll. */
  travelAxis?: Vec3;
  radiusLdu?: number;
  /** V6 detected candidates are never misrepresented as user-verified links. */
  origin?: 'user'|'inferred';
  crossed?: boolean;
  reversed?: boolean;
  engaged?: boolean;
};

const boxCentre=(b:{min:readonly number[];max:readonly number[]}):Vec3 =>
  [0,1,2].map(i=>(b.min[i]+b.max[i])/2) as Vec3;
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const cross=(a:Vec3,b:Vec3):Vec3=>[
  a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0],
];
const length=(a:Vec3)=>Math.hypot(...a);
const normalized=(a:Vec3):Vec3=>{const n=length(a);if(!Number.isFinite(n)||n<1e-8)throw Error('Invalid transmission shaft axis');return [a[0]/n,a[1]/n,a[2]/n];};
const collinear=(a:Vec3,b:Vec3)=>Math.abs(dot(normalized(a),normalized(b)))>=.995;
const slide=(k:TransmissionDraft['kind'])=>k==='rack-pinion'||k==='linear-actuator'||k==='wheel-ground';

/** Assemble one program from up to 64 authored couplings. Each instance key
 * maps to ONE joint, so connected transmission trains reuse their shaft DOF.
 * Independently moving shafts inside the same fixed connector cluster fail.
 */
export function composeTransmissionProgram(assembly:Assembly,graph:MechanismGraph,
  parts:readonly DetectedPart[],couplings:readonly TransmissionDraft[]):MechanismProgram {
  if(!couplings.length||couplings.length>64)throw Error('A network needs 1–64 transmission couplings');
  const instance=new Map(assembly.instances.filter(i=>!i.placeholder).map(i=>[i.key,i]));
  const detections=new Map(parts.map(p=>[p.key,p]));
  const joints:JointDrive[]=[];
  const byPart=new Map<string,JointDrive>();
  const drafted:TransmissionConstraint[]=[];

  const shaft=(key:string,kind:'revolute'|'prismatic',fallback:Vec3,slideAxis?:Vec3):string=>{
    const existing=byPart.get(key);
    if(existing){
      if(existing.kind!==kind)throw Error(`Part ${key} is both a rotating shaft and a sliding rack/actuator`);
      if(!collinear(existing.axis,slideAxis??detections.get(key)?.axis??fallback))
        throw Error(`Part ${key} has incompatible world axes across couplings`);
      return existing.id;
    }
    const placed=instance.get(key);
    if(!placed)throw Error(`Unknown placed part ${key}`);
    const info=detections.get(key);
    const axis=normalized(slideAxis??info?.axis??fallback);
    const pivot=info?.pivot??boxCentre(placed.worldBox);
    const id=`joint-${joints.length+1}`;
    const joint:JointDrive={id,body:key,kind,axis,pivot};
    joints.push(joint);byPart.set(key,joint);
    return id;
  };
  for(const [i,spec]of couplings.entries()){
    if(!spec.a||!spec.b||spec.a===spec.b||
      (spec.kind==='differential'&&(!spec.c||spec.c===spec.a||spec.c===spec.b)))
      throw Error(`Coupling ${i+1}: select distinct real model parts`);
    const fallback=normalized(spec.axis);
    const a=shaft(spec.a,'revolute',fallback);
    let estimatedSlideAxis:Vec3|undefined;
    if(spec.kind==='rack-pinion'){
      // Tangent to the pinion axis in the radial direction toward the rack.
      // This is a geometric estimate, not a guarantee of gear/rack contact.
      const pinion=byPart.get(spec.a)!;
      const rack=instance.get(spec.b);
      if(!rack)throw Error(`Unknown placed part ${spec.b}`);
      const radial=sub(boxCentre(rack.worldBox),pinion.pivot!);
      const direction=cross(pinion.axis,radial);
      if(length(direction)>1e-6)estimatedSlideAxis=normalized(direction);
      else throw Error(`Rack ${spec.b}: cannot infer a tangent translation axis; separate the selected rack and pinion centres`);
    }
    // For an actuator the slide is parallel to its input screw.
    if(spec.kind==='linear-actuator')estimatedSlideAxis=byPart.get(spec.a)!.axis;
    if(spec.kind==='wheel-ground'){
      if(!spec.travelAxis)throw Error('Wheel rolling requires an explicit chassis travel direction');
      estimatedSlideAxis=normalized(spec.travelAxis);
      if(Math.abs(byPart.get(spec.a)!.axis.reduce((sum,n,i)=>sum+n*estimatedSlideAxis![i],0))>.02)
        throw Error('Wheel rotation axis must be perpendicular to chassis travel');
    }
    const b=shaft(spec.b,slide(spec.kind)?'prismatic':'revolute',fallback,estimatedSlideAxis);
    if(spec.kind==='wheel-ground'){
      // Rotate the wheel about its *moving* chassis pivot; otherwise a rolling
      // wheel spins in place while the chassis slides away from it.
      const wheel=byPart.get(spec.a)!;
      const chassis=byPart.get(spec.b)!;
      if(wheel.parent && wheel.parent!==chassis.body)
        throw Error(`Wheel ${spec.a} cannot have two different chassis parents`);
      wheel.parent=chassis.body;
    }
    const common={id:`authored-transmission-${i+1}`,source:spec.origin??'user'};
    let t:TransmissionConstraint;
    switch(spec.kind){
      case 'gear':case 'belt':case 'chain':
        t={...common,kind:spec.kind,a,b,teethA:spec.teethA??12,teethB:spec.teethB??24,
          ...(spec.kind==='belt'?{crossed:spec.crossed??false}:{})};break;
      case 'worm':t={...common,kind:spec.kind,a,b,starts:spec.starts??1,
        wheelTeeth:spec.teethB??24,reversed:spec.reversed??false};break;
      case 'wheel-ground':t={...common,kind:spec.kind,a,b,radiusLdu:spec.radiusLdu??20,
        reversed:spec.reversed??false};break;
      case 'rack-pinion':t={...common,kind:spec.kind,a,b,pitchRadiusLdu:spec.pitchRadiusLdu??20,
        reversed:spec.reversed??false};break;
      case 'linear-actuator':t={...common,kind:spec.kind,a,b,leadLduPerTurn:spec.leadLduPerTurn??8,
        reversed:spec.reversed??false};break;
      case 'differential':t={...common,kind:spec.kind,carrier:a,left:b,right:shaft(spec.c!,'revolute',fallback)};break;
      case 'clutch':t={...common,kind:spec.kind,a,b,engaged:spec.engaged??true,
        reversed:spec.reversed??false};break;
    }
    drafted.push(t);
  }
  if(joints.length>32)throw Error('Maximum 32 independent moving shafts per program');
  const leaders=joints.map(j=>j.body);
  const groups=leaders.map(key=>graph.rigidClusters.find(g=>g.includes(key))??[key]);
  if(groups.some(g=>leaders.filter(key=>g.includes(key)).length>1))
    throw Error('Separate moving shafts belong to the same fixed connector cluster');
  const rigidFollowers=groups.map((g,i)=>({leader:leaders[i],bodies:g.filter(key=>key!==leaders[i])}))
    .filter(x=>x.bodies.length);
  if(rigidFollowers.some(x=>x.bodies.length>32))
    throw Error('A moving shaft has over 32 fixed followers; isolate a smaller mechanism');
  const program:MechanismProgram={mode:'kinematic',duration:3,sampleHz:60,joints,
    ...(rigidFollowers.length?{rigidFollowers}:{}),transmissions:drafted,
    driver:{joint:byPart.get(couplings[0].a)!.id,amplitude:.18,cycles:1}};
  const problems=validateMechanismProgram(program);
  if(problems.length)throw Error(problems.join(' · '));
  return program;
}
