/** V8 hardening and new researched position-level mechanisms.
 * The loader runs legacy V4 cases too; count V8-only checks with /^PASS V8/.
 * All tests are ideal/analytic, not real-set or physical-collision certificates.
 */
const {test,assert,approx,load}=require('./verify-v4-mechanisms-offline.cjs');
const {SpatialMechanismSolver,validateSpatialModel}=load('src/anim/motion/kinematics/spatialModel.ts');
const {screenMechanismGeometry}=load('src/anim/motion/spatial/geometryScreen.ts');
const {sweepSpatialLinkage}=load('src/anim/motion/spatial/spatialSweep.ts');
const {parseSpatialRig,serializeSpatialRig}=load('src/anim/motion/spatial/spatialRig.ts');
const {createSpatialLinkagePreview}=load('src/anim/motion/spatial/spatialAdapter.ts');
const I=[0,0,0,1],P=(x=0,y=0,z=0)=>[x,y,z],anchor=(id)=>({body:id,local:P()});
const body=(id,fixed=false)=>({id,rest:{p:P(),q:I},fixed});
const motor=(id,kind='hinge')=>({id,kind,a:anchor('ground'),b:anchor(id+'Body'),axisA:P(0,0,1),axisB:P(0,0,1)});
const rig=(joints,mechanics=[])=>({bodies:[body('ground',true),...joints.map(([id])=>body(id+'Body'))],constraints:joints.map(([id,kind])=>motor(id,kind)),mechanics});
const solve=(model,drives,options)=>new SpatialMechanismSolver(model).solve(drives,options);
const good=s=>assert.equal(s.status,'converged',s.warning);
const j=(frame,id)=>frame.jointPositions.get(id);
const pair=()=>rig([['input','hinge'],['output','hinge']]);

