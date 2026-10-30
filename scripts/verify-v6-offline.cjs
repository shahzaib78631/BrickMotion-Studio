/** Offline V6 mathematical/geometry regression suite. No browser/WebGL/npm dependency.
 * Tests synthetic known configurations, NOT the real Kinebrick official-set corpus. */
const {test,assert,approx,load,assembly}=require('./verify-v4-mechanisms-offline.cjs');
const {SpatialMechanismSolver,validateSpatialModel}=load('src/anim/motion/kinematics/spatialModel.ts');
const {screenMechanismGeometry}=load('src/anim/motion/spatial/geometryScreen.ts');
const {createSpatialLinkagePreview}=load('src/anim/motion/spatial/spatialAdapter.ts');
const {sweepSpatialLinkage}=load('src/anim/motion/spatial/spatialSweep.ts');
const {parseSpatialRig,serializeSpatialRig}=load('src/anim/motion/spatial/spatialRig.ts');
const {MechanismSolver}=load('src/anim/motion/v4/mechanismSolver.ts');
const {composeTransmissionProgram}=load('src/anim/motion/v4/transmissionComposer.ts');
const {validateMechanismProgram}=load('src/anim/motion/v4/mechanismProgram.ts');
const I=[0,0,0,1],V=(x,y,z)=>[x,y,z];
const body=(id,p,fixed=false)=>({id,rest:{p,q:I},fixed});
const point=(body,local)=>({body,local});
const hinge=(id,a,pa,b,pb)=>({id,kind:'hinge',a:point(a,pa),b:point(b,pb),axisA:V(0,0,1),axisB:V(0,0,1)});
const solve=(m,d)=>new SpatialMechanismSolver(m).solve(d);
const named=(k,axis,pivot,teeth,description)=>({key:k,category:'gear',description,teeth,axis,pivot});
const bounds=(cx=0,cy=0,cz=0,h=4)=>({min:V(cx-h,cy-h,cz-h),max:V(cx+h,cy+h,cz+h)});
const boxes=(...entries)=>new Map(entries);

