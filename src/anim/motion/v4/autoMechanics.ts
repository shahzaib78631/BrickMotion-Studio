/** Automatic, evidence-labelled mechanical detection from LDraw part headers
 * and LDCad Shadow connector pairs. No part's angular stops, mass, bearing
 * clearances or gear engagement are silently promoted to verified physics.
 *
 * Suggestions use exact assembled INSTANCE KEYS and are opt-in; they are never
 * automatically applied to the finished model. Users may edit their programs
 * or keep the original v4 animation completely unchanged.
 */
import * as THREE from 'three';
import type { Assembly, Metrics, Instance } from '../../../model/assemble';
import type { MechanicalJoint } from '../../construction/mechanicalConstraintGraph';
import type { MechanismGraph, MechanismEdge } from './mechanismGraph';
import type { MechanismProgram, GearPair, JointDrive, Vec3 } from './mechanismProgram';
import { validateMechanismProgram } from './mechanismProgram';
import { bodyGraph, carriedBodies, type BodyGraph } from './bodyGraph';
import { MechanismSolver } from './mechanismSolver';

export type PartCategory = 'gear'|'turntable'|'hinge'|'axle'|'pin'|'shaft'|'wheel'|'other';
export type DetectedPart = {
  key:string; part:string; category:PartCategory; description:string;
  evidence:'ldraw-description'|'ldcad-connector'|'unknown';
  teeth?:number; axis?:Vec3; pivot?:Vec3;
};
export type DetectedJoint = { a:string;b:string;motion:'revolute'|'prismatic'|'fixed'|'ball';
  kind:string; centre:Vec3; axis:Vec3; evidence:'ldcad-shadow'|'turntable-inferred' };
export type DetectedGearMesh = { a:string;b:string;teethA:number;teethB:number;
  moduleLdu:number; evidence:'inferred-pitch'; confidence:'review-required' };
export type SuggestedMechanism = {
  title:string; program:MechanismProgram;
  evidence:'ldcad-shadow'|'inferred-gear-mesh'|'measured-gear-train'|'classified';
  warnings:string[];
  /** The named mechanism this suggestion runs (classify/patterns.ts). */
  mechanism?:{kind:string;name:string};
};
/** Review-only functional hypotheses, never used as physical mates or
 * auto-render programs without a user explicitly selecting the parts. */
