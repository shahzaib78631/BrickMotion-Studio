/** V7 mechanics-in-spatial-linkages regressions. Offline mathematical tests;
 * not force, material, rendering or contact verification. */
const {test,assert,approx,load}=require('./verify-v4-mechanisms-offline.cjs');
const {SpatialMechanismSolver,validateSpatialModel}=load('src/anim/motion/v6/spatialConstraints.ts');
const I=[0,0,0,1],P=(x=0,y=0,z=0)=>[x,y,z];
const body=(id,p=P(),fixed=false)=>({id,rest:{p,q:I},fixed});
const anchor=(id,local=P())=>({body:id,local});
const hinge=(id,b='shaft',pivot=P())=>({id,kind:'hinge',a:anchor('ground',pivot),b:anchor(b),axisA:P(0,0,1),axisB:P(0,0,1)});
const slider=(id,b='slider',axis=P(1,0,0))=>({id,kind:'slider',a:anchor('ground'),b:anchor(b),axisA:axis,axisB:axis});
const model=(joints,mechanics=[])=>({bodies:[body('ground',P(),true),...joints.map(([_,kind,b])=>body(b))],constraints:joints.map(([id,kind,b])=>kind==='hinge'?hinge(id,b):slider(id,b)),mechanics});
const two=()=>model([['in','hinge','shaft1'],['out','hinge','shaft2']]);
const motor=(m,drives)=>new SpatialMechanismSolver(m).solve(drives);
const good=(s)=>assert.equal(s.status,'converged',s.warning);
const q=(s,id)=>s.jointPositions.get(id);