test('V6 spatial hinge has five constraints and one independent motor',()=>{
 const model={bodies:[body('frame',V(0,0,0),true),body('arm',V(10,0,0))],
 constraints:[hinge('pin','frame',V(0,0,0),'arm',V(-10,0,0))]};
 const solution=solve(model,{pin:.3});
 assert.equal(solution.status,'converged',solution.warning);
 assert(solution.maxResidualLdu<.04);approx(solution.poses.get('arm').p[0],10*Math.cos(.3),.04);
 approx(solution.poses.get('arm').p[1],10*Math.sin(.3),.04);
 assert.equal(solution.estimatedFreeDof,0);
});
test('V6 4-bar spatial closed linkage follows imposed crank angle and all four hinges close',()=>{
 const m={bodies:[body('base',V(0,0,0),true),body('crank',V(0,10,0)),
 body('coupler',V(30,20,0)),body('rocker',V(60,10,0))],constraints:[
 hinge('motor','base',V(0,0,0),'crank',V(0,-10,0)),
 hinge('crank-coupler','crank',V(0,10,0),'coupler',V(-30,0,0)),
 hinge('coupler-rocker','coupler',V(30,0,0),'rocker',V(0,10,0)),
 hinge('rocker-ground','rocker',V(0,-10,0),'base',V(60,0,0)),
 ]};
 const solver=new SpatialMechanismSolver(m);
 for(const angle of [.015,.05,.09,.15,.18,.1,0]){
  const f=solver.solve({motor:angle});
  assert.equal(f.status,'converged',`crank=${angle} err=${f.maxResidualLdu} ${f.warning||''}`);
  assert(f.maxResidualLdu<.04);
  assert(f.residualByConstraint.get('rocker-ground')<.04);
 }
 const rest=solver.solve({motor:0});
 approx(rest.poses.get('coupler').p[0],30,.08);
});
test('V6 slider maintains orientation and moves exactly along guide',()=>{
 const m={bodies:[body('frame',V(0,0,0),true),body('sled',V(0,0,0))],constraints:[{
  id:'rail',kind:'slider',a:point('frame',V(0,0,0)),b:point('sled',V(0,0,0)),
  axisA:V(1,0,0),axisB:V(1,0,0),
 }]};
 const f=solve(m,{rail:8});assert.equal(f.status,'converged',f.warning);
 approx(f.poses.get('sled').p[0],8,.03);approx(f.poses.get('sled').p[1],0,.03);
 approx(f.poses.get('sled').q[3],1,.002);
});
test('V6 weld blocks a driven hinge and preserves last successful state',()=>{
 const m={bodies:[body('frame',V(0,0,0),true),body('arm',V(10,0,0))],
 constraints:[hinge('pin','frame',V(0,0,0),'arm',V(-10,0,0)),{id:'weld',kind:'weld',a:'frame',b:'arm'}]};
 const solver=new SpatialMechanismSolver(m);
 assert.equal(solver.solve({pin:0}).status,'converged');
 const f=solver.solve({pin:.35});assert.equal(f.status,'failed');
 assert(f.maxResidualLdu>.04);assert(/cannot close/i.test(f.warning));
 assert.equal(solver.solve({pin:0}).status,'converged');
});
test('V6 refuses free-floating mechanism and invalid anchors',()=>{
 const m={bodies:[body('a',V(0,0,0)),body('b',V(0,0,0))],constraints:[hinge('h','a',V(0,0,0),'b',V(0,0,0))]};
 assert(validateSpatialModel(m).some(e=>/Unanchored/.test(e)));
 assert.throws(()=>new SpatialMechanismSolver(m),/Unanchored/);
 m.bodies[0].fixed=true;m.constraints[0].b.body='missing';
 assert(validateSpatialModel(m).some(e=>/distinct existing bodies/.test(e)));
});
test('V6 detects geometry-consistent spur mesh only with valid pitch and axes',()=>{
 const a=named('gear8',V(0,0,1),V(0,0,0),8,'Gear 8 Tooth');
 const b=named('gear24',V(0,0,1),V(40,0,0),24,'Gear 24 Tooth');
 const pass=screenMechanismGeometry([a,b],boxes(['gear8',bounds(0,0,0)],['gear24',bounds(40,0,0)]));
 assert.equal(pass.length,1);assert.equal(pass[0].status,'plausible');
 assert.equal(pass[0].draft.teethA,8);assert.equal(pass[0].draft.teethB,24);
 const wrong={...b,pivot:V(45,0,0)};
 const rejected=screenMechanismGeometry([a,wrong],boxes(['gear8',bounds()],['gear24',bounds(45,0,0)]));
 assert.equal(rejected[0].status,'rejected');assert(rejected[0].reasons.some(s=>/Pitch/.test(s)));
});
test('V6 rejects perpendicular spur axes and fixed-cluster transmission',()=>{
 const a=named('gear8',V(0,0,1),V(0,0,0),8,'Gear 8 Tooth');
 const b=named('gear24',V(1,0,0),V(40,0,0),24,'Gear 24 Tooth');
 const boundsMap=boxes(['gear8',bounds()],['gear24',bounds(40,0,0)]);
 const out=screenMechanismGeometry([a,b],boundsMap);
 assert.equal(out[0].status,'rejected');assert(out[0].reasons.some(s=>/parallel/.test(s)));
 b.axis=V(0,0,1);
 const welded=screenMechanismGeometry([a,b],boundsMap,[['gear8','gear24']]);
 assert.equal(welded[0].status,'rejected');assert(welded[0].reasons.some(s=>/same rigid/.test(s)));
});
test('V6 rack detector requires tangent alignment and recorded pinion pitch',()=>{
 const gear=named('gear16',V(0,0,1),V(0,0,0),16,'Gear 16 Tooth');
 const rack={key:'rack',category:'other',description:'Technic Rack 1x6'};
 const good=screenMechanismGeometry([gear,rack],boxes(['gear16',bounds()],['rack',{
  min:V(-45,17,-2),max:V(45,23,2),
 }]));
 assert.equal(good[0].status,'plausible',good[0].reasons.join(','));
 approx(good[0].draft.pitchRadiusLdu,20);
 const bad=screenMechanismGeometry([gear,rack],boxes(['gear16',bounds()],['rack',{
  min:V(-3,-25,-2),max:V(3,65,2),
 }]));
 assert.equal(bad[0].status,'rejected');assert(bad[0].reasons.some(s=>/tangent/.test(s)));
});
test('V6 worm screen rejects parallel shafts and supports perpendicular proposal',()=>{
 const worm={...named('worm',V(1,0,0),V(0,0,0),undefined,'Worm Gear 1 start')};
 const gear=named('gear24',V(0,1,0),V(0,0,30),24,'Gear 24 Tooth');
 const bmap=boxes(['worm',bounds()],['gear24',bounds(0,0,30)]);
 const good=screenMechanismGeometry([worm,gear],bmap);
 assert.equal(good[0].status,'plausible',good[0].reasons.join(','));
 assert.equal(good[0].draft.starts,1);
 const rejected=screenMechanismGeometry([worm,{...gear,axis:V(1,0,0)}],bmap);
 assert.equal(rejected[0].status,'rejected');
});
test('V6 wheel-ground coupling correctly translates and carries the rotating wheel',()=>{
 const a=assembly([['wheel',[0,0,0]],['chassis',[0,0,0]]]);
 const network=composeTransmissionProgram(a,{rigidClusters:[]},[],[{kind:'wheel-ground',
  a:'wheel',b:'chassis',axis:V(0,0,1),travelAxis:V(1,0,0),radiusLdu:20}]);
 const w=network.joints.find(j=>j.body==='wheel'),chassis=network.joints.find(j=>j.body==='chassis');
 assert.equal(w.parent,'chassis');assert.equal(chassis.kind,'prismatic');
 assert.equal(validateMechanismProgram(network).length,0);
 const f=new MechanismSolver(a,network).solve(Math.PI/2);
 approx(f.joints.get(chassis.id),-10*Math.PI);
 approx(f.poses.get('wheel').elements[12],-10*Math.PI,.0001);
 approx(f.poses.get('chassis').elements[12],-10*Math.PI,.0001);
});
test('V6 wheel-ground rejects parallel travel axis and invalid wheel radius',()=>{
 const a=assembly([['wheel'],['chassis']]);
 assert.throws(()=>composeTransmissionProgram(a,{rigidClusters:[]},[],[{kind:'wheel-ground',
  a:'wheel',b:'chassis',axis:V(0,0,1),travelAxis:V(0,0,1),radiusLdu:20}]),/perpendicular/);
 const p={mode:'kinematic',duration:2,driver:{joint:'a',amplitude:.1},
  joints:[{id:'a',body:'wheel',kind:'revolute',axis:V(0,0,1),pivot:V(0,0,0)},
   {id:'b',body:'chassis',kind:'prismatic',axis:V(1,0,0)}],
  transmissions:[{id:'wheel',kind:'wheel-ground',a:'a',b:'b',radiusLdu:-5,source:'user'}]};
 assert(validateMechanismProgram(p).some(e=>/wheel radius/.test(e)));
});