export type FunctionalHint = {
  id:string;kind:'worm'|'rack-pinion'|'belt'|'chain';a:string;b:string;
  distanceLdu:number; evidence:'part-description-proximity';
  warning:string;
};
export type AutoMechanicsReport = {
  scanned:number; described:number; connectors:number; movableJoints:number;
  kinds:Record<PartCategory,number>;
  /** Complete per-instance inspection for the guided transmission designer. */
  parts:DetectedPart[];
  joints:DetectedJoint[]; gearMeshes:DetectedGearMesh[];
  functionalHints:FunctionalHint[];
  suggestions:SuggestedMechanism[];
  warnings:string[];
};
const canonical=(s:string)=>s.toLowerCase().replace(/\\/g,'/').split('/').at(-1)?.replace(/\.dat$/,'')??'';
const catalogueTurntable=(a:string,b:string)=>{
  const pair=[canonical(a),canonical(b)].sort().join(':');
  return pair==='3403:3404'; // 4x4 base/top, explicitly named turntable pair
};
const v=(p:readonly number[]):Vec3=>[p[0],p[1],p[2]];
const xyz=(m:THREE.Matrix4):Vec3=>[m.elements[12],m.elements[13],m.elements[14]];
const norm=(p:Vec3)=>Math.hypot(...p);
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const scale=(a:Vec3,n:number):Vec3=>[a[0]*n,a[1]*n,a[2]*n];
const unit=(a:Vec3):Vec3=>scale(a,1/(norm(a)||1));
const boxCentre=(b:{min:Vec3;max:Vec3}):Vec3=>v([0,1,2].map(i=>(b.min[i]+b.max[i])/2));
const transformed=(m:THREE.Matrix4,p:Vec3):Vec3=>v(new THREE.Vector3(...p).applyMatrix4(m).toArray());
const oriented=(m:THREE.Matrix4,axis:Vec3):Vec3=>{
  const e=m.elements;
  return unit([e[0]*axis[0]+e[4]*axis[1]+e[8]*axis[2],
    e[1]*axis[0]+e[5]*axis[1]+e[9]*axis[2],
    e[2]*axis[0]+e[6]*axis[1]+e[10]*axis[2]]);
};
function classify(description:string,part:string,snaps:NonNullable<ReturnType<Metrics>['snaps']>):PartCategory {
  const desc=description.toLowerCase();
  if(/\bgear\b/.test(desc))return 'gear';
  if(/\bturntable\b/.test(desc))return 'turntable';
  if(/\bhinge\b/.test(desc))return 'hinge';
  if(/\b(axle|shaft)\b/.test(desc))return 'axle';
  if(/\bpin\b/.test(desc))return 'pin';
  if(/\b(wheel|tyre|tire)\b/.test(desc))return 'wheel';
  if(snaps.some(s=>s.shapes.includes('A')&&s.gender==='M'))return 'shaft';
  return 'other';
}
/** Header is the only authority used for tooth count. No filename-only guess. */
export function countGearTeeth(description:string):number|null {
  if(!/\bgear\b/i.test(description))return null;
  const m=/\b(\d{1,3})\s*(?:tooth|teeth)\b/i.exec(description) ||
    /\bgear\s+(\d{1,3})\s*t\b/i.exec(description);
  const n=m?Number(m[1]):NaN;
  return Number.isInteger(n)&&n>=4&&n<=200?n:null;
}
function gearAxis(inst:Instance,metrics:Metrics):{pivot:Vec3;axis:Vec3}|null {
  const part=metrics(inst.part);
  // A cross-shaped female axle hole is an axis observation, not by itself a
  // proof that a gear meshes or that an axle spins freely in its bearing.
  const snaps=(part.snaps??[]).filter(s=>s.kind==='cyl'&&s.gender==='F'&&
    s.shapes.includes('A')&&norm(s.axis)>.5);
  if(!snaps.length)return null;
  const origin=boxCentre(part.full);
  const chosen=snaps.sort((a,b)=>b.length-a.length)[0];
  const axis=unit(chosen.axis);
  // A valid axle hole's centre line must cross near the gear's geometric
  // centre. Off-centre gear connector hints are not used for pitch meshes.
  const middle=v([0,1,2].map(i=>chosen.start[i]+chosen.axis[i]*chosen.length/2));
  const shift=sub(origin,middle);
  const radial=sub(shift,scale(axis,dot(shift,axis)));
  const radius=Math.max(1,Math.min(...[0,1,2].map(i=>part.full.max[i]-part.full.min[i])));
  if(norm(radial)>Math.max(1.5,radius*.25))return null;
  return {pivot:transformed(inst.world,middle),axis:oriented(inst.world,axis)};
}
/** Turntable 3403/3404 is known to be rotary, but a matched LDCad coaxial
 * connector and a colocated instance are still required; no broad whitelist. */
export function refineKnownMechanicalJoints(hints:readonly MechanicalJoint[],asm:Assembly):MechanicalJoint[] {
  const parts=new Map(asm.instances.map(i=>[i.key,i]));
  return hints.map(j=>{
    const a=parts.get(j.male),b=parts.get(j.female);
    // A turntable can also have ordinary stud/socket connections. Only a
    // positive-length CYLINDRICAL connection on the central turntable axis
    // may be upgraded: external studs must remain rigid. The metadata does
    // not establish permissible angle stops or physical bearing clearance.
    if(j.motion!=='fixed'||j.type!=='cylindrical'||!a||!b||
      !catalogueTurntable(a.part,b.part)||norm(j.axis)<.9||j.engagement<=0||
      !j.centre.every(Number.isFinite))return j;
    const axis=unit(j.axis);
    for(const part of [a,b]){
      const centre=boxCentre(part.worldBox);
      const offset=sub(centre,j.centre);
      const radial=sub(offset,scale(axis,dot(offset,axis)));
      if(norm(radial)>6)return j;
    }
    return {...j,motion:'revolute'};
  });
}

/** Matches ONLY parallel, axially-overlapping, spur-like gears at the usual
 * 2.5 LDU/tooth module. Pitch is inferred, NEVER an exact mesh certificate. */
