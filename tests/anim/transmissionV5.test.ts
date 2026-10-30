import { describe,expect,it } from 'vitest';
import * as THREE from 'three';
import type { Assembly } from '../../src/model/assemble';
import { MechanismSolver } from '../../src/anim/motion/v4/mechanismSolver';
import { sweepMechanism } from '../../src/anim/motion/v4/mechanismSweep';
import { composeTransmissionProgram } from '../../src/anim/motion/v4/transmissionComposer';
import { projectLinearConstraints } from '../../src/anim/motion/v4/transmissionNetwork';
import { validateMechanismProgram,type MechanismProgram,type TransmissionConstraint } from '../../src/anim/motion/v4/mechanismProgram';
import { proposeFunctionalHints,type DetectedPart } from '../../src/anim/motion/v4/autoMechanics';
const assembly=():Assembly=>({
  instances:['a','b','c'].map((key,i)=>({key,part:key,world:new THREE.Matrix4().makeTranslation(i*20,0,0),
    worldBox:{min:[i*20-1,-1,-1],max:[i*20+1,1,1]},placeholder:false})),
  nodes:[],problems:[],bounds:null,
} as unknown as Assembly);
const p=(t:TransmissionConstraint,kinds:('revolute'|'prismatic')[]=['revolute','revolute']):MechanismProgram=>({
  mode:'kinematic',duration:2,
  joints:kinds.map((kind,i)=>({id:['a','b','c'][i],body:['a','b','c'][i],kind,axis:[0,0,1] as [number,number,number],pivot:[i*20,0,0] as [number,number,number]})),
  driver:{joint:'a',amplitude:.3},transmissions:[t],
});
const source='user' as const;
const coupling=(t:{kind:'gear'|'belt'|'chain';a:string;b:string;teethA:number;teethB:number;crossed?:boolean}):TransmissionConstraint=>
  ({...t,id:'t',source});