test('V7 external spur gear rotates a connected 3D shaft with exact negative ratio',()=>{
 const m=two();m.mechanics=[{id:'mesh',kind:'gear',input:'in',output:'out',inputTeeth:12,outputTeeth:36}];
 const f=motor(m,{in:.6});good(f);approx(q(f,'out'),-.2,.004);
 assert(f.residualByConstraint.has('mechanic:mesh'));
 assert.equal(f.estimatedFreeDof,0);
});
test('V7 internal gears preserve rotation direction',()=>{
 const m=two();m.mechanics=[{id:'ring',kind:'gear',input:'in',output:'out',inputTeeth:12,outputTeeth:24,internal:true}];
 const f=motor(m,{in:.4});good(f);approx(q(f,'out'),.2,.004);
});
test('V7 chain and uncrossed/crossed belts choose correct signs',()=>{
 for(const [kind,crossed,sign] of [['chain',false,1],['belt',false,1],['belt',true,-1]]){
  const m=two();m.mechanics=[{id:'drive',kind,input:'in',output:'out',inputTeeth:24,outputTeeth:12,crossed}];
  const f=motor(m,{in:.2});good(f);approx(q(f,'out'),sign*.4,.005);
 }
});
test('V7 worm reducer respects starts and reversal',()=>{
 for(const reversed of [true,false]){
  const m=two();m.mechanics=[{id:'worm',kind:'worm',input:'in',output:'out',starts:2,wheelTeeth:40,reversed}];
  const f=motor(m,{in:1});good(f);approx(q(f,'out'),(reversed?-1:1)*.05,.004);
 }
});
test('V7 Hooke universal drive models nonconstant output speed across bend',()=>{
 const m=two();m.mechanics=[{id:'hooke',kind:'universal-drive',input:'in',output:'out',bendAngleRad:Math.PI/4}];
 const f=motor(m,{in:.6});good(f);
 approx(q(f,'out'),Math.atan2(Math.cos(Math.PI/4)*Math.sin(.6),Math.cos(.6)),.004);
 assert(Math.abs(q(f,'out')-.6)>.05);
});
test('V7 constant velocity shaft couples equal speed without matching shaft axes',()=>{
 const m=two();m.mechanics=[{id:'cv',kind:'cv-joint',input:'in',output:'out'}];
 const f=motor(m,{in:.4});good(f);approx(q(f,'out'),.4,.003);
});
test('V7 rack-pinion drives real slider body through spatial solve',()=>{
 const m=model([['pinion','hinge','shaft'],['rack','slider','sled']],
  [{id:'rackmesh',kind:'rack-pinion',rotary:'pinion',linear:'rack',pitchRadiusLdu:20}]);
 const f=motor(m,{pinion:.2});good(f);approx(q(f,'rack'),4,.035);
 approx(f.poses.get('sled').p[0],4,.035);
});
test('V7 actuator lead-to-travel and cable pulley mechanical advantage',()=>{
 for(const [mechanic,expected] of [
  [{id:'screw',kind:'screw',rotary:'shaft',linear:'slide',leadLduPerTurn:8},8/2/Math.PI],
  [{id:'winch',kind:'winch',rotary:'shaft',linear:'slide',drumRadiusLdu:15,supportedSegments:3},5],
 ]){
  const m=model([['shaft','hinge','shaftbody'],['slide','slider','slidebody']],[mechanic]);
  const f=motor(m,{shaft:1});good(f);approx(q(f,'slide'),expected,.035);
 }
});
test('V7 open differential solves carrier and one wheel, constraining the second',()=>{
 const m=model([['carrier','hinge','case'],['left','hinge','leftshaft'],['right','hinge','rightshaft']],
  [{id:'diff',kind:'differential',carrier:'carrier',left:'left',right:'right'}]);
 const f=motor(m,{carrier:.3,right:.1});good(f);approx(q(f,'left'),.5,.003);
});
test('V7 cam profile drives springless ideal follower via lift and lobes',()=>{
 const m=model([['cam','hinge','camBody'],['follower','slider','followerBody']],
  [{id:'camDrive',kind:'cam-follower',cam:'cam',follower:'follower',liftLdu:12,lobes:2}]);
 const f=motor(m,{cam:.45});good(f);
 approx(q(f,'follower'),6*(1-Math.cos(.9)),.03);
});
test('V7 phase shifted cam is precisely neutral at the rest pose',()=>{
 const m=model([['cam','hinge','camBody'],['follower','slider','followerBody']],
  [{id:'camDrive',kind:'cam-follower',cam:'cam',follower:'follower',liftLdu:6,lobes:1,phaseRad:.5}]);
 good(motor(m,{cam:0}));
 const f=motor(m,{cam:.4});good(f);
 approx(q(f,'follower'),3*(Math.cos(.5)-Math.cos(.9)),.035);
});
test('V7 revolute joint stops accept interior and reject an overdriven input',()=>{
 const m=model([['arm','hinge','armBody']],[{id:'endstop',kind:'stop',joint:'arm',min:-.2,max:.3}]);
 const s=new SpatialMechanismSolver(m);good(s.solve({arm:.2}));
 const bad=s.solve({arm:.5});assert.equal(bad.status,'failed');
 assert(bad.residualByConstraint.get('mechanic:endstop')>.04);
 good(s.solve({arm:.1}));
});
test('V7 slider hard stops reject excessive rack travel',()=>{
 const m=model([['rack','slider','rackBody']],[{id:'stop',kind:'stop',joint:'rack',min:-5,max:5}]);
 const s=new SpatialMechanismSolver(m);good(s.solve({rack:4}));assert.equal(s.solve({rack:10}).status,'failed');
});
test('V7 one-way ratchet advances but refuses reverse and resets safely',()=>{
 const m=model([['pawl','hinge','ratchetWheel']],[{id:'oneway',kind:'ratchet',joint:'pawl',direction:'positive'}]);
 const s=new SpatialMechanismSolver(m);good(s.solve({pawl:.1}));good(s.solve({pawl:.3}));
 const reverse=s.solve({pawl:.12});assert.equal(reverse.status,'failed');
 assert(reverse.residualByConstraint.get('mechanic:oneway')>.04);
 good(s.solve({pawl:.35}));s.reset();good(s.solve({pawl:.12}));
});
test('V7 disabled one-way pawl permits reversed movement',()=>{
 const m=model([['pawl','hinge','ratchetWheel']],[{id:'oneway',kind:'ratchet',joint:'pawl',direction:'positive',engaged:false}]);
 const s=new SpatialMechanismSolver(m);good(s.solve({pawl:.3}));good(s.solve({pawl:-.3}));
});
test('V7 recognizes cylindrical, planar and universal spatial joints DoF',()=>{
 const b=[body('ground',P(),true),body('part')];
 const make=(kind,aa=P(0,0,1),bb=P(0,0,1))=>({bodies:b,constraints:[{id:'joint',kind,a:anchor('ground'),b:anchor('part'),axisA:aa,axisB:bb}]});
 const c=motor(make('cylindrical'),{});good(c);assert.equal(c.estimatedFreeDof,2);
 const p=motor(make('planar'),{});good(p);assert.equal(p.estimatedFreeDof,3);
 const u=motor(make('universal',P(0,0,1),P(1,0,0)),{});good(u);assert.equal(u.estimatedFreeDof,2);
});
test('V7 rejects contradictory gear cycles instead of fabricating shaft motion',()=>{
 const m=two();m.mechanics=[{id:'first',kind:'gear',input:'in',output:'out',inputTeeth:12,outputTeeth:24},
  {id:'second',kind:'belt',input:'in',output:'out',inputTeeth:12,outputTeeth:24}];
 const s=new SpatialMechanismSolver(m);
 assert.equal(s.solve({in:.35}).status,'failed');
});
test('V7 rejects malformed mechanic IDs, missing joint types and bad ratios',()=>{
 const m=two();m.mechanics=[{id:'invalid',kind:'rack-pinion',rotary:'in',linear:'out',pitchRadiusLdu:-2}];
 const err=validateSpatialModel(m).join(';');assert.match(err,/slider/);assert.match(err,/pitch radius/);
 const n=two();n.mechanics=[{id:'in',kind:'cv-joint',input:'in',output:'out'}];
 assert.match(validateSpatialModel(n).join(';'),/duplicate mechanical/);
 const bad=two();bad.mechanics=[{id:'bad',kind:'gear',input:'in',output:'out',inputTeeth:0,outputTeeth:24}];
 assert.match(validateSpatialModel(bad).join(';'),/input teeth/);
});
test('V7 overload test remains within explicit model size caps',()=>{
 const m=two();m.mechanics=Array.from({length:65},(_,i)=>({id:`x${i}`,kind:'cv-joint',input:'in',output:'out'}));
 assert.match(validateSpatialModel(m).join(';'),/at most 64/);
});
test('V7 gearbox and stopped closed four-bar solve together through a secondary crank',()=>{
 const path=require('path'),fs=require('fs');
 const example=JSON.parse(fs.readFileSync(path.join(__dirname,'../samples/mechanisms/gear-fourbar.v7-mechanics-rig.example.json'),'utf8'));
 const m=example.model;
 const solver=new SpatialMechanismSolver(m);
 for(const command of [0,.025,.06,.12,.18,.12,0,-.12,-.18,0]){
  const f=solver.solve({handwheel:command},{maxIterations:75});good(f);
  approx(q(f,'motor'),-command/2,.006);
  assert(f.residualByConstraint.get('rocker-ground')<.04);
  assert(f.residualByConstraint.get('mechanic:gear-train')<.04);
 }
 const invalid=solver.solve({handwheel:.7});assert.equal(invalid.status,'failed');
});
test('V7 cam-follower sample sweeps forward and backward without false contact claims',()=>{
 const path=require('path'),fs=require('fs');
 const example=JSON.parse(fs.readFileSync(path.join(__dirname,'../samples/mechanisms/cam-follower.v7-mechanics-rig.example.json'),'utf8'));
 const m=example.model;
 const {sweepSpatialLinkage}=load('src/anim/motion/v6/spatialSweep.ts');
 const sweep=sweepSpatialLinkage(m,'camAxle',.9,4);
 assert.equal(sweep.status,'sampled-pass',sweep.failures[0]?.reason);
 assert.equal(sweep.checkedSamples,17);
 assert.match(sweep.disclaimer,/rope tension/);
});
test('V7 ratchet sweep detects reversal but can pass a forward-only sweep',()=>{
 const {sweepSpatialLinkage}=load('src/anim/motion/v6/spatialSweep.ts');
 const m=model([['pawl','hinge','ratchetWheel']],[{id:'oneway',kind:'ratchet',joint:'pawl',direction:'positive'}]);
 const reverse=sweepSpatialLinkage(m,'pawl',.2,4);
 assert.equal(reverse.status,'sampled-fail');
 assert(reverse.checkedSamples<17);
 const forward=sweepSpatialLinkage(m,'pawl',.2,4,{mode:'forward'});
 assert.equal(forward.status,'sampled-pass',forward.failures[0]?.reason);
 assert.equal(forward.checkedSamples,5);
});
test('V7 sweep supports secondary motors and catches contradictory commands',()=>{
 const {sweepSpatialLinkage}=load('src/anim/motion/v6/spatialSweep.ts');
 const m=two();m.mechanics=[{id:'cv',kind:'cv-joint',input:'in',output:'out'}];
 const impossible=sweepSpatialLinkage(m,'in',.2,4,{additionalMotors:{out:0}});
 assert.equal(impossible.status,'sampled-fail');
 assert.throws(()=>sweepSpatialLinkage(m,'in',.2,4,{additionalMotors:{in:0}}),/override/);
});
test('V7 JSON fixture rejects unsupported or bogus mechanisms through core validation',()=>{
 const source=require('../samples/mechanisms/gear-fourbar.v7-mechanics-rig.example.json');
 const bad=JSON.parse(JSON.stringify(source.model));bad.mechanics[0].output='absent-shaft';
 assert.match(validateSpatialModel(bad).join(';'),/absent-shaft must reference/);
});
test('V7 geometry-screened spur gears attach to unambiguous spatial shaft bodies only',()=>{
 const {proposeSpatialMechanic}=load('src/anim/motion/v6/spatialMechanicProposal.ts');
 const m=two();
 const p={model:m,members:{ground:['frame'],shaft1:['tooth12'],shaft2:['tooth24']},driver:'in',kind:'hinge',source:'user-authored-json',warning:'review'};
 const candidate={id:'gear:tooth12:tooth24',kind:'gear',a:'tooth12',b:'tooth24',status:'plausible',confidence:'geometry-consistent-review-required',draft:{teethA:12,teethB:24,axis:P(0,0,1)},metrics:{separationLdu:45},reasons:[],evidence:'axis-and-bounds-screen'};
 const proposed=proposeSpatialMechanic(candidate,p);
 assert.equal(proposed.mechanic.kind,'gear');
 assert.equal(proposed.status,'needs-author-review');
 m.mechanics=[proposed.mechanic];
 const f=motor(m,{in:.2});good(f);approx(q(f,'out'),-.1,.004);
 assert.throws(()=>proposeSpatialMechanic({...candidate,status:'rejected'},p),/Only geometry-screened plausible/);
 assert.throws(()=>proposeSpatialMechanic({...candidate,b:'unknown'},p),/outside the active spatial rig/);
});
test('V7 spatial relation proposal refuses ambiguous same-body joints',()=>{
 const {proposeSpatialMechanic}=load('src/anim/motion/v6/spatialMechanicProposal.ts');
 const m=two();m.constraints.push({id:'duplicate',kind:'hinge',a:anchor('ground'),b:anchor('shaft1'),axisA:P(0,0,1),axisB:P(0,0,1)});
 const p={model:m,members:{ground:['frame'],shaft1:['tooth12'],shaft2:['tooth24']},driver:'in',kind:'hinge',source:'user-authored-json',warning:'review'};
 const c={id:'pair',kind:'gear',a:'tooth12',b:'tooth24',status:'plausible',confidence:'geometry-consistent-review-required',draft:{teethA:12,teethB:24}};
 assert.throws(()=>proposeSpatialMechanic(c,p),/expected exactly one hinge joint/);
});
test('V7 multi-turn CV-drive retains winding across two full revolutions',()=>{
 const m=two();m.mechanics=[{id:'coupling',kind:'cv-joint',input:'in',output:'out'}];
 const s=new SpatialMechanismSolver(m);
 for(let step=0;step<=48;step++){
  const angle=step*(4*Math.PI/48);
  const f=s.solve({in:angle},{maxIterations:75});
  good(f);approx(q(f,'in'),angle,.007);approx(q(f,'out'),angle,.007);
 }
});
test('V7 multi-turn screw actuator extends using full 2pi lead, not modulo 2pi',()=>{
 const m=model([['shaft','hinge','shaftBody'],['slide','slider','slideBody']],
  [{id:'drive',kind:'screw',rotary:'shaft',linear:'slide',leadLduPerTurn:8}]);
 const s=new SpatialMechanismSolver(m);
 for(let step=0;step<=36;step++){
  const angle=step*(3*Math.PI/36);
  const f=s.solve({shaft:angle});good(f);
  approx(q(f,'slide'),angle*8/(2*Math.PI),.045);
 }
});
test('V7 unwrapped drive jumps over pi rejected; reset restarts winding and pawl',()=>{
 const m=two();m.mechanics=[{id:'mesh',kind:'gear',input:'in',output:'out',inputTeeth:12,outputTeeth:24}];
 const s=new SpatialMechanismSolver(m);
 assert.throws(()=>s.solve({in:4}),/smaller steps/);
 good(s.solve({in:.2}));
 s.reset();good(s.solve({in:0}));approx(s.solve({in:0}).jointPositions.get('in'),0,.003);
});
test('V7 gearbox with 4:1 output preserves multiple shaft turns using incremental drives',()=>{
 const m=two();m.mechanics=[{id:'fast',kind:'gear',input:'in',output:'out',inputTeeth:40,outputTeeth:10}];
 const s=new SpatialMechanismSolver(m);
 for(let step=0;step<=30;step++){
  const angle=step*.15;
  const f=s.solve({in:angle},{maxIterations:80});
  good(f);approx(q(f,'out'),-4*angle,.02);
 }
});
test('V7 single-universal Cardan drive traverses one turn with varying angle ratio',()=>{
 const m=two();m.mechanics=[{id:'hooke',kind:'universal-drive',input:'in',output:'out',bendAngleRad:.6}];
 const s=new SpatialMechanismSolver(m);
 for(let step=0;step<=40;step++){
  const a=step*(2*Math.PI/40);
  const f=s.solve({in:a},{maxIterations:80});good(f);
  const expected=Math.atan2(Math.cos(.6)*Math.sin(a),Math.cos(a));
  approx(Math.sin(q(f,'out')),Math.sin(expected),.02);
 }
});
test('V7 forward-only sweep follows negative-direction pawl on a driven hinge',()=>{
 const {sweepSpatialLinkage}=load('src/anim/motion/v6/spatialSweep.ts');
 const m=model([['pawl','hinge','ratchetWheel']],[{id:'oneway',kind:'ratchet',joint:'pawl',direction:'negative'}]);
 const report=sweepSpatialLinkage(m,'pawl',.2,4,{mode:'forward'});
 assert.equal(report.status,'sampled-pass',report.failures[0]?.reason);
 assert.equal(report.checkedSamples,5);
});
test('V7 fixture import preserves mechanical relations and V6 legacy files remain valid',()=>{
 const {assembly}=require('./verify-v4-mechanisms-offline.cjs');
 const {parseSpatialRig,serializeSpatialRig}=load('src/anim/motion/v6/spatialRig.ts');
 const legacy=JSON.parse(require('fs').readFileSync(require('path').join(__dirname,
  '../samples/mechanisms/four-bar.spatial-rig.example.json'),'utf8'));
 const modern=JSON.parse(require('fs').readFileSync(require('path').join(__dirname,
  '../samples/mechanisms/gear-fourbar.v7-mechanics-rig.example.json'),'utf8'));
 const inst=assembly([['base',P()],['crank',P()],['coupler',P()],['rocker',P()],['driveShaft',P()]]);
 for(const [id]of Object.entries(legacy.members))legacy.members[id]=[id];
 for(const [id]of Object.entries(modern.members))modern.members[id]=[id];
 const older=parseSpatialRig(JSON.stringify(legacy),inst);assert.equal(older.model.mechanics,undefined);
 const newer=parseSpatialRig(JSON.stringify(modern),inst);assert.equal(newer.model.mechanics.length,2);
 const exported=JSON.parse(serializeSpatialRig(newer));
 assert.equal(exported.version,2);assert.equal(exported.format,'brickmotion-v7-mechanics-rig');
 assert.equal(parseSpatialRig(JSON.stringify(exported),inst).model.mechanics[0].kind,'gear');
});
test('V7 engageable clutch couples spatial shafts and releases them independently',()=>{
 const m=two();m.mechanics=[{id:'clutch',kind:'clutch',input:'in',output:'out',engaged:true}];
 const engaged=motor(m,{in:.22});good(engaged);approx(q(engaged,'out'),.22,.005);
 const conflict=motor(m,{in:.22,out:-.22});assert.equal(conflict.status,'failed');
 m.mechanics[0].engaged=false;
 const free=motor(m,{in:.22,out:-.22});good(free);approx(q(free,'out'),-.22,.004);
});
test('V7 holding brake locks a shaft and releases it when disengaged',()=>{
 const m=model([['arm','hinge','armBody']],[{id:'hold',kind:'brake',joint:'arm',engaged:true}]);
 const s=new SpatialMechanismSolver(m);
 assert.equal(s.solve({arm:.25}).status,'failed');
 m.mechanics[0].engaged=false;
 good(s.solve({arm:.25}));
});
test('V7 planetary gearbox follows Willis sun/ring/carrier relation with fixed ring',()=>{
 const m=model([['sun','hinge','sunBody'],['ring','hinge','ringBody'],['carrier','hinge','planetCarrier']],
  [{id:'planetary',kind:'planetary',sun:'sun',ring:'ring',carrier:'carrier',sunTeeth:20,ringTeeth:60},
   {id:'ringBrake',kind:'brake',joint:'ring',engaged:true}]);
 const f=motor(m,{sun:.6});good(f);
 approx(q(f,'ring'),0,.004);approx(q(f,'carrier'),.15,.004);
});
test('V7 bevel gear drive ratio couples perpendicular supported hinge axes by authored direction',()=>{
 const m=two();m.constraints[1].axisA=P(0,1,0);m.constraints[1].axisB=P(0,1,0);
 m.mechanics=[{id:'bevel',kind:'bevel-gear',input:'in',output:'out',inputTeeth:12,outputTeeth:36,reversed:true}];
 const f=motor(m,{in:.45});good(f);approx(q(f,'out'),-.15,.004);
});
test('V7 planetary parser refuses invalid ring-to-sun ratio and shared joints',()=>{
 const m=model([['sun','hinge','sunBody'],['ring','hinge','ringBody'],['carrier','hinge','planetCarrier']],
  [{id:'planet',kind:'planetary',sun:'sun',ring:'ring',carrier:'carrier',sunTeeth:60,ringTeeth:20}]);
 assert.match(validateSpatialModel(m).join(';'),/more teeth than the sun/);
 m.mechanics[0].ring='sun';assert.match(validateSpatialModel(m).join(';'),/three distinct shafts/);
});
if(process.exitCode)process.exit(process.exitCode);