function gearPairs(parts:readonly DetectedPart[]):DetectedGearMesh[] {
  const candidates=parts.filter(p=>p.category==='gear' && p.teeth && p.pivot && p.axis &&
    !/\b(bevel|worm|rack|crown)\b/.test(p.description.toLowerCase())).slice(0,200);
  const results:DetectedGearMesh[]=[];
  const grid=new Map<string,DetectedPart[]>(),span=100;
  const cell=(a:Vec3)=>a.map(v=>Math.floor(v/span)).join(':');
  for(const a of candidates) {
    const p=a.pivot!;
    const c=p.map(n=>Math.floor(n/span));
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
      const mates=grid.get(`${c[0]+x}:${c[1]+y}:${c[2]+z}`)??[];
      for(const b of mates){
        const u=a.axis!,w=b.axis!;
        if(Math.abs(dot(u,w))<.99)continue;
        const d=sub(p,b.pivot!),axial=Math.abs(dot(d,u));
        if(axial>12)continue;
        const radial=norm(sub(d,scale(u,dot(d,u))));
        const pitch=2.5*(a.teeth!+b.teeth!)/2;
        if(Math.abs(radial-pitch)>Math.max(1,.04*pitch))continue;
        results.push({a:b.key,b:a.key,teethA:b.teeth!,teethB:a.teeth!,
          moduleLdu:2.5,evidence:'inferred-pitch',confidence:'review-required'});
      }
    }
    const bucket=grid.get(cell(p))??[];bucket.push(a);grid.set(cell(p),bucket);
  }
  return results.slice(0,32);
}
/** Most suggestions offered at once; whole drive trains are added on top by the lab. */
export const MAX_SUGGESTIONS=6;
/** Kinds that are a whole function of the model; the rest are single joints or loops. */
export const WHOLE_FUNCTIONS=new Set(['rack-steering','steering','piston-engine','differential','suspension','linear-actuator','gear-train']);
/** 0: a whole function (steering, an engine, a suspension); 1: a named joint or loop (turntable, four-bar); 2: a plain hinge or gear pair. */
export const suggestionRank=(s:SuggestedMechanism)=>!s.mechanism?2:WHOLE_FUNCTIONS.has(s.mechanism.kind)?0:1;
const leaderOf=(s:SuggestedMechanism)=>s.program.joints.find(x=>x.id===s.program.driver.joint)?.body??'';
const drivenParts=(s:SuggestedMechanism)=>{
  const p=s.program,j=p.joints.find(x=>x.id===p.driver.joint);
  return new Set([j?.body??'',...(p.rigidFollowers??[]).filter(f=>f.leader===j?.body).flatMap(f=>f.bodies)]);
};
/** A drive train assembled from measured meshes leads its rank: it was built for that model's function. */
const measuredFirst=(s:SuggestedMechanism)=>s.evidence==='measured-gear-train'?0:1;
const movingParts=(s:SuggestedMechanism)=>s.program.joints.length+(s.program.rigidFollowers??[]).reduce((n,f)=>n+f.bodies.length,0);
/**
 * Order suggestions for the user: whole functions first, then named joints
 * and loops, then plain hinges; within a rank, the one moving more parts
 * first (a drive train built from measured meshes leads). A suggestion whose
 * driver moves with one already kept, and drives it in turn, or with the
 * same title, is the same mechanism again and is dropped. Whole
 * functions are all kept; the rest fill up to MAX_SUGGESTIONS.
 */
export function rankSuggestions(list:readonly SuggestedMechanism[]):SuggestedMechanism[] {
  const sorted=list.map((s,i)=>({s,i})).sort((x,y)=>suggestionRank(x.s)-suggestionRank(y.s)||measuredFirst(x.s)-measuredFirst(y.s)||movingParts(y.s)-movingParts(x.s)||x.i-y.i).map(x=>x.s);
  const kept:SuggestedMechanism[]=[];
  for(const s of sorted){
    const mine=drivenParts(s),lead=leaderOf(s);
    // The same mechanism again: each one's driver moves with the other's (a hinge riding on a turntable is not).
    if(kept.some(k=>k.title===s.title||mine.has(leaderOf(k))&&drivenParts(k).has(lead)))continue;
    if(suggestionRank(s)>0&&kept.length>=MAX_SUGGESTIONS)continue;
    kept.push(s);
  }
  return kept;
}
const groupOf=(graph:MechanismGraph,key:string)=>graph.rigidClusters.find(g=>g.includes(key))??[key];
/** Propose small connected rigid groups, excluding any that would sever a
 * fixed LDCad connector or propose a driver without a sound connector axis. */
