import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { MechanicalJoint } from '../../src/anim/construction/mechanicalConstraintGraph';
import type { Assembly, Metrics } from '../../src/model/assemble';
import type { Box } from '../../src/ldraw/flatten';
import type { Move, Timeline } from '../../src/anim/timeline';
import { flightPose } from '../../src/anim/timeline';
import { decodeTimeline, encodeTimeline } from '../../src/anim/timelineCodec';
import { mechanicalApproaches } from '../../src/anim/motion/kinematicCandidates';
import { buildMotionMechanismGraph } from '../../src/anim/motion/v4/mechanismGraph';
import { TimedMeshCertifier, revoluteEnvelope } from '../../src/anim/motion/v4/meshCertifier';
import { constrainJointCandidate, matchingLimit, validJointLimit, validateJointLimitRules } from '../../src/anim/motion/v4/jointLimits';

const at = (x=0, y=0, z=0) => new THREE.Matrix4().makeTranslation(x,y,z);
const cube = (lo:[number,number,number],hi:[number,number,number]):Float32Array => {
  const v:number[][]=[];
  for(const x of [lo[0],hi[0]])for(const y of [lo[1],hi[1]])for(const z of [lo[2],hi[2]])v.push([x,y,z]);
  const f=[[0,2,3,1],[4,5,7,6],[0,1,5,4],[2,6,7,3],[0,4,6,2],[1,3,7,5]];
  return new Float32Array(f.flatMap(([a,b,c,d])=>[...v[a],...v[b],...v[c],...v[a],...v[c],...v[d]]));
};
const box=(half=.5):Box=>({min:[-half,-half,-half],max:[half,half,half]});
const metrics=(missing:string[]=[]):Metrics=>id=>({id,body:box(),full:box(),placeholder:missing.includes(id),
  mesh:missing.includes(id)?undefined:cube([-0.5,-0.5,-0.5],[0.5,0.5,0.5]),
  footprint:{w:1,d:1},heightPlates:1});
const asm=(names:string[]):Assembly=>({instances:names.map(key=>({key,part:key})),nodes:[],problems:[],bounds:null} as unknown as Assembly);
const joint=(type:MechanicalJoint['type'],motion:MechanicalJoint['motion'], id='joint:1',axis:[number,number,number]=[0,0,1]):MechanicalJoint=>
  ({id,male:'moving',female:'host',type,motion,axis,centre:[0,0,0],engagement:12});
const move=(from:THREE.Matrix4,to:THREE.Matrix4,unit=0):Move=>({unit,from,to,rel:null,skyY:-30,hold:0,
  entry:[0,0,0],posePath:[from,to]});
const scene=(pieces:{key:string;floor:THREE.Matrix4;final:THREE.Matrix4;start?:number;end?:number;
  move?:Move;appear?:number}[]):Timeline=>{
  const units=pieces.filter(p=>p.move).map(p=>({kind:'piece',keys:[p.key],start:p.start??0,dur:(p.end??1)-(p.start??0),step:0}));
  // Each move explicitly references its generated unit's index.
  const tracks=new Map(pieces.map(p=>{
    const u=p.move?units.findIndex(unit=>unit.keys[0]===p.key):-1;
    return [p.key,{appear:p.appear??-1,ctx:0,floor:p.floor,final:p.final,floorBox:box(),
      moves:p.move?[{...p.move,unit:u}]:[]}];
  }));
  return {units,tracks,duration:Math.max(...units.map(u=>u.start+u.dur),1)} as unknown as Timeline;
};