test('V7 wheel rolling transfers shaft turns to chassis translation without assuming tire force',()=>{
 const m=model([['wheel','hinge','tyre'],['travel','slider','chassis']],
  [{id:'roll',kind:'wheel-rolling',rotary:'wheel',linear:'travel',wheelRadiusLdu:14}]);
 const f=motor(m,{wheel:.25});good(f);approx(q(f,'travel'),3.5,.03);
 assert(f.residualByConstraint.get('mechanic:roll')<.04);
 const backwards=model([['wheel','hinge','tyre'],['travel','slider','chassis']],
  [{id:'roll',kind:'wheel-rolling',rotary:'wheel',linear:'travel',wheelRadiusLdu:14,reversed:true}]);
 const b=motor(backwards,{wheel:.2});good(b);approx(q(b,'travel'),-2.8,.03);
});

test('V7 Ackermann steering coordinates inner/outer front wheels in one spatial solve',()=>{
 const m=model([['steer','hinge','column'],['left','hinge','kingpinL'],['right','hinge','kingpinR']],
  [{id:'ackermann',kind:'ackermann-steering',input:'steer',left:'left',right:'right',wheelbaseLdu:80,trackWidthLdu:40}]);
 const s=new SpatialMechanismSolver(m);
 for(const command of [0,.1,.2,.3,.1,-.1,-.25]){
  const f=s.solve({steer:command});good(f);
  const expectedLeft=Math.atan2(80*Math.sin(command),80*Math.cos(command)-20*Math.sin(command));
  const expectedRight=Math.atan2(80*Math.sin(command),80*Math.cos(command)+20*Math.sin(command));
  approx(q(f,'left'),expectedLeft,.004);approx(q(f,'right'),expectedRight,.004);
  assert(f.residualByConstraint.get('mechanic:ackermann:left')<.04);
  assert(f.residualByConstraint.get('mechanic:ackermann:right')<.04);
 }
});