export function provenSuggestion(asm:Assembly,graph:MechanismGraph,p:MechanismProgram):boolean {
  if(validateMechanismProgram(p).length)return false;
  try{
    const solver=new MechanismSolver(asm,p);
    // Walk out to each end of the travel so closed loops follow one branch.
    for(const end of [1,-1]){
      solver.assembled();
      for(let step=1;step<=8;step++)solver.solve(end*p.driver.amplitude*step/8);
    }
    solver.assembled();
    const followers=p.rigidFollowers??[];
    const driven=new Set([...p.joints.map(j=>j.body),...followers.flatMap(f=>f.bodies)]);
    const owner=(key:string)=>followers.find(f=>f.bodies.includes(key))?.leader??(driven.has(key)?key:null);
    for(const e of graph.edges)if(e.motion==='fixed' && (driven.has(e.a)||driven.has(e.b)) && owner(e.a)!==owner(e.b))return false;
    return true;
  }catch{return false;}
}
/** Most parts a hinge or turntable may swing (a whole trailer, a crane boom). */
export const MAX_HINGE_CARRIED=600;
/**
 * Swing everything one side of the joint carries. `move` is the part on the
 * side that turns (the turntable top); otherwise the side carrying fewer
 * parts moves. A side whose carried parts also connect back to the other
 * side is a closed loop or a locked joint, so it is not offered as a hinge.
 */
function hingeCandidate(asm:Assembly,graph:MechanismGraph,bodies:BodyGraph,edge:MechanismEdge,move:string|null):MechanismProgram|null {
  const A=bodies.of(edge.a),B=bodies.of(edge.b);
  if(A===B)return null;
  const side=(key:string)=>{
    const start=bodies.of(key),other=start===A?B:A;
    const carried=carriedBodies(bodies,start,new Set([other]),MAX_HINGE_CARRIED);
    return carried&&!carried.loops.length?{key,carried}:null;
  };
  const options=(move?[move]:[edge.a,edge.b]).map(side).filter(x=>x!==null)
    .sort((x,y)=>x.carried.parts.length-y.carried.parts.length);
  if(!options.length)return null;
  const {key,carried}=options[0];
  const joint:JointDrive={id:'auto-joint-1',body:key,kind:'revolute',axis:v(edge.axis),pivot:v(edge.centre)};
  const follower=carried.parts.filter(x=>x!==key);
  const program:MechanismProgram={mode:'kinematic',duration:3,sampleHz:60,joints:[joint],
    ...(follower.length?{rigidFollowers:[{leader:key,bodies:follower}]}:{}),
    driver:{joint:joint.id,amplitude:.15,cycles:1}};
  return provenSuggestion(asm,graph,program)?program:null;
}
function gearCandidate(asm:Assembly,graph:MechanismGraph,pair:DetectedGearMesh,
  byKey:ReadonlyMap<string,DetectedPart>):MechanismProgram|null {
  const a=byKey.get(pair.a),b=byKey.get(pair.b);
  if(!a?.pivot||!a.axis||!b?.pivot||!b.axis)return null;
  const first=groupOf(graph,a.key),second=groupOf(graph,b.key);
  if(first.length>24||second.length>24||first.some(key=>second.includes(key)))return null;
  const followers=[
    {leader:a.key,bodies:first.filter(x=>x!==a.key)},
    {leader:b.key,bodies:second.filter(x=>x!==b.key)},
  ].filter(x=>x.bodies.length);
  const program:MechanismProgram={mode:'kinematic',duration:3,sampleHz:60,
    joints:[
      {id:'auto-gear-1',body:a.key,kind:'revolute',axis:v(a.axis),pivot:v(a.pivot)},
      {id:'auto-gear-2',body:b.key,kind:'revolute',axis:v(b.axis),pivot:v(b.pivot)},
    ],
    gears:[{a:'auto-gear-1',b:'auto-gear-2',teethA:pair.teethA,teethB:pair.teethB,
      mesh:'external',moduleLdu:pair.moduleLdu,source:'inferred'}],
    ...(followers.length?{rigidFollowers:followers}:{}),
    driver:{joint:'auto-gear-1',amplitude:.15,cycles:1},
  };
  return provenSuggestion(asm,graph,program)?program:null;
}

