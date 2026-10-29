/** Offline deterministic kinematics contract tests. Three.js is stubbed as
 * in verify-v4-mechanisms-offline; these are NOT real geometry/collision tests. */
const {test,assert,approx,load,assembly}=require('./verify-v4-mechanisms-offline.cjs');
const {MechanismSolver}=load('src/anim/motion/v4/mechanismSolver.ts');
const {validateMechanismProgram}=load('src/anim/motion/v4/mechanismProgram.ts');
const {projectLinearConstraints,projectLimitedNetwork}=load('src/anim/motion/v4/transmissionNetwork.ts');
const {sweepMechanism}=load('src/anim/motion/v4/mechanismSweep.ts');
const {composeTransmissionProgram}=load('src/anim/motion/v4/transmissionComposer.ts');
const {compileMechanismStage}=load('src/anim/motion/v4/mechanismStage.ts');
const {metrics,timeline}=require('./verify-v4-mechanisms-offline.cjs');
const joint=(id,kind='revolute')=>({id,body:id,kind,axis:[0,0,1],pivot:[0,0,0]});
const asm=()=>assembly([['a'],['b'],['c']]);
const program=(t,js=[joint('a'),joint('b')])=>({mode:'kinematic',duration:2,joints:js,
  transmissions:[{id:'coupling',source:'user',...t}],driver:{joint:'a',amplitude:.3}});
const tsolve=(t,driver=1,js)=>new MechanismSolver(asm(),program(t,js)).solve(driver);