test('V7 steering and wheel mechanisms reject invalid topology and dimensions',()=>{
 const m=model([['steer','hinge','column'],['left','hinge','kingpinL'],['right','hinge','kingpinR']],
  [{id:'steering',kind:'ackermann-steering',input:'steer',left:'left',right:'steer',wheelbaseLdu:0,trackWidthLdu:40}]);
 assert.match(validateSpatialModel(m).join(';'),/three distinct shaft joints/);
 assert.match(validateSpatialModel(m).join(';'),/wheelbase/);
 const b=model([['wheel','hinge','tyre'],['travel','slider','chassis']],
  [{id:'roll',kind:'wheel-rolling',rotary:'wheel',linear:'travel',wheelRadiusLdu:-1}]);
 assert.match(validateSpatialModel(b).join(';'),/wheel radius/);
});

test('V7 example steering and wheel-rolling network solves two independent motor commands',()=>{
 const {model:m}=require('../samples/mechanisms/vehicle-steering-rolling.v7-mechanics-rig.example.json');
 const s=new SpatialMechanismSolver(m);
 const f=s.solve({steerColumn:.25,wheelDrive:.4});good(f);
 approx(q(f,'chassisTravel'),8,.04);
 assert(q(f,'steerLeft')>q(f,'steerRight'));
 assert.equal(s.solve({steerColumn:.8,wheelDrive:.4}).status,'failed');
});