// Use actual graph-shape and assembly-shape structures: the adapter must not
// invent missing grounds or silently drop a connected moving member.
const graphEdge=(id,a,b,centre,axis=V(0,0,1),motion='revolute')=>({
 id,a,b,centre,axis,motion,type:'axle-hole',source:'ldcad-shadow',joint:{id},
});
const graph=(edges,clusters)=>({edges,rigidClusters:clusters,uncertainBodies:[],byBody:new Map(),
 mobility(){throw Error('not needed');},isMate(){return false;}});
const placed=(keys)=>{
 const out=assembly(keys);
 for(const i of out.instances){const p=i.world.elements.slice(12,15);i.worldBox=bounds(...p,1);}
 return out;
};
test('V6 adapter follows LDCad rigid clusters and requires real explicit ground',()=>{
 const a=placed([['frame',V(0,0,0)],['arm',V(10,0,0)],['bolt',V(10,0,0)]]);
 const g=graph([graphEdge('pin','frame','arm',V(0,0,0))],[['frame'],['arm','bolt']]);
 const preview=createSpatialLinkagePreview(a,g,'pin','frame');
 assert.equal(preview.model.bodies.length,2);
 assert.equal(preview.model.bodies.find(b=>b.fixed).id,'frame');
 assert.deepEqual(preview.members.arm,['arm','bolt']);
 assert.equal(preview.source,'ldcad-shadow-review');
 const f=new SpatialMechanismSolver(preview.model).solve({pin:.1});
 assert.equal(f.status,'converged',f.warning);
 assert.throws(()=>createSpatialLinkagePreview(a,g,'pin','absent'),/real placed part/);
 assert.throws(()=>createSpatialLinkagePreview(a,g,'wrong','frame'),/real detected/);
});
test('V6 adapter includes entire moving component and rejects unsupported large networks',()=>{
 const a=placed(Array.from({length:16},(_,i)=>['p'+i,V(i*10,0,0)]));
 const g=graph(Array.from({length:15},(_,i)=>graphEdge('j'+i,'p'+i,'p'+(i+1),V(i*10,0,0))),[]);
 assert.throws(()=>createSpatialLinkagePreview(a,g,'j0','p0'),/over 13 rigid bodies/);
});
test('V6 adapter retains distinct closed-joint pins but collapses duplicate snaps',()=>{
 const a=placed([['frame',V(0,0,0)],['arm',V(10,0,0)]]);
 const g=graph([graphEdge('a','frame','arm',V(0,0,0)),graphEdge('b','frame','arm',V(.1,0,0))],[]);
 const p=createSpatialLinkagePreview(a,g,'a','frame');
 assert.equal(p.model.constraints.length,1);
 assert.equal(p.driver,'a');
 const other=graph([graphEdge('a','frame','arm',V(0,0,0)),graphEdge('b','frame','arm',V(4,0,0))],[]);
 const q=createSpatialLinkagePreview(a,other,'a','frame');
 assert.equal(q.model.constraints.length,2);
});
test('V6 33-frame spatial cycle sweep passes rotating pinned arm and identifies failed locked arm',()=>{
 const m={bodies:[body('frame',V(0,0,0),true),body('arm',V(10,0,0))],
  constraints:[hinge('pin','frame',V(0,0,0),'arm',V(-10,0,0))]};
 const result=sweepSpatialLinkage(m,'pin',.35);
 assert.equal(result.status,'sampled-pass');assert.equal(result.checkedSamples,33);
 assert.equal(result.worstConstraint!==null,true);assert(result.maxResidualLdu<.04);
 const locked={...m,constraints:[...m.constraints,{id:'weld',kind:'weld',a:'frame',b:'arm'}]};
 const failure=sweepSpatialLinkage(locked,'pin',.35);
 assert.equal(failure.status,'sampled-fail');assert(failure.checkedSamples<33);
 assert.equal(failure.failures.length,1);
});
test('V6 sampled sweep rejects invalid amplitude and preserves evidence disclaimers',()=>{
 const m={bodies:[body('frame',V(0,0,0),true),body('arm',V(10,0,0))],
  constraints:[hinge('pin','frame',V(0,0,0),'arm',V(-10,0,0))]};
 assert.throws(()=>sweepSpatialLinkage(m,'pin',Infinity),/amplitude/);
 assert.throws(()=>sweepSpatialLinkage(m,'pin',.1,100),/subdivisions/);
 const report=sweepSpatialLinkage(m,'pin',.2,2);
 assert.match(report.disclaimer,/No continuous collision/);
});


