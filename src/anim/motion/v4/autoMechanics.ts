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
  evidence:'ldcad-shadow'|'inferred-gear-mesh';
  warnings:string[];
};
export type AutoMechanicsReport = {
  scanned:number; described:number; connectors:number; movableJoints:number;
  kinds:Record<PartCategory,number>;
  joints:DetectedJoint[]; gearMeshes:DetectedGearMesh[];
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
const groupOf=(graph:MechanismGraph,key:string)=>graph.rigidClusters.find(g=>g.includes(key))??[key];
/** Propose small connected rigid groups, excluding any that would sever a
 * fixed LDCad connector or propose a driver without a sound connector axis. */
function validSuggestion(asm:Assembly,graph:MechanismGraph,p:MechanismProgram):boolean {
  if(validateMechanismProgram(p).length)return false;
  try{
    const solver=new MechanismSolver(asm,p);
    solver.solve(.15);solver.solve(-.15);solver.assembled();
    const followers=p.rigidFollowers??[];
    const driven=new Set([...p.joints.map(j=>j.body),...followers.flatMap(f=>f.bodies)]);
    const owner=(key:string)=>followers.find(f=>f.bodies.includes(key))?.leader??(driven.has(key)?key:null);
    for(const e of graph.edges)if(e.motion==='fixed' && (driven.has(e.a)||driven.has(e.b)) && owner(e.a)!==owner(e.b))return false;
    return true;
  }catch{return false;}
}
function hingeCandidate(asm:Assembly,graph:MechanismGraph,edge:MechanismEdge,move:string):MechanismProgram|null {
  const connected=groupOf(graph,move);
  if(connected.length>24 || connected.includes(edge.a===move?edge.b:edge.a))return null;
  const joint:JointDrive={id:'auto-joint-1',body:move,kind:'revolute',axis:v(edge.axis),pivot:v(edge.centre)};
  const follower=connected.filter(x=>x!==move);
  const program:MechanismProgram={mode:'kinematic',duration:3,sampleHz:60,joints:[joint],
    ...(follower.length?{rigidFollowers:[{leader:move,bodies:follower}]}:{}),
    driver:{joint:joint.id,amplitude:.15,cycles:1}};
  return validSuggestion(asm,graph,program)?program:null;
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
  return validSuggestion(asm,graph,program)?program:null;
}

export function detectAutomaticMechanics(asm:Assembly,metrics:Metrics,graph:MechanismGraph):AutoMechanicsReport {
  const count:Record<PartCategory,number>={gear:0,turntable:0,hinge:0,axle:0,pin:0,shaft:0,wheel:0,other:0};
  let described=0,connectors=0;
  const parts:DetectedPart[]=asm.instances.map(i=>{
    const m=metrics(i.part),desc=m.description?.trim()??'',snaps=m.snaps??[];
    if(desc)described++;if(snaps.length)connectors++;
    const category=classify(desc,i.part,snaps);count[category]++;
    const axis=category==='gear'?gearAxis(i,metrics):null;
    const teeth=category==='gear'?countGearTeeth(desc):null;
    return {key:i.key,part:i.part,category,description:desc,
      evidence:desc?'ldraw-description':snaps.length?'ldcad-connector':'unknown',
      ...(teeth?{teeth}:{}),...(axis?{axis:axis.axis,pivot:axis.pivot}:{}),
    };
  });
  const byKey=new Map(parts.map(p=>[p.key,p]));
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
  const seen=new Set<string>();
  for(const edge of graph.edges){
    if(edge.motion!=='revolute')continue;
    const a=byKey.get(edge.a),b=byKey.get(edge.b);
    // Prefer explicit hinge/turntable tops to rigid structural counterparts.
    const move=catalogueTurntable(a?.part??'',b?.part??'')?
      (canonical(a?.part??'')==='3404'?edge.a:edge.b):edge.a;
    const id=groupOf(graph,move).join('\0');
    if(seen.has(id))continue;
    const p=hingeCandidate(asm,graph,edge,move);
    if(!p)continue;
    seen.add(id);
    suggestions.push({title:`${a?.category==='turntable'||b?.category==='turntable'?'Turntable':'Hinge'} — ${a?.part} / ${b?.part}`,
      program:p,evidence:'ldcad-shadow',warnings:[
        'Rotation amplitude is a conservative illustration, NOT a measured joint limit.',
        'Review the mesh collision verdict before exporting.',
      ]});
    if(suggestions.length>=4)break;
  }
  // Paired gear metadata is surfaced even when an automatic *whole connected*
  // assembly proposal cannot safely be isolated from shafts and bearings.
  return {scanned:parts.length,described,connectors,movableJoints:joints.filter(j=>j.motion!=='fixed').length,kinds:count,joints,gearMeshes:pairs,
    suggestions,warnings:warnings.slice(0,12)};
}
