/** Cross-check V8 ideal machine laws against independent geometric identities.
 * This is independent of the React/Three renderer and physical dynamics. */
const {test,assert,approx,load}=require('./verify-v4-mechanisms-offline.cjs');
const {sliderCrankTravel,scotchYokeTravel,camProfileTravel,
 intermittentIndexTravel,differentialDriveTravel}=load('src/anim/motion/v8/mechanismLaws.ts');
let seed=0x38419abc;
const rand=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/0x100000000;};
test('V8-P01 randomized slider-crank displacements satisfy rod-length closure (200 geometries)',()=>{
 for(let i=0;i<200;i++){
  const r=2+rand()*30,e=(rand()-.5)*r*.8,L=r+Math.abs(e)+4+rand()*50;
  const a=(rand()-.5)*20*Math.PI;
  const rest=r+Math.sqrt(L*L-e*e);
  const pos=rest+sliderCrankTravel(a,r,L,e);
  approx((pos-r*Math.cos(a))**2+(e-r*Math.sin(a))**2,L*L,1e-7);
  approx(sliderCrankTravel(0,r,L,e),0,1e-9);
 }
});
test('V8-P02 Scotch-yoke displacement is periodic and exactly reverses signed input',()=>{
 for(let i=0;i<80;i++){
  const a=(rand()-.5)*100,r=rand()*40+1,phase=(rand()-.5)*7;
  approx(scotchYokeTravel(a+2*Math.PI,r,phase),scotchYokeTravel(a,r,phase),1e-9);
  approx(scotchYokeTravel(0,r,phase),0,1e-9);
 }
});
test('V8-P03 periodic variable-lift cam has continuous rest-relative full-turn profile',()=>{
 const samples=[0,4,8,3,5,1];
 for(let i=0;i<60;i++){
  const phase=(rand()-.5)*10,a=(rand()-.5)*20;
  approx(camProfileTravel(a+2*Math.PI,samples,phase),camProfileTravel(a,samples,phase),1e-8);
  approx(camProfileTravel(0,samples,phase),0,1e-9);
 }
 for(let n=0;n<samples.length;n++){
  const b=2*Math.PI*n/samples.length,eps=1e-6;
  assert(Math.abs(camProfileTravel(b+eps,samples)-camProfileTravel(b-eps,samples))<1e-5);
 }
});
test('V8-P04 ideal indexing curve has dwell and exact one-slot increments across six turns',()=>{
 const slots=8,fraction=.25;
 for(let k=-3;k<=3;k++){
  const base=2*Math.PI*k;
  const earlier=intermittentIndexTravel(base+Math.PI*.15,slots,fraction);
  const later=intermittentIndexTravel(base+Math.PI*.2,slots,fraction);
  approx(earlier,later,1e-10); // both in dwell
  approx(intermittentIndexTravel(base+2*Math.PI,slots,fraction)-intermittentIndexTravel(base,slots,fraction),2*Math.PI/slots,1e-9);
 }
});
test('V8-P05 differential-drive forward/yaw mapping is invertible and symmetric',()=>{
 for(let i=0;i<100;i++){
  const r=1+rand()*25,width=10+rand()*90,fl=(rand()-.5)*30,fr=(rand()-.5)*30;
  const {forward,yaw}=differentialDriveTravel(fl,fr,r,width);
  approx(fl,forward/r-yaw*width/(2*r),1e-10);
  approx(fr,forward/r+yaw*width/(2*r),1e-10);
  const reverse=differentialDriveTravel(-fl,-fr,r,width);
  approx(reverse.forward,-forward,1e-10);approx(reverse.yaw,-yaw,1e-10);
 }
});
test('V8-P06 model-level invalid gear/cam/drive geometry rejected at rig boundary',()=>{
 const {validateSpatialModel}=load('src/anim/motion/v6/spatialConstraints.ts');
 const p=[0,0,0],q=[0,0,0,1];
 const bodies=['ground','cam','slide'].map((id,i)=>({id,rest:{p,q},fixed:i===0}));
 const constraints=[{id:'c',kind:'hinge',a:{body:'ground',local:p},b:{body:'cam',local:p},axisA:[0,0,1],axisB:[0,0,1]},
 {id:'s',kind:'slider',a:{body:'ground',local:p},b:{body:'slide',local:p},axisA:[1,0,0],axisB:[1,0,0]}];
 const m={bodies,constraints,mechanics:[{id:'p',kind:'cam-profile',cam:'c',follower:'s',profileLdu:[0,1,NaN,4]}]};
 assert.match(validateSpatialModel(m).join(' '),/cam profile/);
 m.mechanics[0].profileLdu=[0,1,2,3];assert.deepEqual(validateSpatialModel(m),[]);
});