/** Lightweight semantic discovery: rank likely families for USER REVIEW.
 * Part names are weak evidence, so these do not create simulated joints.
 * We deliberately do not assume a nearby gear actually meshes a rack/worm.
 */
export function proposeFunctionalHints(parts: readonly DetectedPart[],
  worldCentres: ReadonlyMap<string, Vec3>): FunctionalHint[] {
  const worm=parts.filter(p=>/\bworm\b/i.test(p.description));
  const rack=parts.filter(p=>/\brack\b/i.test(p.description));
  const pulley=parts.filter(p=>/\bpulley\b/i.test(p.description));
  const sprocket=parts.filter(p=>/\bsprocket\b|\bchain wheel\b/i.test(p.description));
  const gear=parts.filter(p=>p.category==='gear'&&p.teeth&&p.axis&&
    !/\bworm|rack|bevel\b/i.test(p.description));
  const found:FunctionalHint[]=[];
  const groups: [FunctionalHint['kind'],readonly DetectedPart[],readonly DetectedPart[]][]=[
    ['worm',worm,gear],['rack-pinion',rack,gear],['belt',pulley,pulley],['chain',sprocket,sprocket],
  ];
  for(const [kind,inputs,outputs] of groups)for(const a of inputs.slice(0,100)){
    let best:{b:DetectedPart;distance:number}|null=null;
    const origin=worldCentres.get(a.key);
    if(!origin)continue;
    for(const b of outputs.slice(0,150)){
      if(a.key===b.key)continue;
      if((kind==='belt'||kind==='chain')&&a.key>b.key)continue; // avoid duplicate pairs
      const dest=worldCentres.get(b.key);if(!dest)continue;
      const distance=norm(sub(origin,dest));
      if(distance>120||best&&distance>=best.distance)continue;
      best={b,distance};
    }
    if(best)found.push({id:`${kind}:${a.key}:${best.b.key}`,kind,
      a:kind==='rack-pinion'?best.b.key:a.key,b:kind==='rack-pinion'?a.key:best.b.key,
      distanceLdu:best.distance,evidence:'part-description-proximity',
      warning:'Review required: nearby part descriptions do not prove bearings, engagement, pitch, motion direction or collision clearance.'});
  }
  return found.sort((a,b)=>a.distanceLdu-b.distanceLdu).slice(0,24);
}