test('V5 external gear ratio 12:36',()=>{
 const f=tsolve({kind:'gear',a:'a',b:'b',teethA:12,teethB:36});
 approx(f.joints.get('b'),-1/3);approx(f.transmissionResidual,0);assert.equal(f.activeTransmissions,1);
});
test('V5 belt drive uncrossed and crossed preserves signed ratio',()=>{
 for(const [crossed,expected] of [[false,.5],[true,-.5]]){
  const f=tsolve({kind:'belt',a:'a',b:'b',teethA:12,teethB:24,crossed});
  approx(f.joints.get('b'),expected);
 }
});
test('V5 chain sprocket ratio',()=>{
 approx(tsolve({kind:'chain',a:'a',b:'b',teethA:8,teethB:24}).joints.get('b'),1/3);
});
test('V5 multi-start worm drive 2:40',()=>{
 approx(tsolve({kind:'worm',a:'a',b:'b',starts:2,wheelTeeth:40}).joints.get('b'),.05);
 approx(tsolve({kind:'worm',a:'a',b:'b',starts:2,wheelTeeth:40,reversed:true}).joints.get('b'),-.05);
});
test('V5 rack and pinion converts radians to LDU',()=>{
 const f=tsolve({kind:'rack-pinion',a:'a',b:'b',pitchRadiusLdu:10},Math.PI/2,[joint('a'),joint('b','prismatic')]);
 approx(f.joints.get('b'),5*Math.PI);approx(f.poses.get('b').elements[14],5*Math.PI);
});
test('V5 screw lead converts revolutions to travel',()=>{
 const f=tsolve({kind:'linear-actuator',a:'a',b:'b',leadLduPerTurn:8},2*Math.PI,
  [joint('a'),joint('b','prismatic')]);
 approx(f.joints.get('b'),8);
});
test('V5 open differential single motor shares motion between outputs',()=>{
 const p=program({kind:'differential',carrier:'a',left:'b',right:'c'},[joint('a'),joint('b'),joint('c')]);
 const s=new MechanismSolver(asm(),p),f=s.solve(1.1);
 approx(f.joints.get('b'),1.1);approx(f.joints.get('c'),1.1);
});
test('V5 differential supports TWO independently driven shafts',()=>{
 const p=program({kind:'differential',carrier:'a',left:'b',right:'c'},[joint('a'),joint('b'),joint('c')]);
 const s=new MechanismSolver(asm(),p);
 let f=s.solveInputs({a:1.0,b:1.5});approx(f.joints.get('c'),.5);
 f=s.solveInputs({b:2,c:0});approx(f.joints.get('a'),1);
});
test('V5 differential cannot obey three contradictory motor commands',()=>{
 const p=program({kind:'differential',carrier:'a',left:'b',right:'c'},[joint('a'),joint('b'),joint('c')]);
 const s=new MechanismSolver(asm(),p);
 assert.throws(()=>s.solveInputs({a:1,b:1,c:0}),/Contradictory|cannot close/);
});
test('V5 clutch engagement toggle preserves unconstrained shaft pose',()=>{
 const s=new MechanismSolver(asm(),program({kind:'clutch',a:'a',b:'b',engaged:true}));
 approx(s.solve(.25).joints.get('b'),.25);
 const open=s.solveInputs({a:.7},{engagements:{coupling:false}});
 approx(open.joints.get('a'),.7);approx(open.joints.get('b'),.25);
 const closed=s.solveInputs({a:.5},{engagements:{coupling:true}});
 approx(closed.joints.get('b'),.5);
});
test('V5 contradictory network cycles fail closed',()=>{
 const p=program({kind:'gear',a:'a',b:'b',teethA:12,teethB:24});
 p.transmissions.push({id:'contradict',kind:'belt',a:'a',b:'b',teethA:12,teethB:24,source:'user'});
 const s=new MechanismSolver(asm(),p);
 assert.throws(()=>s.solve(.5),/Contradictory|cannot close/);
});
test('V5 coupled joint stop preserves exact ratios or rejects motion',()=>{
 const p=program({kind:'chain',a:'a',b:'b',teethA:8,teethB:24});
 p.joints[1].limits={min:-.1,max:.1,source:'verified'};
 const s=new MechanismSolver(asm(),p);
 approx(s.solve(.2).joints.get('b'),.2/3);
 assert.throws(()=>s.solve(.6),/stop|Contradictory/);
});
test('V5 rejects wrong joint dimension, duplicate bodies and invalid ratios',()=>{
 const p=program({kind:'rack-pinion',a:'a',b:'b',pitchRadiusLdu:20});
 assert(validateMechanismProgram(p).some(x=>/incompatible/.test(x)));
 p.joints[1].kind='prismatic';assert.deepEqual(validateMechanismProgram(p),[]);
 p.transmissions[0].pitchRadiusLdu=-1;assert(validateMechanismProgram(p).some(x=>/pitch radius/.test(x)));
 p.transmissions[0].pitchRadiusLdu=20;p.transmissions.push({...p.transmissions[0]});
 assert(validateMechanismProgram(p).some(x=>/duplicate/.test(x)));
});
test('V5 regularizes underdetermined motion using minimum-change continuation',()=>{
 const p=program({kind:'differential',carrier:'a',left:'b',right:'c'},[joint('a'),joint('b'),joint('c')]);
 const s=new MechanismSolver(asm(),p);
 s.solveInputs({a:0,b:.6});
 const next=s.solve(.4);
 approx(next.joints.get('b'),1);approx(next.joints.get('c'),-.2);
});
test('V5 projection detects dependent contradictions and rank',()=>{
 const eq=(id,a,b,c)=>({id,coefficients:new Map([['a',a],['b',b]]),rhs:c});
 const solved=projectLinearConstraints(['a','b'],[eq('eq1',1,1,2),eq('eq2',2,2,4)],new Map());
 assert.equal(solved.rank,1);approx(solved.roots.get('a'),1);approx(solved.roots.get('b'),1);
 assert.throws(()=>projectLinearConstraints(['a','b'],[eq('eq1',1,1,2),eq('eq2',2,2,5)],new Map()),/Contradictory/);
});
test('V5 active bound projection gives feasible compensated motion',()=>{
 const eq=[{id:'sum',coefficients:new Map([['a',1],['b',1]]),rhs:2}];
 const solved=projectLimitedNetwork(['a','b'],eq,new Map([['a',4],['b',0]]),new Map([['a',{min:0,max:1.2}],['b',{min:0,max:2}]]));
 approx(solved.roots.get('a'),1.2);approx(solved.roots.get('b'),.8);
});
test('V5 exact q=0 returns imported assembly despite clutch changes',()=>{
 const s=new MechanismSolver(asm(),program({kind:'gear',a:'a',b:'b',teethA:12,teethB:48}));
 s.solve(.2);const f=s.assembled();
 approx(f.joints.get('a'),0);approx(f.joints.get('b'),0);
 approx(f.poses.get('a').elements[12],0);
});