test('V6 simultaneously solves two independent driven hinges on one grounded frame',()=>{
 const m={bodies:[body('frame',V(0,0,0),true),body('left',V(-20,0,0)),body('right',V(20,0,0))],constraints:[
  hinge('left-hinge','frame',V(-20,0,0),'left',V(0,0,0)),
  hinge('right-hinge','frame',V(20,0,0),'right',V(0,0,0)),
 ]};
 const f=solve(m,{'left-hinge':.2,'right-hinge':-.25});
 assert.equal(f.status,'converged',f.warning);
 approx(f.poses.get('left').q[2],Math.sin(.2/2),.002);
 approx(f.poses.get('right').q[2],Math.sin(-.25/2),.002);
 assert.equal(f.estimatedFreeDof,0);
});
test('V6 ball joint has three rotational freedoms, distance link has five',()=>{
 const m={bodies:[body('frame',V(0,0,0),true),body('ball',V(10,0,0))],
  constraints:[{id:'socket',kind:'ball',a:point('frame',V(0,0,0)),b:point('ball',V(-10,0,0))}]};
 const b=solve(m,{});assert.equal(b.status,'converged');assert.equal(b.estimatedFreeDof,3);
 const rod={...m,constraints:[{id:'rod',kind:'distance',a:point('frame',V(0,0,0)),b:point('ball',V(0,0,0)),lengthLdu:10}]};
 const d=solve(rod,{});assert.equal(d.status,'converged');assert.equal(d.estimatedFreeDof,5);
});
test('V6 motor references cannot accidentally lie along their joint axis',()=>{
 const m={bodies:[body('frame',V(0,0,0),true),body('arm',V(10,0,0))],
  constraints:[{...hinge('pin','frame',V(0,0,0),'arm',V(-10,0,0)),refA:V(0,0,1)}]};
 assert(validateSpatialModel(m).some(e=>/motor reference must/.test(e)));
});
test('V6 geometry screen rejects missing and nonfinite shaft direction',()=>{
 const a=named('g8',V(0,0,1),V(0,0,0),8,'Gear 8 Tooth');
 const b=named('g24',V(0,0,0),V(40,0,0),24,'Gear 24 Tooth');
 const found=screenMechanismGeometry([a,b],boxes(['g8',bounds()],['g24',bounds(40,0,0)]));
 assert.equal(found[0].status,'rejected');assert.match(found[0].reasons.join(','),/invalid LDCad/);
 const nan=screenMechanismGeometry([a,{...b,axis:V(NaN,0,1)}],boxes(['g8',bounds()],['g24',bounds(40,0,0)]));
 assert.equal(nan[0].status,'rejected');
});