describe('Standard Motion v4 — phases 1–3',()=>{
  it('builds fixed components and rejects a hinge locked by a second installed constraint',()=>{
    const a=asm(['moving','host','fixed','unknown']);
    const hinge=joint('hinge','revolute');
    const weld:MechanicalJoint={...joint('stud-socket','fixed','weld'),male:'moving',female:'fixed'};
    const graph=buildMotionMechanismGraph(a,[hinge,weld]);
    expect(graph.edges).toHaveLength(2);
    expect(graph.uncertainBodies).toEqual(['unknown']);
    expect(graph.rigidClusters.find(group=>group.includes('moving'))).toEqual(['fixed','moving']);
    expect(graph.isMate('moving','host')).toBe(true);
    expect(graph.mobility('moving','host',new Set(['host','fixed']),'revolute').allowed).toBe(false);
    expect(graph.mobility('moving','host',new Set(['host']),'revolute').allowed).toBe(true);
  });

  it('rejects inferred joint stops, invalid assembled zero and the wrong keyed joint',()=>{
    const valid={moving:'moving',host:'host',kind:'revolute' as const,min:-Math.PI/4,max:0,source:'user' as const};
    expect(validJointLimit(valid)).toBe(true);
    expect(validJointLimit({...valid,min:0.1})).toBe(false);
    expect(validateJointLimitRules([valid,{...valid,max:1}])).toHaveLength(1);
    expect(matchingLimit([valid],'moving','wrong',
      {a:'moving',b:'host',type:'hinge'} as never,'revolute')).toBeUndefined();
  });

  it('honors signed limits via forward kinematics without changing the assembled endpoint',()=>{
    const m=move(at(-90,-50),at(40));
    const candidate=mechanicalApproaches(m,joint('hinge','revolute'),'moving')[0];
    const initial=-candidate.kinematicSegments!.reduce((sum,s)=>sum+s.travel,0);
    const allowed={moving:'moving',host:'host',kind:'revolute' as const,
      min:Math.min(-Math.PI/5,0),max:Math.max(Math.PI/5,0),source:'user' as const};
    const rule=initial<0?{...allowed,max:0}:{...allowed,min:0};
    const result=constrainJointCandidate(candidate,rule);
    expect(result.status).toBe('adjusted');
    expect(result.candidate!.poses.at(-1)!.elements).toEqual(candidate.poses.at(-1)!.elements);
    const open=-result.candidate!.kinematicSegments!.reduce((sum,s)=>sum+s.travel,0);
    expect(open).toBeCloseTo(initial<0?rule.min:rule.max,6);
    const revised={...m,posePath:result.candidate!.poses,kinematicSegments:result.candidate!.kinematicSegments};
    for(const seg of revised.kinematicSegments!)for(const t of [.0,.2,.5,.9,1]){
      const actual=flightPose(revised,
        (seg.index+t)/(revised.posePath!.length-1),new THREE.Matrix4());
      actual.elements.forEach((n:number)=>expect(Number.isFinite(n)).toBe(true));
    }
    expect(constrainJointCandidate(candidate,{...rule,min:0,max:0}).status).toBe('violated');
  });

  it('encloses the ENTIRE hinge arc, not only its endpoints',()=>{
    const bounds:Box={min:[-0.1,-0.1,-0.1],max:[0.1,0.1,0.1]};
    const box=revoluteEnvelope(bounds,at(3),[0,0,0],[0,0,1],Math.PI/2);
    for(const t of [0,.01,.23,.5,.71,.91,1]){
      const a=t*Math.PI/2,pt=[3*Math.cos(a),3*Math.sin(a),0];
      for(let k=0;k<3;k++)expect(pt[k]>=box.min[k]&&pt[k]<=box.max[k]).toBe(true);
    }
  });

  it('certifies an isolated continuous translation and detects thin-wall tunneling',()=>{
    const shapes=metrics();const graph=buildMotionMechanismGraph(asm(['moving','wall']),[]);
    const from=at(-7),to=at(7),m=move(from,to);
    const blocked=scene([{key:'moving',floor:from,final:to,move:m},
      {key:'wall',floor:at(0),final:at(0)}]);
    const cert=new TimedMeshCertifier(asm(['moving','wall']),blocked,shapes,graph,{maxDepth:10});
    expect(cert.verify('moving',blocked.tracks.get('moving')!.moves[0]).status).toBe('blocked');
    const clear=scene([{key:'moving',floor:from,final:to,move:m},
      {key:'wall',floor:at(0,10),final:at(0,10)}]);
    expect(new TimedMeshCertifier(asm(['moving','wall']),clear,shapes,graph)
      .verify('moving',clear.tracks.get('moving')!.moves[0]).status).toBe('clear');
  });

  it('never treats a missing obstacle mesh as a proof of clearance',()=>{
    const from=at(-10),to=at(10),m=move(from,to),a=asm(['moving','missing']);
    const tl=scene([{key:'moving',floor:from,final:to,move:m},
      {key:'missing',floor:at(1000),final:at(1000)}]);
    const outcome=new TimedMeshCertifier(a,tl,metrics(['missing']),buildMotionMechanismGraph(a,[]))
      .verify('moving',tl.tracks.get('moving')!.moves[0]);
    expect(outcome.status).toBe('unverified');
    expect(outcome.blockers).toContain('missing');
  });

  it('accounts for already-staged pieces even if their final position is elsewhere',()=>{
    const from=at(-7),to=at(7),m=move(from,to),a=asm(['moving','staged']);
    const parked=move(at(0),at(100),1);
    const tl=scene([{key:'moving',floor:from,final:to,move:m},
      {key:'staged',floor:at(0),final:at(100),move:parked,start:5,end:6}]);
    expect(new TimedMeshCertifier(a,tl,metrics(),buildMotionMechanismGraph(a,[]))
      .verify('moving',tl.tracks.get('moving')!.moves[0]).status).toBe('blocked');
  });

  it('never certifies two independently moving pieces that collide at mid-flight',()=>{
    const a=asm(['moving','opposite']),m=move(at(-5),at(5)),o=move(at(5),at(-5));
    const tl=scene([{key:'moving',floor:m.from,final:m.to,move:m},
      {key:'opposite',floor:o.from,final:o.to,move:o}]);
    const result=new TimedMeshCertifier(a,tl,metrics(),buildMotionMechanismGraph(a,[]))
      .verify('moving',tl.tracks.get('moving')!.moves[0]);
    expect(result.status).toBe('blocked');
  });

  it('detects a pivot with non-zero world translation, and preserves v4 status in codec',()=>{
    const origin=[198,0,0] as [number,number,number], start=at(200),
      dest=at(198,2).multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(0,0,1),Math.PI/2));
    const m:Move={...move(start,dest),kinematicSegments:[{index:0,kind:'revolute',axis:[0,0,1],pivot:origin,travel:Math.PI/2}]};
    const a=asm(['moving','obstacle']);
    const tl=scene([{key:'moving',floor:start,final:dest,move:m},
      {key:'obstacle',floor:at(199.4,1.4),final:at(199.4,1.4)}]);
    tl.motion={engine:'standard-motion-v4',parts:2,articulated:1,review:1,
      v4:{version:1,phases:[1,2,3],graph:{edges:0,rigidClusters:2,constrainedBodies:0,unknownBodies:2},
        mesh:{certified:0,blocked:1,unverified:0,exactChecks:3,candidateChecks:1,pairsExamined:1,rerouted:0},
        limits:{rules:0,matches:0,checked:0,adjusted:0,rejected:0,conflicts:0,unspecified:0}}};
    const cert=new TimedMeshCertifier(a,tl,metrics(),buildMotionMechanismGraph(a,[]));
    expect(cert.verify('moving',tl.tracks.get('moving')!.moves[0]).status).not.toBe('clear');
    const round=decodeTimeline(encodeTimeline(tl));
    expect(round.motion?.v4?.phases).toEqual([1,2,3]);
    expect(round.tracks.get('moving')!.moves[0].kinematicSegments).toEqual(m.kinematicSegments);
  });
});
