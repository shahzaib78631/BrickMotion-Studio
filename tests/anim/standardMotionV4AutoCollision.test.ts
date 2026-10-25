/** Standard Motion v4: geometry-continuous mechanism playback and cautious
 * automatic LDraw mechanics inference. The offline harness can exercise these
 * same cases when the complete Vitest dependency tree is unavailable. */
import {describe,expect,it} from 'vitest';
import * as THREE from 'three';
import type {Assembly,Metrics} from '../../src/model/assemble';
import type {MechanismGraph} from '../../src/anim/motion/v4/mechanismGraph';
import type {MechanicalJoint} from '../../src/anim/construction/mechanicalConstraintGraph';
import type {MechanismStage} from '../../src/anim/timelineData';
import {verifyMechanismCollision} from '../../src/anim/motion/v4/mechanismCollision';
import {countGearTeeth,detectAutomaticMechanics,refineKnownMechanicalJoints} from '../../src/anim/motion/v4/autoMechanics';

const bounds={min:[-.45,-.45,-.45] as [number,number,number],max:[.45,.45,.45] as [number,number,number]};
function cube(h=.45):Float32Array {
  const corners=[[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h],[-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h]];
  const quads=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[3,7,6,2],[0,4,7,3],[1,2,6,5]];
  const coords:number[]=[];
  for(const [a,b,c,d] of quads)for(const index of [a,b,c,a,c,d])coords.push(...corners[index]);
  return new Float32Array(coords);
}
const boxMesh=cube();
const at=(x=0,y=0,z=0)=>new THREE.Matrix4().makeTranslation(x,y,z);
const scene=(items:readonly {key:string;part?:string;pos?:[number,number,number]}[]):Assembly=>({
  instances:items.map(({key,part,pos})=>({key,part:part??key,world:at(...(pos??[0,0,0])),worldBox:bounds,placeholder:false})),
  nodes:[],problems:[],bounds:null,
} as unknown as Assembly);
const meshMetrics:Metrics=()=>({full:bounds,body:bounds,placeholder:false,mesh:boxMesh} as ReturnType<Metrics>);
function stage(rows:{key:string;poses:THREE.Matrix4[]}[],duration=1):MechanismStage {
  const frames=rows[0]?.poses.length??2;
  return {start:10,duration,frames,sampleHz:30,mode:'kinematic',collisionStatus:'unverified',
    tracks:rows.map(({key,poses})=>({key,deltas:poses.map(m=>m.elements.slice())})),
    diagnostics:{joints:1,gearPairs:0,loopClosures:0,rigidFollowers:0,maxClosureErrorLdu:0,
      physicsSteps:0,approximateInertias:0,sampledAabbOverlapAdvisories:0}};
}
function graph(edges:MechanismGraph['edges']=[],rigidClusters:string[][]=[]):MechanismGraph {
  return {edges,rigidClusters,uncertainBodies:[],byBody:new Map(),isMate:()=>false,
    mobility:()=>({allowed:false,dof:'fixed',engaged:[],blockers:[]})};
}