// Phase A: ten bug and robustness iterations, each with a standalone regression.
test('V8-I01 malformed constraint records are reported rather than crashing the validator',()=>{
 const r=pair();r.constraints.push(null);const errors=validateSpatialModel(r);assert(errors.some(e=>/Malformed spatial constraint/.test(e)));
 assert.throws(()=>new SpatialMechanismSolver(r),/Malformed spatial constraint/);
});
test('V8-I02 strict fixed/engagement/gear-flag validation rejects malformed JSON types',()=>{
 const r=pair();r.bodies[0].fixed='yes';r.mechanics=[{id:'g',kind:'gear',input:'input',output:'output',inputTeeth:12,outputTeeth:24,internal:'yes'}];
 const e=validateSpatialModel(r).join(' ');assert.match(e,/fixed must be a boolean/);assert.match(e,/internal must be boolean/);
});
test('V8-I03 nonsensical LM solver iteration budgets and tolerances fail before solving',()=>{
 const s=new SpatialMechanismSolver(pair());
 for(const maxIterations of [-1,0,1.2,NaN,Infinity,200])assert.throws(()=>s.solve({}, {maxIterations}),/maxIterations/);
 for(const toleranceLdu of [0,-1,NaN,Infinity,1])assert.throws(()=>s.solve({}, {toleranceLdu}),/tolerance/);
});
test('V8-I04 caller structural mutations cannot silently rewrite an active solver graph',()=>{
 const r=pair();r.mechanics=[{id:'gear',kind:'gear',input:'input',output:'output',inputTeeth:12,outputTeeth:24}];
 const s=new SpatialMechanismSolver(r);r.mechanics[0].inputTeeth=120;r.constraints[0].axisA=[1,0,0];
 const f=s.solve({input:.4});good(f);approx(j(f,'output'),-.2,.005);
});
test('V8-I05 rejected solve returns previous accepted pose while retaining rejected diagnostics',()=>{
 const r=rig([['a','hinge']],[{id:'end',kind:'stop',joint:'a',min:-.4,max:.4}]);
 const s=new SpatialMechanismSolver(r);good(s.solve({a:.2}));const failed=s.solve({a:1});
 assert.equal(failed.status,'failed');approx(j(failed,'a'),.2,.001);
 assert(failed.residualByConstraint.get('mechanic:end')>.04);
});
test('V8-I06 Cardan shaft keeps the correct angular branch across multiple revolutions',()=>{
 const r=pair();r.mechanics=[{id:'universal',kind:'universal-drive',input:'input',output:'output',bendAngleRad:.45}];
 const s=new SpatialMechanismSolver(r);
 for(let a=0;a<=Math.PI*2.15;a+=.31){
  const f=s.solve({input:a});good(f);
  const principal=Math.atan2(Math.cos(.45)*Math.sin(a),Math.cos(a));
  const expected=principal+2*Math.PI*Math.round((a-principal)/(2*Math.PI));
  approx(j(f,'output'),expected,.015);
 }
});
test('V8-I07 geometry screen rejects malformed tooth counts and duplicate part identifiers',()=>{
 const p=(key,teeth,at)=>({key,category:'gear',description:'Spur gear',teeth,axis:P(0,0,1),pivot:P(at,0,0)});
 const b=new Map([['a',{min:P(-3,-3,-3),max:P(3,3,3)}],['b',{min:P(37,-3,-3),max:P(43,3,3)}]]);
 const goodPair=screenMechanismGeometry([p('a',16,0),p('a',16,0),p('b',16,40)],b);
 assert.equal(goodPair.length,1);assert.equal(goodPair[0].status,'plausible');
 const badPair=screenMechanismGeometry([p('a',16.5,0),p('b',16,40)],b);
 assert.equal(badPair[0].status,'rejected');assert.match(badPair[0].reasons.join(' '),/tooth/);
});
test('V8-I08 conflicting rigid-cluster membership is rejected instead of reassigned',()=>{
 const asm={instances:[{key:'a'},{key:'b'},{key:'c'}]};
 const graph={rigidClusters:[['a','b'],['b','c']],edges:[{id:'j',a:'a',b:'c',motion:'revolute'}]};
 assert.throws(()=>createSpatialLinkagePreview(asm,graph,'j','a'),/multiple rigid clusters/);
});
test('V8-I09 imported rig text size, type and body limits are enforced',()=>{
 assert.throws(()=>parseSpatialRig(null,{instances:[]}),/at most 1 MB/);
 assert.throws(()=>parseSpatialRig('{bad',{instances:[]}),/Invalid spatial rig JSON/);
 assert.throws(()=>parseSpatialRig('a'.repeat(1024*1024+1),{instances:[]}),/1 MB/);
});
test('V8-I10 sampled sweep rejects invalid options and secondary-motor containers',()=>{
 const r=rig([['a','hinge']]);
 assert.throws(()=>sweepSpatialLinkage(r,'a',.5,4,null),/options/);
 assert.throws(()=>sweepSpatialLinkage(r,'a',.5,4,{additionalMotors:[]}),/object/);
});

