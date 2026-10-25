import { describe,it,expect } from 'vitest';
import * as THREE from 'three';
import type { Assembly, Metrics } from '../../src/model/assemble';
import { poseAt, type Timeline } from '../../src/anim/timeline';
import type { MechanismProgram } from '../../src/anim/motion/v4/mechanismProgram';
import { validateMechanismProgram } from '../../src/anim/motion/v4/mechanismProgram';
import { MechanismSolver } from '../../src/anim/motion/v4/mechanismSolver';
import { ReducedGravityPreview } from '../../src/anim/motion/v4/physicsPreview';
import { compileMechanismStage } from '../../src/anim/motion/v4/mechanismStage';
import { mechanismPoseAt } from '../../src/anim/motion/v4/mechanismPlayback';
import { encodeTimeline,decodeTimeline } from '../../src/anim/timelineCodec';

const at=(x=0,y=0,z=0)=>new THREE.Matrix4().makeTranslation(x,y,z);
const parts=(list:{key:string;pos?:[number,number,number]}[]):Assembly=>({
  instances:list.map(({key,pos})=>({key,part:key,world:at(...(pos??[0,0,0])),worldBox:{
    min:[-1,-1,-1],max:[1,1,1]},placeholder:false})),nodes:[],problems:[],bounds:null,
} as unknown as Assembly);
const metrics:Metrics=()=>({full:{min:[-1,-1,-1],max:[1,1,1]},body:{min:[-1,-1,-1],max:[1,1,1]}} as ReturnType<Metrics>);
const timeline=(a:Assembly):Timeline=>({
  tracks:new Map(a.instances.map(i=>[i.key,{appear:0,floor:i.world.clone(),final:i.world.clone(),
    floorBox:i.worldBox,ctx:0,moves:[]}])),
  units:[],duration:12,buildEnd:10,sceneBox:{min:[-20,-20,-20],max:[20,20,20]},
  buildBox:{min:[-20,-20,-20],max:[20,20,20]},camKeys:[],pacing:{outro:2},
} as unknown as Timeline);
const gearDemo=():MechanismProgram=>({mode:'kinematic',duration:2,sampleHz:60,
  joints:[{id:'a',body:'gearA',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]},
    {id:'b',body:'gearB',kind:'revolute',axis:[0,0,1],pivot:[8,0,0]}],
  gears:[{a:'a',b:'b',teethA:8,teethB:24,mesh:'external',moduleLdu:.5,source:'user'}],
  driver:{joint:'a',amplitude:Math.PI/2,cycles:1}});
const linkage=():MechanismProgram=>({mode:'kinematic',duration:2,sampleHz:60,
  joints:[{id:'crank',body:'crank',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]},
    {id:'coupler',body:'coupler',parent:'crank',kind:'revolute',axis:[0,0,1],pivot:[2,0,0]},
    {id:'rocker',body:'rocker',kind:'revolute',axis:[0,0,1],pivot:[5,0,0]}],
  closures:[{a:{body:'coupler',local:[2,2,0]},b:{body:'rocker',local:[-1,2,0]},toleranceLdu:.05}],
  driver:{joint:'crank',amplitude:.2,cycles:1}});