export function detectAutomaticMechanics(asm:Assembly,metrics:Metrics,graph:MechanismGraph):AutoMechanicsReport {
  const count:Record<PartCategory,number>={gear:0,turntable:0,hinge:0,axle:0,pin:0,shaft:0,wheel:0,other:0};
  let described=0,connectors=0;
  const parts:DetectedPart[]=asm.instances.map(i=>{
    const m=metrics(i.part),desc=m.description?.trim()??'',snaps=m.snaps??[];
    if(desc)described++;if(snaps.length)connectors++;
    const category=classify(desc,i.part,snaps);count[category]++;
    // Wheels, sprockets and pulleys also need shaft axes for the V6 geometry
    // screen; an A-profile connector is evidence of an axle, not of rolling.
    const axis=category==='gear'||category==='wheel'||/\b(sprocket|pulley|worm)\b/i.test(desc)?gearAxis(i,metrics):null;
    const teeth=category==='gear'?countGearTeeth(desc):null;
    return {key:i.key,part:i.part,category,description:desc,
      evidence:desc?'ldraw-description':snaps.length?'ldcad-connector':'unknown',
      ...(teeth?{teeth}:{}),...(axis?{axis:axis.axis,pivot:axis.pivot}:{}),
    };
  });
  const byKey=new Map(parts.map(p=>[p.key,p]));
  const functionalHints=proposeFunctionalHints(parts,new Map(asm.instances.map(i=>[i.key,boxCentre(i.worldBox)])));
  const joints:DetectedJoint[]=graph.edges.filter(e=>e.motion!=='fixed' ||
    ['hinge','ball-socket','axle-hole','pin-hole'].includes(e.type)).slice(0,128).map(e=>({
    a:e.a,b:e.b,motion:e.motion==='sliding'?'prismatic':e.motion,
    kind:e.type,centre:v(e.centre),axis:v(e.axis),
    evidence:(catalogueTurntable(byKey.get(e.a)?.part??'',byKey.get(e.b)?.part??'')&&e.motion==='revolute')
      ?'turntable-inferred':'ldcad-shadow',
  }));
  const pairs=gearPairs(parts);
  const warnings:string[]=[];
  const gearParts=parts.filter(p=>p.category==='gear');
  const noAxis=gearParts.filter(p=>!p.axis);
  if(noAxis.length)warnings.push(`${noAxis.length} gear instance(s) have no trustworthy LDCad axle-hole axis; gear engagement was not guessed for them.`);
  if(gearParts.some(p=>!p.teeth))warnings.push('Some LDraw gear descriptions omit tooth counts; they cannot enter automatic ratio coupling.');
  if(gearParts.length>200)warnings.push('Automatic pitch scans are capped at 200 gears; unmatched gears remain unverified.');
  if(pairs.length>=32)warnings.push('Inferred gear-pair list reached the 32-pair cap; other contacts may be missing.');
  if(graph.uncertainBodies.length)warnings.push(`${graph.uncertainBodies.length} instance(s) have no matched joint connection; mobility is not established.`);
  warnings.push('LDraw/Shadow connectors do not establish physical hinge stops, tolerances or part masses. Suggested motions need mesh review.');
  const suggestions:SuggestedMechanism[]=[];
  for(const pair of pairs){
    const program=gearCandidate(asm,graph,pair,byKey);
    if(!program)continue;
    suggestions.push({title:`Meshing gears — ${byKey.get(pair.a)?.part} / ${byKey.get(pair.b)?.part}`,
      program,evidence:'inferred-gear-mesh',warnings:[
        'Pitch engagement and 2.5-LDU tooth module are INFERRED, not a verified gear-contact measurement.',
        'Joint limits and clearance are unknown; review the collision verdict before export.',
      ]});
    if(suggestions.length>=2)break;
  }

  // Turntables first (purpose-built rotation), then gear pairs, then hinges.
  const bodies=bodyGraph(graph);
  const turntables:SuggestedMechanism[]=[],hinges:SuggestedMechanism[]=[];
  const seen=new Set<string>();
  for(const edge of graph.edges){
    if(edge.motion!=='revolute')continue;
    const a=byKey.get(edge.a),b=byKey.get(edge.b);
    const turntable=catalogueTurntable(a?.part??'',b?.part??'');
    if(!turntable&&hinges.length>=MAX_SUGGESTIONS)continue;
    const pair=[bodies.of(edge.a),bodies.of(edge.b)].sort().join('\0');
    if(seen.has(pair))continue;
    seen.add(pair);
    // A turntable's top turns on its base; any other hinge moves its lighter side.
    const move=turntable?(canonical(a?.part??'')==='3404'?edge.a:edge.b):null;
    const p=hingeCandidate(asm,graph,bodies,edge,move);
    if(!p)continue;
    const carried=1+(p.rigidFollowers?.[0]?.bodies.length??0);
    (turntable?turntables:hinges).push({title:`${turntable?'Turntable':'Hinge'} — ${a?.part} / ${b?.part}${carried>1?` (swings ${carried} parts)`:''}`,
      program:p,evidence:'ldcad-shadow',warnings:[
        'Rotation amplitude is a conservative illustration, NOT a measured joint limit.',
        'Review the mesh collision verdict before exporting.',
      ]});
  }
  suggestions.unshift(...turntables);
  suggestions.push(...hinges);
  suggestions.splice(MAX_SUGGESTIONS);
  // Paired gear metadata is surfaced even when an automatic *whole connected*
  // assembly proposal cannot safely be isolated from shafts and bearings.
  return {scanned:parts.length,described,connectors,movableJoints:joints.filter(j=>j.motion!=='fixed').length,kinds:count,parts,joints,gearMeshes:pairs,functionalHints,
    suggestions,warnings:warnings.slice(0,12)};
}