describe('V5 multi-degree ideal transmission network',()=>{
  it('respects tooth counts, belt wrap and rack-pinion dimensions',()=>{
    const gear=p(coupling({kind:'gear',a:'a',b:'b',teethA:8,teethB:24}));
    expect(new MechanismSolver(assembly(),gear).solve(1).joints.get('b')).toBeCloseTo(-1/3,10);
    const belt=p({id:'belt',source,kind:'belt',a:'a',b:'b',teethA:8,teethB:24,crossed:false});
    expect(new MechanismSolver(assembly(),belt).solve(1).joints.get('b')).toBeCloseTo(1/3,10);
    const rack=p({id:'rack',source,kind:'rack-pinion',a:'a',b:'b',pitchRadiusLdu:8},['revolute','prismatic']);
    expect(new MechanismSolver(assembly(),rack).solve(Math.PI/2).joints.get('b')).toBeCloseTo(4*Math.PI,8);
  });
  it('supports two motor inputs on a differential and rejects incompatible three-motor values',()=>{
    const diff=p({id:'diff',source,kind:'differential',carrier:'a',left:'b',right:'c'},
      ['revolute','revolute','revolute']);
    const s=new MechanismSolver(assembly(),diff);
    expect(s.solveInputs({a:1,b:1.5}).joints.get('c')).toBeCloseTo(.5,8);
    expect(()=>s.solveInputs({a:1,b:1,c:0})).toThrow(/Contradictory/);
  });
  it('engages and releases an ideal clutch without deleting the output pose',()=>{
    const clutch=p({id:'clutch1',source,kind:'clutch',a:'a',b:'b',engaged:true});
    const s=new MechanismSolver(assembly(),clutch);
    expect(s.solve(.2).joints.get('b')).toBeCloseTo(.2,8);
    expect(s.solveInputs({a:.4},{engagements:{clutch1:false}}).joints.get('b')).toBeCloseTo(.2,8);
  });
  it('engaging mid-motion keeps the output where it is',()=>{
    const s=new MechanismSolver(assembly(),p({id:'c',source,kind:'clutch',a:'a',b:'b',engaged:false,dogs:4}));
    s.solveInputs({a:.5}); // b stays at 0: 0.5 rad from alignment, more than a quarter pitch (π/8)
    expect(s.shift({c:true})).toEqual({engaged:[],stalled:['c']});
    s.solveInputs({a:Math.PI/2+.1}); // 0.1 rad from alignment
    expect(s.shift({c:true})).toEqual({engaged:['c'],stalled:[]});
    expect(s.solveInputs({a:Math.PI/2+.1}).joints.get('b')).toBeCloseTo(0,8); // no jump at engagement
    expect(s.solveInputs({a:Math.PI/2+.6}).joints.get('b')).toBeCloseTo(.5,6); // then it follows
    expect(s.solve(Math.PI/2+.7).joints.get('b')).toBeCloseTo(.6,6);
    expect(s.shift({c:false})).toEqual({engaged:[],stalled:[]});
    expect(s.solveInputs({a:2}).joints.get('b')).toBeCloseTo(.6,6); // released: b keeps its pose
  });
  it('a clutch that fights a gear pair is a lock-up, by name',()=>{
    const prog:MechanismProgram={...p({id:'g',source,kind:'gear',a:'a',b:'b',teethA:8,teethB:24}),
      transmissions:[{id:'g',source,kind:'gear',a:'a',b:'b',teethA:8,teethB:24},{id:'c',source,kind:'clutch',a:'a',b:'b',engaged:false}]};
    const s=new MechanismSolver(assembly(),prog);
    s.solve(.3);
    expect(()=>s.shift({c:true})).toThrow(/Gear lock-up: c/);
    expect(s.solve(.4).joints.get('b')).toBeCloseTo(-.4/3,8); // the refused clutch stays released
  });
  it('rejects a non-finite clutch phase and a dog count below 1',()=>{
    expect(validateMechanismProgram(p({id:'c',source,kind:'clutch',a:'a',b:'b',engaged:true,phase:Number.NaN}))).toEqual([expect.stringMatching(/phase/)]);
    expect(validateMechanismProgram(p({id:'c',source,kind:'clutch',a:'a',b:'b',engaged:true,dogs:0}))).toEqual([expect.stringMatching(/dogs/)]);
    expect(validateMechanismProgram(p({id:'c',source,kind:'clutch',a:'a',b:'b',engaged:true,phase:7.5,dogs:4}))).toEqual([]);
  });
  it('keeps old V4 data valid and rejects incorrect dimensions',()=>{
    const legacy:MechanismProgram={mode:'kinematic',duration:2,
      joints:[{id:'a',body:'a',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]}],
      driver:{joint:'a',amplitude:.1}};
    expect(validateMechanismProgram(legacy)).toEqual([]);
    const invalid=p({id:'rack',source,kind:'rack-pinion',a:'a',b:'b',pitchRadiusLdu:9});
    expect(validateMechanismProgram(invalid).join(' ')).toMatch(/incompatible/);
  });
  it('reports contradictory equations without guessing a result',()=>{
    const e=(id:string,a:number,b:number,rhs:number)=>({id,coefficients:new Map([['a',a],['b',b]]),rhs});
    expect(()=>projectLinearConstraints(['a','b'],[e('one',1,1,2),e('two',1,1,3)],new Map())).toThrow(/Contradictory/);
  });
  it('runs 49-frame reversals and reports a narrow verified joint stop',()=>{
    const gear=p(coupling({kind:'gear',a:'a',b:'b',teethA:8,teethB:24}));
    expect(sweepMechanism(assembly(),gear).status).toBe('sampled-pass');
    gear.joints[1].limits={min:-.01,max:.01,source:'verified'};
    expect(sweepMechanism(assembly(),gear).status).toBe('sampled-fail');
  });
  it('proposes review-only functional hints, not imaginary verified mates',()=>{
    const parts=[
      {key:'a',part:'worm',category:'gear',description:'Worm Gear',evidence:'ldraw-description'},
      {key:'b',part:'wheel',category:'gear',description:'Gear 24 Tooth',teeth:24,axis:[0,0,1],evidence:'ldraw-description'},
    ] as DetectedPart[];
    const proposals=proposeFunctionalHints(parts,new Map<string,[number,number,number]>([['a',[0,0,0]],['b',[20,0,0]]]));
    expect(proposals).toHaveLength(1);
    expect(proposals[0].kind).toBe('worm');
    expect(proposals[0].evidence).toBe('part-description-proximity');
  });
  it('composes a shared-shaft gear train without duplicating a joint',()=>{
    const model=assembly();
    const network=composeTransmissionProgram(model,{rigidClusters:[]} as never,[],[
      {kind:'gear',a:'a',b:'b',axis:[0,0,1],teethA:12,teethB:24},
      {kind:'gear',a:'b',b:'c',axis:[0,0,1],teethA:24,teethB:8},
    ]);
    expect(network.joints).toHaveLength(3);
    expect(network.transmissions).toHaveLength(2);
    const frame=new MechanismSolver(model,network).solve(1);
    expect(frame.joints.get(network.joints[1].id)).toBeCloseTo(-.5,9);
    expect(frame.joints.get(network.joints[2].id)).toBeCloseTo(1.5,9);
  });
  it('estimates tangential rack travel and rejects mixed part roles',()=>{
    const model=assembly();
    const graph={rigidClusters:[]} as never;
    const rack={kind:'rack-pinion' as const,a:'a',b:'b',axis:[0,0,1] as [number,number,number],pitchRadiusLdu:10};
    const program=composeTransmissionProgram(model,graph,[],[rack]);
    expect(program.joints[1].kind).toBe('prismatic');
    expect(program.joints[1].axis[1]).toBeCloseTo(1);
    expect(()=>composeTransmissionProgram(model,graph,[],[rack,
      {kind:'gear',a:'b',b:'c',axis:[0,0,1],teethA:12,teethB:24}
    ])).toThrow(/both a rotating shaft and a sliding rack/);
  });
  it('accepts independently keyed secondary motion parameters but rejects the primary as secondary',()=>{
    const program=p({id:'diff',source,kind:'differential',carrier:'a',left:'b',right:'c'},
      ['revolute','revolute','revolute']);
    program.secondaryMotors=[{joint:'b',amplitude:.2,cycles:2}];
    expect(validateMechanismProgram(program)).toEqual([]);
    program.secondaryMotors=[{joint:'a',amplitude:.2,cycles:2}];
    expect(validateMechanismProgram(program).join(' ')).toMatch(/Secondary motor/);
  });
});