test('V5 49-frame sweep passes sampled ideal differential and reports DOFs',()=>{
 const p=program({kind:'differential',carrier:'a',left:'b',right:'c'},[joint('a'),joint('b'),joint('c')]);
 const report=sweepMechanism(asm(),p);
 assert.equal(report.status,'sampled-pass');assert.equal(report.checkedSamples,49);
 assert.equal(report.estimatedUnconstrainedCoordinates,2);
 assert(report.warnings.some(x=>x.includes('No collision')));
 approx(report.maxTransmissionResidual,0);
});
test('V5 sweep identifies exact joint stop failure point without claiming clearance',()=>{
 const p=program({kind:'gear',a:'a',b:'b',teethA:12,teethB:24});
 p.driver.amplitude=.8;
 p.joints[1].limits={min:-.1,max:.1,source:'verified'};
 const report=sweepMechanism(asm(),p);
 assert.equal(report.status,'sampled-fail');assert(report.checkedSamples>0&&report.checkedSamples<49);
 assert(/stop|Contradictory/.test(report.error));assert(report.failedAt!==undefined);
});
test('V5 sweep rejects a fixed pair forcibly split by authored program',()=>{
 const p=program({kind:'chain',a:'a',b:'b',teethA:8,teethB:8});
 const graph={edges:[{id:'weld',motion:'fixed',a:'a',b:'b'}]};
 const report=sweepMechanism(asm(),p,graph);
 assert.equal(report.status,'sampled-fail');assert(/Fixed LDCad connection/.test(report.error));
});
test('V5 transmission demo compiles into same non-destructive stage pipeline',()=>{
 const p=program({kind:'rack-pinion',a:'a',b:'b',pitchRadiusLdu:10},[joint('a'),joint('b','prismatic')]);
 const a=asm(),tl=timeline(a);
 const stage=compileMechanismStage(a,metrics,tl,p);
 assert.equal(stage.diagnostics.gearPairs,0);assert.equal(stage.diagnostics.transmissionConstraints,1);
 assert(stage.frames>=121);assert(stage.diagnostics.maxTransmissionResidual<1e-7);
 assert.equal(stage.collisionStatus,'unverified');
 assert.deepEqual(stage.tracks.find(t=>t.key==='b').deltas.at(-1),new (require('./verify-v4-mechanisms-offline.cjs').Matrix4)().elements);
});
test('V5 network exact-ratio long repeated seek has no drift',()=>{
 const s=new MechanismSolver(asm(),program({kind:'belt',a:'a',b:'b',teethA:12,teethB:24}));
 for(let n=0;n<200;n++){
  const q=Math.sin(n*.127)*.7;
  const f=s.solve(q);
  approx(f.joints.get('b'),q/2,1e-9);
  if(!Number.isFinite(f.poses.get('b').elements[0]))throw Error('invalid matrix');
 }
});