test('V6 custom rig JSON round-trips from detected joint to an editable user review',()=>{
 const a=placed([['frame',V(0,0,0)],['arm',V(10,0,0)]]);
 const p=createSpatialLinkagePreview(a,graph([graphEdge('pin','frame','arm',V(0,0,0))],[]),'pin','frame');
 const json=serializeSpatialRig(p);
 const reloaded=parseSpatialRig(json,a);
 assert.equal(reloaded.source,'user-authored-json');
 assert.equal(reloaded.model.constraints.length,1);
 assert.deepEqual(reloaded.members.frame,['frame']);
 assert.equal(new SpatialMechanismSolver(reloaded.model).solve({pin:.1}).status,'converged');
});
test('V6 imported spatial rig rejects unknown parts, duplicate mapping and absent ground',()=>{
 const a=placed([['frame',V(0,0,0)],['arm',V(10,0,0)]]);
 const p=createSpatialLinkagePreview(a,graph([graphEdge('pin','frame','arm',V(0,0,0))],[]),'pin','frame');
 const original=JSON.parse(serializeSpatialRig(p));
 const changed=(f)=>{const b=JSON.parse(JSON.stringify(original));f(b);return JSON.stringify(b)};
 assert.throws(()=>parseSpatialRig(changed(b=>{b.members.arm=['not-a-placed-part']}),a),/unknown placed instance/);
 assert.throws(()=>parseSpatialRig(changed(b=>{b.members.arm.push('frame')}),a),/multiple rigid bodies/);
 assert.throws(()=>parseSpatialRig(changed(b=>{b.model.bodies.find(x=>x.fixed).fixed=false}),a),/Unanchored/);
 assert.throws(()=>parseSpatialRig(changed(b=>{b.driver='absent'}),a),/Motor/);
 assert.throws(()=>parseSpatialRig(changed(b=>{b.model.constraints[0].kind='laser'}),a),/Unsupported spatial constraint/);
 assert.throws(()=>parseSpatialRig(changed(b=>{b.format='unknown'}),a),/Use format/);
});


test('V6 bundled four-bar JSON example is a solvable actual multi-body linkage',()=>{
 const raw=JSON.parse(require('fs').readFileSync(require('path').join(__dirname,'../samples/mechanisms/four-bar.spatial-rig.example.json'),'utf8'));
 const placedModel=placed([['base',V(0,0,0)],['crank',V(0,10,0)],['coupler',V(30,20,0)],['rocker',V(60,10,0)]]);
 for(const name of ['base','crank','coupler','rocker'])raw.members[name]=[name];
 const rig=parseSpatialRig(JSON.stringify(raw),placedModel);
 const tested=sweepSpatialLinkage(rig.model,rig.driver,.15,4);
 assert.equal(tested.status,'sampled-pass',tested.failures[0]?.reason);
 assert.equal(tested.checkedSamples,17);
});

if(process.exitCode)process.exit(process.exitCode);