describe('Standard Motion v4 — phases 4 to 6',()=>{
  it('rejects malformed programs and invented masses or gear counts',()=>{
    expect(validateMechanismProgram(gearDemo())).toEqual([]);
    expect(validateMechanismProgram({...gearDemo(),gears:[{...gearDemo().gears![0],teethA:0}]})).not.toEqual([]);
    expect(validateMechanismProgram({...gearDemo(),mode:'gravity'})).not.toEqual([]);
  });
  it('preserves exact pitch-centre pivots and enforces signed gear ratios',()=>{
    const a=parts([{key:'gearA'},{key:'gearB',pos:[8,0,0]}]);
    const solver=new MechanismSolver(a,gearDemo());
    const f=solver.solve(Math.PI/2);
    expect(f.joints.get('a')).toBeCloseTo(Math.PI/2,8);
    expect(f.joints.get('b')).toBeCloseTo(-Math.PI/6,8);
    expect(f.poses.get('gearB')!.elements.slice(12,15)).toEqual([8,0,0]);
    expect(()=>new MechanismSolver(a,{...gearDemo(),gears:[{...gearDemo().gears![0],moduleLdu:1}]})).toThrow(/pitch circles/);
    const limited={...gearDemo(),joints:gearDemo().joints.map(j=>j.id==='b'?{...j,limits:{min:-.1,max:.1,source:'verified' as const}}:j)};
    expect(()=>new MechanismSolver(a,limited).solve(Math.PI/2)).toThrow(/stop/);
  });
  it('detects inconsistent gear cycles and ownership cycles',()=>{
    const p=gearDemo();p.joints.push({id:'c',body:'gearC',kind:'revolute',axis:[0,0,1],pivot:[20,0,0]});
    p.gears!.push({a:'b',b:'c',teethA:24,teethB:16,mesh:'external',source:'user'},
      {a:'c',b:'a',teethA:16,teethB:8,mesh:'external',source:'user'});
    expect(()=>new MechanismSolver(parts([{key:'gearA'},{key:'gearB',pos:[8,0,0]},{key:'gearC',pos:[20,0,0]}]),p))
      .toThrow(/Contradictory/);
    // Drop the gearC joint too: this case is a two-body program, and a joint
    // for an absent body is rejected before ownership cycles are considered.
    p.gears=[];p.joints.pop();p.joints[0].parent='gearB';p.joints[1].parent='gearA';
    expect(()=>new MechanismSolver(parts([{key:'gearA'},{key:'gearB'}]),p)).toThrow(/directed cycle/);
  });
  it('solves non-singular closed four-bar linkages and rejects impossible reaches',()=>{
    const a=parts([{key:'crank'},{key:'coupler',pos:[2,0,0]},{key:'rocker',pos:[5,0,0]}]);
    const s=new MechanismSolver(a,linkage());
    for(const q of [0,.02,.05,.1,.2,.13,.04,0]){
      const frame=s.solve(q);
      expect(frame.maxClosureErrorLdu).toBeLessThan(.051);
    }
    expect(()=>s.solve(Math.PI)).toThrow(/Unreachable|stop/);
  });
  it('uses supplied mass and inertia in fixed-step constrained gravity',()=>{
    const demo:MechanismProgram={mode:'gravity',duration:2,joints:[{id:'pendulum',body:'arm',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]}],
      driver:{joint:'pendulum',amplitude:.3},gravity:{releaseAt:.3,acceleration:[0,9.81,0],damping:.002,
        bodies:[{body:'arm',massKg:.1,centreLocal:[5,0,0],inertiaKgM2:.001}]}};
    const a=parts([{key:'arm'}]),s=new MechanismSolver(a,demo),sim=new ReducedGravityPreview(s,a,metrics);
    sim.reset(.3);expect(sim.accelerationAt(.3,0).acceleration).toBeGreaterThan(0);
    for(let i=0;i<12;i++)sim.step(1/240);
    expect(Number.isFinite(sim.position)).toBe(true);
    expect(sim.approximateInertias).toBe(0);
    expect(()=>sim.step(.25)).toThrow(/1\/120/);
  });
  it('encodes/decodes a gear demo with bit-identical rest and synchronized playback',()=>{
    const a=parts([{key:'gearA'},{key:'gearB',pos:[8,0,0]}]),tl=timeline(a);
    const stage=compileMechanismStage(a,metrics,tl,gearDemo());
    expect(stage.collisionStatus).toBe('unverified');
    expect(stage.diagnostics.gearPairs).toBe(1);
    expect(stage.tracks.every(track=>track.deltas[0].every((x,i)=>x===(new THREE.Matrix4()).elements[i]))).toBe(true);
    tl.mechanismStage=stage;
    const decoded=decodeTimeline(encodeTimeline(tl));
    expect(decoded.mechanismStage).toEqual(stage);
    const rest=tl.tracks.get('gearB')!.final;
    const pose=mechanismPoseAt(stage,stage.start+stage.duration*.25,'gearB',rest)!;
    expect(pose).not.toBeNull();
    expect(pose.elements[0]).toBeCloseTo(Math.cos(Math.PI/6),2);
    const byTimeline=poseAt(decoded,stage.start+stage.duration*.25)('gearB')!;
    byTimeline.elements.forEach((x,i)=>expect(x).toBeCloseTo(pose.elements[i],8));
    const end=mechanismPoseAt(stage,stage.start+stage.duration,'gearB',rest)!;
    end.elements.forEach((x,i)=>expect(x).toBeCloseTo(rest.elements[i],8));
    const after=poseAt(decoded,stage.start+stage.duration+1)('gearB')!;
    after.elements.forEach((x,i)=>expect(x).toBeCloseTo(rest.elements[i],8));
  });
  it('rejects moving carriers which pull gear pitch circles apart',()=>{
    const a=parts([{key:'carrier'},{key:'gearA',pos:[2,0,0]},{key:'gearB',pos:[8,0,0]}]);
    const p:MechanismProgram={mode:'kinematic',duration:2,
      joints:[{id:'carrier',body:'carrier',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]},
        {id:'a',body:'gearA',parent:'carrier',kind:'revolute',axis:[0,0,1],pivot:[2,0,0]},
        {id:'b',body:'gearB',kind:'revolute',axis:[0,0,1],pivot:[8,0,0]}],
      gears:[{a:'a',b:'b',teethA:8,teethB:24,mesh:'external',moduleLdu:.375,source:'user'}],
      driver:{joint:'carrier',amplitude:.9}};
    const solver=new MechanismSolver(a,p);
    expect(()=>solver.solve(0)).not.toThrow();
    expect(()=>solver.solve(.9)).toThrow(/moving shafts lose pitch engagement/);
  });
  it('uses each closure tolerance independently, not the strictest tolerance for every closure',()=>{
    const a=parts([{key:'rotor'},{key:'frame'}]);
    const p:MechanismProgram={mode:'kinematic',duration:2,
      joints:[{id:'rotation',body:'rotor',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]}],
      closures:[
        {a:{body:'rotor',local:[0,0,0]},b:{body:'frame',local:[0,0,0]},toleranceLdu:.05},
        {a:{body:'rotor',local:[5,0,0]},b:{body:'frame',local:[5,0,0]},toleranceLdu:.6}],
      driver:{joint:'rotation',amplitude:.08}};
    const solved=new MechanismSolver(a,p).solve(.08);
    expect(solved.closureErrorsLdu[0]).toBeLessThan(.000001);
    expect(solved.closureErrorsLdu[1]).toBeGreaterThan(.3);
    expect(solved.closureErrorsLdu[1]).toBeLessThan(.6);
  });
  it('requires non-duplicated explicit masses for every driven and welded body',()=>{
    const p:MechanismProgram={mode:'gravity',duration:2,
      joints:[{id:'hinge',body:'arm',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]}],
      rigidFollowers:[{leader:'arm',bodies:['pin']}],driver:{joint:'hinge',amplitude:.1},
      gravity:{releaseAt:.1,acceleration:[0,9.81,0],damping:.01,
        bodies:[{body:'arm',massKg:.1,centreLocal:[5,0,0]}]}};
    expect(validateMechanismProgram(p).join(' ')).toMatch(/moving body pin/);
    p.gravity!.bodies.push({body:'pin',massKg:.01});
    expect(validateMechanismProgram(p)).toEqual([]);
    p.gravity!.bodies.push({body:'pin',massKg:.02});
    expect(validateMechanismProgram(p).join(' ')).toMatch(/Duplicate physical mass/);
  });
  it('appends a gravity demonstration after Build and restores exact final poses',()=>{
    const a=parts([{key:'arm'}]),tl=timeline(a);
    const p:MechanismProgram={mode:'gravity',duration:1,sampleHz:24,
      joints:[{id:'h',body:'arm',kind:'revolute',axis:[0,0,1],pivot:[0,0,0],limits:{min:-.9,max:.9,source:'user'}}],
      driver:{joint:'h',amplitude:.2},gravity:{releaseAt:.2,acceleration:[0,9.81,0],damping:.01,
        bodies:[{body:'arm',massKg:.1,centreLocal:[5,0,0],inertiaKgM2:.001}]}};
    const stage=compileMechanismStage(a,metrics,tl,p);
    expect(stage.start).toBeGreaterThan(tl.buildEnd);
    expect(stage.diagnostics.physicsSteps).toBeGreaterThan(0);
    expect(stage.collisionStatus).toBe('unverified');
    const rest=tl.tracks.get('arm')!.final;
    const end=mechanismPoseAt(stage,stage.start+stage.duration,'arm',rest)!;
    end.elements.forEach((x,i)=>expect(x).toBeCloseTo(rest.elements[i],9));
  });
  it('rejects a fixed connector ripped apart by a configured motion',()=>{
    const a=parts([{key:'gearA'},{key:'gearB',pos:[8,0,0]},{key:'axle'}]),tl=timeline(a);
    const graph={edges:[{id:'fixed',a:'gearA',b:'axle',motion:'fixed'}]};
    expect(()=>compileMechanismStage(a,metrics,tl,gearDemo(),[],graph as never)).toThrow(/Fixed connection/);
  });
});