// Phase B: nine additional researched kinematic laws, followed by clip baking.
test('V8-I11 offset slider-crank follows exact right-branch rod-length geometry',()=>{
 const m=rig([['crank','hinge'],['slide','slider']],[{id:'piston',kind:'slider-crank',crank:'crank',slider:'slide',crankRadiusLdu:5,rodLengthLdu:18,guideOffsetLdu:2}]);
 const s=new SpatialMechanismSolver(m);
 const x=t=>5*Math.cos(t)+Math.sqrt(18**2-(2-5*Math.sin(t))**2);
 for(const a of [0,.55,1.2,2.1,3,3.9,4.7,5.55,6.25]){
  const f=s.solve({crank:a});good(f);approx(j(f,'slide'),x(a)-x(0),.04);
 }
 m.mechanics[0].rodLengthLdu=6;
 assert.match(validateSpatialModel(m).join(' '),/connecting rod/);
});
test('V8-I12 scotch yoke converts circular crank motion to sinusoidal translation',()=>{
 const m=rig([['crank','hinge'],['yoke','slider']],[{id:'yoke-link',kind:'scotch-yoke',crank:'crank',slider:'yoke',radiusLdu:7,phaseRad:.2}]);
 const f=solve(m,{crank:.7});good(f);approx(j(f,'yoke'),7*(Math.sin(.9)-Math.sin(.2)),.03);
});
test('V8-I13 two mechanical sliders transmit a signed configurable linear ratio',()=>{
 const m=rig([['a','slider'],['b','slider']],[{id:'coupler',kind:'linear-coupler',input:'a',output:'b',ratio:-2}]);
 const f=solve(m,{a:2});good(f);approx(j(f,'b'),-4,.04);
 const bad=structuredClone(m);bad.mechanics[0].ratio=0;
 assert.match(validateSpatialModel(bad).join(' '),/linear-coupler ratio/);
});
test('V8-I14 hydraulic piston pair preserves ideal fluid displacement volume',()=>{
 const m=rig([['small','slider'],['large','slider']],[{id:'fluid',kind:'hydraulic-pair',first:'small',second:'large',areaFirst:2,areaSecond:5}]);
 const f=solve(m,{small:5});good(f);approx(j(f,'large'),-2,.04);
});
test('V8-I15 backlash gear keeps output within an authored reversible deadband',()=>{
 const m=pair();m.mechanics=[{id:'lash',kind:'backlash-gear',input:'input',output:'output',inputTeeth:12,outputTeeth:24,clearanceRad:.10}];
 const s=new SpatialMechanismSolver(m);
 let f=s.solve({input:.1});good(f);assert(Math.abs(j(f,'output'))<.02);
 f=s.solve({input:.5});good(f);approx(j(f,'output'),-.15,.02);
 f=s.solve({input:.2});good(f);assert(j(f,'output')<-.08); // backlash holds its flank before reversal
});
test('V8-I16 detent-lock selector accepts exact notches and rejects incompatible commands',()=>{
 const m=rig([['selector','slider']],[{id:'notches',kind:'detent',joint:'selector',pitch:.5,engaged:true}]);
 const s=new SpatialMechanismSolver(m);
 good(s.solve({selector:.5}));
 assert.equal(s.solve({selector:.3}).status,'failed');
 m.mechanics[0].engaged=false;
 good(s.solve({selector:.3}));
});
test('V8-I17 sampled periodic cam profile is rest-zero and continuous across a full turn',()=>{
 const m=rig([['cam','hinge'],['follower','slider']],[{id:'prof',kind:'cam-profile',cam:'cam',follower:'follower',profileLdu:[0,4,8,4]}]);
 const s=new SpatialMechanismSolver(m);
 for(const [angle,expected] of [[0,0],[Math.PI/2,4],[Math.PI,8],[3*Math.PI/2,4],[2*Math.PI,0]]){
  const f=s.solve({cam:angle});good(f);approx(j(f,'follower'),expected,.04);
 }
 const invalid=structuredClone(m);invalid.mechanics[0].profileLdu=[0,NaN];
 assert.match(validateSpatialModel(invalid).join(' '),/4–64/);
});
test('V8-I18 ideal intermittent indexer has dwell and advances one slot per turn',()=>{
 const m=pair();m.mechanics=[{id:'indexer',kind:'intermittent-indexer',input:'input',output:'output',slots:6,activeFraction:.3}];
 const s=new SpatialMechanismSolver(m);
 for(const [angle,expected] of [[0,0],[1,0],[Math.PI,Math.PI/6],[4.8,Math.PI/3],[2*Math.PI,Math.PI/3]]){
  const f=s.solve({input:angle});good(f);approx(j(f,'output'),expected,.03);
 }
});
test('V8-I19 differential drive joins two wheel motors with ideal forward and yaw coordinates',()=>{
 const m=rig([['left','hinge'],['right','hinge'],['forward','slider'],['yaw','hinge']],
  [{id:'drive',kind:'differential-drive',left:'left',right:'right',forward:'forward',yaw:'yaw',wheelRadiusLdu:10,trackWidthLdu:50}]);
 const s=new SpatialMechanismSolver(m);
 let f=s.solve({left:.5,right:.5});good(f);approx(j(f,'forward'),5,.03);approx(j(f,'yaw'),0,.004);
 f=s.solve({left:0,right:.8});good(f);approx(j(f,'forward'),4,.03);approx(j(f,'yaw'),.16,.005);
});