describe('Standard Motion v4 — continuous mechanism clearance',()=>{
  it('certifies only a surface envelope that is separated at every intermediate time',()=>{
    const a=scene([{key:'moving'},{key:'parked',pos:[80,0,0]}]);
    const r=verifyMechanismCollision(a,meshMetrics,stage([{key:'moving',poses:[at(),at(6),at()]}]));
    expect(r.status).toBe('clear');expect(r.checkedPairs).toBe(1);expect(r.clearPairs).toBe(1);
  });
  it('catches an obstruction crossed between stored playback keys',()=>{
    const a=scene([{key:'moving'},{key:'parked',pos:[2.5,0,0]}]);
    const r=verifyMechanismCollision(a,meshMetrics,stage([{key:'moving',poses:[at(),at(5),at()]}]));
    expect(r.status).toBe('blocked');expect(r.issues.some(i=>i.b==='parked')).toBe(true);
  });
  it('checks two moving bodies using their synchronized poses',()=>{
    const a=scene([{key:'a',pos:[-2,0,0]},{key:'b',pos:[2,0,0]}]);
    const s=stage([{key:'a',poses:[at(),at(4),at()]},{key:'b',poses:[at(),at(-4),at()]}]);
    const r=verifyMechanismCollision(a,meshMetrics,s);
    expect(r.status).toBe('blocked');expect(r.blockedPairs).toBe(1);
  });
  it('catches quarter-segment tunneling even when midpoint is clear',()=>{
    const a=scene([{key:'m'},{key:'obstacle',pos:[1,0,0]}]);
    const r=verifyMechanismCollision(a,meshMetrics,stage([{key:'m',poses:[at(-3),at(3)]}]));
    expect(r.status).toBe('blocked');
  });
  it('does not trust smaller, stale part bounds over triangle geometry',()=>{
    const a=scene([{key:'m'},{key:'obstacle',pos:[2.5,0,0]}]);
    const wrong:Metrics=()=>({...meshMetrics('m'),full:{min:[-.001,-.001,-.001],max:[.001,.001,.001]}});
    const r=verifyMechanismCollision(a,wrong,stage([{key:'m',poses:[at(),at(5),at()]}]));
    expect(r.status).toBe('blocked');
  });
  it('rejects duplicated animated instance tracks',()=>{
    const a=scene([{key:'m'}]);
    const s=stage([{key:'m',poses:[at(),at(.2)]},{key:'m',poses:[at(),at(.3)]}]);
    expect(verifyMechanismCollision(a,meshMetrics,s).status).toBe('unverified');
  });
  it('reports incomplete or degenerate mesh geometry as unverified',()=>{
    const a=scene([{key:'m'},{key:'obstacle',pos:[90,0,0]}]);
    const one:Metrics=id=>id==='m'?({...meshMetrics(id),mesh:new Float32Array([0,0,0,1,0,0,2,0,0])}):meshMetrics(id);
    const r=verifyMechanismCollision(a,one,stage([{key:'m',poses:[at(),at(5)]}]));
    expect(r.status).toBe('unverified');
    const alone=verifyMechanismCollision(scene([{key:'m'}]),()=>({full:bounds,body:bounds,placeholder:true} as ReturnType<Metrics>),
      stage([{key:'m',poses:[at(),at(5)]}]));
    expect(alone.status).toBe('unverified');
  });
  it('does not promote unresolved assembled contact to certified clearance',()=>{
    const a=scene([{key:'m'},{key:'mate'}]);
    const r=verifyMechanismCollision(a,meshMetrics,stage([{key:'m',poses:[at(),at(.2),at()]}]));
    expect(r.status).toBe('unverified');
  });
  it('fails closed when the verification budget is exhausted',()=>{
    const a=scene([{key:'m'},{key:'near',pos:[1,0,0]}]);
    const r=verifyMechanismCollision(a,meshMetrics,stage([{key:'m',poses:[at(),at(.5),at()]}]),undefined,undefined,{maxNodeTests:0});
    expect(r.status).toBe('unverified');
  });
});

describe('Standard Motion v4 — automatic metadata identification',()=>{
  it('uses real LDraw header tooth counts, never filename guesses',()=>{
    expect(countGearTeeth('Technic Gear  8 Tooth')).toBe(8);
    expect(countGearTeeth('Technic Gear 24 Teeth')).toBe(24);
    expect(countGearTeeth('Technic Gear')).toBeNull();
    expect(countGearTeeth('Brick 1 x 2')).toBeNull();
  });
  it('rejects fake turntable rotation from studs or rim connections',()=>{
    const a=scene([{key:'base',part:'3403.dat'},{key:'top',part:'3404.dat'}]);
    const evidence:MechanicalJoint={id:'j',male:'base',female:'top',type:'cylindrical',
      motion:'fixed',axis:[0,1,0],centre:[0,0,0],engagement:6};
    expect(refineKnownMechanicalJoints([evidence],a)[0].motion).toBe('revolute');
    expect(refineKnownMechanicalJoints([{...evidence,type:'stud-socket'}],a)[0].motion).toBe('fixed');
    expect(refineKnownMechanicalJoints([{...evidence,centre:[20,0,0]}],a)[0].motion).toBe('fixed');
    expect(refineKnownMechanicalJoints([{...evidence,engagement:0}],a)[0].motion).toBe('fixed');
  });
  it('provides an opt-in spur gear proposal with inference provenance',()=>{
    const a=scene([{key:'left',part:'gearA.dat'},{key:'right',part:'gearB.dat',pos:[40,0,0]}]);
    const metrics:Metrics=id=>({
      ...meshMetrics(id),
      description:id==='gearA.dat'?'Technic Gear 8 Tooth':'Technic Gear 24 Tooth',
      snaps:[{kind:'cyl',gender:'F',shapes:['A'],axis:[0,0,1],start:[0,0,-1],length:2,slide:true,radius:6}],
    } as ReturnType<Metrics>);
    const r=detectAutomaticMechanics(a,metrics,graph([], [['left'],['right']]));
    expect(r.gearMeshes).toHaveLength(1);
    expect(r.gearMeshes[0].confidence).toBe('review-required');
    expect(r.suggestions.some(x=>x.program.gears?.[0].source==='inferred')).toBe(true);
    expect(r.suggestions.every(x=>x.program.joints.every(j=>j.limits===undefined))).toBe(true);
  });
});