const graph=clusters=>({rigidClusters:clusters,edges:[]});
const draft=(kind,a,b,more={})=>({kind,a,b,axis:[0,0,1],teethA:12,teethB:24,...more});
test('V5 workshop composes two gear trains sharing one exact shaft',()=>{
 const a=assembly([['A'],['B'],['C']]);
 const p=composeTransmissionProgram(a,graph([]),[],[
  draft('gear','A','B',{teethA:12,teethB:24}),
  draft('gear','B','C',{teethA:24,teethB:8}),
 ]);
 assert.equal(p.joints.length,3);assert.equal(p.transmissions.length,2);
 const f=new MechanismSolver(a,p).solve(1);
 const b=p.joints.find(j=>j.body==='B'),c=p.joints.find(j=>j.body==='C');
 approx(f.joints.get(b.id),-.5);approx(f.joints.get(c.id),1.5);
});
test('V5 workshop composes gearbox into open differential',()=>{
 const a=assembly([['A'],['B'],['C'],['D']]);
 const p=composeTransmissionProgram(a,graph([]),[],[
  draft('gear','A','B',{teethA:12,teethB:24}),
  draft('differential','B','C',{c:'D'}),
 ]);
 const solved=new MechanismSolver(a,p);
 const f=solved.solve(1);
 for(const key of ['C','D'])approx(f.joints.get(p.joints.find(j=>j.body===key).id),-.5);
 const carrier=p.joints.find(j=>j.body==='B').id,left=p.joints.find(j=>j.body==='C').id;
 const two=solved.solveInputs({[p.driver.joint]:1,[left]:-.3});
 approx(two.joints.get(carrier),-.5);
 approx(two.joints.get(p.joints.find(j=>j.body==='D').id),-.7);
});
test('V5 workshop rejects contradictory shaft type reuse',()=>{
 const a=assembly([['A'],['B',[10,0,0]],['C']]);
 a.instances[1].worldBox={min:[9,-1,-1],max:[11,1,1]};
 assert.throws(()=>composeTransmissionProgram(a,graph([]),[],[
   draft('rack-pinion','A','B',{pitchRadiusLdu:8}),
   draft('gear','B','C'),
 ]),/both a rotating shaft and a sliding rack/);
});
test('V5 workshop does not split the same fixed rigid component',()=>{
 const a=assembly([['A'],['B']]);
 assert.throws(()=>composeTransmissionProgram(a,graph([['A','B']]),[],[draft('gear','A','B')]),/fixed connector cluster/);
});
test('V5 workshop estimates rack sliding direction tangent to pinion axis',()=>{
 const a=assembly([['A'],['B',[10,0,0]]]);
 a.instances[1].worldBox={min:[9,-1,-1],max:[11,1,1]};
 const p=composeTransmissionProgram(a,graph([]),[],[draft('rack-pinion','A','B',{pitchRadiusLdu:10})]);
 const rack=p.joints.find(j=>j.body==='B');
 assert.equal(rack.kind,'prismatic');approx(rack.axis[0],0);approx(rack.axis[1],1);
 const pose=new MechanismSolver(a,p).solve(.2).poses.get('B');
 approx(pose.elements[13],2);
});
test('V5 workshop prevents incompatible axes on a shared shaft',()=>{
 const a=assembly([['A'],['B'],['C']]);
 assert.throws(()=>composeTransmissionProgram(a,graph([]),[],[
   draft('gear','A','B'),draft('gear','B','C',{axis:[1,0,0]}),
 ]),/incompatible world axes/);
});
test('V5 workshop reports impossible mechanically closed transmission graph',()=>{
 const a=assembly([['A'],['B']]);
 const p=composeTransmissionProgram(a,graph([]),[],[
  draft('gear','A','B'),draft('chain','A','B'),
 ]);
 assert.throws(()=>new MechanismSolver(a,p).solve(.18),/Contradictory/);
});

test('V5 multi-motor stage bakes independent differential motor sine tracks',()=>{
 const a=asm(),p=program({kind:'differential',carrier:'a',left:'b',right:'c'},
  [joint('a'),joint('b'),joint('c')]);
 p.driver.amplitude=.8;p.secondaryMotors=[{joint:'b',amplitude:.3,cycles:2}];
 assert.deepEqual(validateMechanismProgram(p),[]);
 const stage=compileMechanismStage(a,metrics,timeline(a),p);
 assert.equal(stage.diagnostics.secondaryMotorTracks,1);
 const middle=stage.tracks.find(x=>x.key==='c').deltas[30];
 approx(middle[0],Math.cos(1.6),1e-5);
 approx(middle[1],Math.sin(1.6),1e-5);
 assert.deepEqual(stage.tracks.find(x=>x.key==='c').deltas.at(-1),new (require('./verify-v4-mechanisms-offline.cjs').Matrix4)().elements);
});
test('V5 saved independent drives reject physically inconsistent gear commands',()=>{
 const a=asm(),p=program({kind:'gear',a:'a',b:'b',teethA:12,teethB:24});
 p.secondaryMotors=[{joint:'b',amplitude:.2,cycles:1}];
 assert.throws(()=>compileMechanismStage(a,metrics,timeline(a),p),/Contradictory/);
});
test('V5 secondary motor schema rejects duplicate/unknown/primary motors and gravity',()=>{
 const p=program({kind:'gear',a:'a',b:'b',teethA:12,teethB:24});
 p.secondaryMotors=[{joint:'a',amplitude:.1}];
 assert(validateMechanismProgram(p).some(x=>x.includes('Secondary motor')));
 p.secondaryMotors=[{joint:'b',amplitude:.1},{joint:'b',amplitude:.2}];
 assert(validateMechanismProgram(p).some(x=>x.includes('Secondary motor')));
 p.secondaryMotors=[{joint:'z',amplitude:.1}];
 assert(validateMechanismProgram(p).some(x=>x.includes('Secondary motor')));
 p.secondaryMotors=[{joint:'b',amplitude:.1}];
 assert.deepEqual(validateMechanismProgram(p),[]);
 p.mode='gravity';
 assert(validateMechanismProgram(p).some(x=>x.includes('Secondary motors require kinematic')));
});

if(process.exitCode)process.exit(process.exitCode);