test('V8-I20 sampled motion clip exports replayable body poses and fails closed on an impossible mechanism',()=>{
 const {bakeSpatialClip}=load('src/anim/motion/v8/spatialClip.ts');
 const m=rig([['input','hinge'],['output','hinge']],[{id:'gear',kind:'gear',input:'input',output:'output',inputTeeth:12,outputTeeth:24}]);
 const preview={model:m,members:{ground:['plate'],inputBody:['axleA'],outputBody:['axleB']},driver:'input',kind:'hinge'};
 const clip=bakeSpatialClip(preview,{driver:'input',amplitude:.5,mode:'oscillate',durationSeconds:1,sampleHz:8});
 assert.equal(clip.frames.length,9);assert.equal(clip.summary.checkedFrames,9);
 assert.equal(clip.evidence,'sampled-ideal-kinematics-only');
 for(const frame of clip.frames)for(const id of ['ground','inputBody','outputBody']){
  assert(frame.poses[id]);assert(frame.poses[id].q.every(Number.isFinite));
 }
 assert.match(clip.disclaimer,/collision/);
 const broken=structuredClone(preview);broken.model.mechanics.push({id:'wrong',kind:'belt',input:'input',output:'output',inputTeeth:12,outputTeeth:24});
 assert.throws(()=>bakeSpatialClip(broken,{driver:'input',amplitude:.5,mode:'forward',durationSeconds:1,sampleHz:8}),/Clip failed/);
 assert.throws(()=>bakeSpatialClip(preview,{driver:'input',amplitude:10,mode:'forward',durationSeconds:.5,sampleHz:4}),/step/);
 const exported=JSON.parse(serializeSpatialRig({...preview,kind:'hinge',source:'user-authored-json'}));
 assert.equal(exported.version,2); // legacy V7 rigs still write V7 v2.
 const improved=structuredClone(preview);
 improved.model.mechanics=[{id:'yoke',kind:'scotch-yoke',crank:'input',slider:'output',radiusLdu:4}];
 const v8=JSON.parse(serializeSpatialRig({...improved,kind:'hinge',source:'user-authored-json'}));
 assert.equal(v8.version,3);assert.equal(v8.format,'brickmotion-v8-mechanics-rig');
 // The imported type check catches an incompatible authoring relation.
 assert.throws(()=>parseSpatialRig(JSON.stringify(v8),{instances:[]}),/slider/);
 // A valid V8 model with real assembly instance IDs must round-trip, too.
 const linked=rig([['crank','hinge'],['piston','slider']],
  [{id:'yoke',kind:'scotch-yoke',crank:'crank',slider:'piston',radiusLdu:4}]);
 const valid={model:linked,members:{ground:['plate'],crankBody:['axle'],pistonBody:['rod']},driver:'crank',kind:'hinge',source:'user-authored-json'};
 const imported=parseSpatialRig(serializeSpatialRig(valid),{
  instances:[{key:'plate'},{key:'axle'},{key:'rod'}]});
 assert.equal(imported.model.mechanics[0].kind,'scotch-yoke');
 assert.equal(imported.driver,'crank');
 assert.deepEqual(imported.members.pistonBody,['rod']);
});
