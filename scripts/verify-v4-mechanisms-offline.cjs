// Focused verification without npm packages. This is NOT a replacement for the
// real three.js and Vitest suite; it proves mathematical/path data invariants.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),Module=require('module');
// esbuild ships with Vite; the `typescript` package here is the native 7.x
// preview, which no longer exposes transpileModule/ModuleKind/ScriptTarget.
let esbuild;
try { esbuild=require('esbuild'); }
catch {
  // Offline fallback: use a locally resolvable TypeScript installation, then
  // the global npm module root; no developer-specific absolute paths.
  let ts;
  try { ts=require('typescript'); }
  catch {
    const {execFileSync}=require('child_process');
    const globalRoot=execFileSync('npm',['root','-g'],{encoding:'utf8',timeout:5000}).trim();
    try { ts=require(path.join(globalRoot,'typescript')); }
    catch { throw Error('Offline verifier requires npm esbuild or TypeScript (local/global); run npm install first.'); }
  }
  esbuild={transformSync(src){return {code:ts.transpileModule(src,{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
  }}).outputText}}};
}
const ROOT=path.resolve(__dirname,'..');
class Matrix4{
  constructor(){this.elements=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];}
  clone(){return new Matrix4().copy(this)}
  copy(m){this.elements=[...m.elements];return this}
  makeTranslation(x,y,z){this.elements=[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1];return this}
  makeRotationAxis(a,t){const x=a.x,y=a.y,z=a.z,c=Math.cos(t),s=Math.sin(t),v=1-c;this.elements=[v*x*x+c,v*x*y+s*z,v*x*z-s*y,0,v*x*y-s*z,v*y*y+c,v*y*z+s*x,0,v*x*z+s*y,v*y*z-s*x,v*z*z+c,0,0,0,0,1];return this}
  multiply(b){const a=this.elements,v=b.elements,r=Array(16).fill(0);for(let i=0;i<4;i++)for(let j=0;j<4;j++)for(let k=0;k<4;k++)r[j*4+i]+=a[k*4+i]*v[j*4+k];this.elements=r;return this}
  premultiply(a){return this.copy(a.clone().multiply(this))}
  fromArray(a,i=0){this.elements=Array.from(a).slice(i,i+16);return this}
  invert(){const e=this.elements,a=e[0],b=e[4],c=e[8],d=e[1],f=e[5],g=e[9],h=e[2],i=e[6],j=e[10];const det=a*(f*j-g*i)-b*(d*j-g*h)+c*(d*i-f*h);assert(Math.abs(det)>1e-10,'singular');const inv=[(f*j-g*i)/det,(c*i-b*j)/det,(b*g-c*f)/det,(g*h-d*j)/det,(a*j-c*h)/det,(c*d-a*g)/det,(d*i-f*h)/det,(b*h-a*i)/det,(a*f-b*d)/det];const t=[e[12],e[13],e[14]];this.elements=[inv[0],inv[3],inv[6],0,inv[1],inv[4],inv[7],0,inv[2],inv[5],inv[8],0,-inv[0]*t[0]-inv[1]*t[1]-inv[2]*t[2],-inv[3]*t[0]-inv[4]*t[1]-inv[5]*t[2],-inv[6]*t[0]-inv[7]*t[1]-inv[8]*t[2],1];return this}
  compose(p,q,s){const x=q.x,y=q.y,z=q.z,w=q.w,x2=x+x,y2=y+y,z2=z+z,xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;
   this.elements=[(1-(yy+zz))*s.x,(xy+wz)*s.x,(xz-wy)*s.x,0,(xy-wz)*s.y,(1-(xx+zz))*s.y,(yz+wx)*s.y,0,(xz+wy)*s.z,(yz-wx)*s.z,(1-(xx+yy))*s.z,0,p.x,p.y,p.z,1];return this}
  decompose(p,q,s){const m=this.elements;p.x=m[12];p.y=m[13];p.z=m[14];const sx=Math.hypot(m[0],m[1],m[2]),sy=Math.hypot(m[4],m[5],m[6]),sz=Math.hypot(m[8],m[9],m[10]);s.x=sx;s.y=sy;s.z=sz;const r=this.clone();[0,1,2].forEach(col=>[0,1,2].forEach(row=>r.elements[col*4+row]/=[sx,sy,sz][col]));q.setFromRotationMatrix(r);return this}
}
class Vector3{
 constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z}
 clone(){return new Vector3(this.x,this.y,this.z)}
 normalize(){const l=this.length();return this.multiplyScalar(1/(l||1))}
 length(){return Math.hypot(this.x,this.y,this.z)}
 lengthSq(){return this.x*this.x+this.y*this.y+this.z*this.z}
 toArray(){return [this.x,this.y,this.z]}
 addScaledVector(a,s){this.x+=a.x*s;this.y+=a.y*s;this.z+=a.z*s;return this}
 sub(a){this.x-=a.x;this.y-=a.y;this.z-=a.z;return this}
 dot(a){return this.x*a.x+this.y*a.y+this.z*a.z}
 multiplyScalar(n){this.x*=n;this.y*=n;this.z*=n;return this}
 distanceTo(b){return Math.hypot(this.x-b.x,this.y-b.y,this.z-b.z)}
 applyMatrix4(m){const e=m.elements,[x,y,z]=this.toArray();this.x=e[0]*x+e[4]*y+e[8]*z+e[12];this.y=e[1]*x+e[5]*y+e[9]*z+e[13];this.z=e[2]*x+e[6]*y+e[10]*z+e[14];return this}
 lerp(b,u){this.x+=(b.x-this.x)*u;this.y+=(b.y-this.y)*u;this.z+=(b.z-this.z)*u;return this}
}
class Quaternion{
 constructor(x=0,y=0,z=0,w=1){Object.assign(this,{x,y,z,w})}
 setFromRotationMatrix(m){const a=m.elements,m11=a[0],m22=a[5],m33=a[10],tr=m11+m22+m33;if(tr>0){const s=.5/Math.sqrt(tr+1);this.w=.25/s;this.x=(a[6]-a[9])*s;this.y=(a[8]-a[2])*s;this.z=(a[1]-a[4])*s;}else if(m11>m22&&m11>m33){const s=2*Math.sqrt(1+m11-m22-m33);this.w=(a[6]-a[9])/s;this.x=.25*s;this.y=(a[4]+a[1])/s;this.z=(a[8]+a[2])/s;}else if(m22>m33){const s=2*Math.sqrt(1+m22-m11-m33);this.w=(a[8]-a[2])/s;this.x=(a[4]+a[1])/s;this.y=.25*s;this.z=(a[9]+a[6])/s;}else{const s=2*Math.sqrt(1+m33-m11-m22);this.w=(a[1]-a[4])/s;this.x=(a[8]+a[2])/s;this.y=(a[9]+a[6])/s;this.z=.25*s;}return this}
 slerp(b,t){let [x,y,z,w]=[b.x,b.y,b.z,b.w],dot=this.x*x+this.y*y+this.z*z+this.w*w;if(dot<0){dot=-dot;x=-x;y=-y;z=-z;w=-w}if(dot>.9995){this.x+=(x-this.x)*t;this.y+=(y-this.y)*t;this.z+=(z-this.z)*t;this.w+=(w-this.w)*t;const len=Math.hypot(this.x,this.y,this.z,this.w);this.x/=len;this.y/=len;this.z/=len;this.w/=len;return this}const theta=Math.acos(dot),s=Math.sin(theta),a=Math.sin((1-t)*theta)/s,c=Math.sin(t*theta)/s;this.x=a*this.x+c*x;this.y=a*this.y+c*y;this.z=a*this.z+c*z;this.w=a*this.w+c*w;return this}
}
const THREE={Matrix4,Vector3,Quaternion};
const transformBox=(box,m)=>{const pts=[];for(const x of [box.min[0],box.max[0]])for(const y of [box.min[1],box.max[1]])for(const z of [box.min[2],box.max[2]])pts.push(new Vector3(x,y,z).applyMatrix4(m));return {min:[0,1,2].map(i=>Math.min(...pts.map(p=>p.toArray()[i]))),max:[0,1,2].map(i=>Math.max(...pts.map(p=>p.toArray()[i])))};};
const unionBox=(a,b)=>!a?b:{min:[0,1,2].map(i=>Math.min(a.min[i],b.min[i])),max:[0,1,2].map(i=>Math.max(a.max[i],b.max[i]))};
const cache=new Map();
function load(source){const filename=path.resolve(ROOT,source);if(cache.has(filename))return cache.get(filename);
 const compiled=esbuild.transformSync(fs.readFileSync(filename,'utf8'),{loader:'ts',format:'cjs',target:'node20',sourcefile:filename}).code;
 const mod=new Module(filename);mod.filename=filename;cache.set(filename,mod.exports);
 mod.require=(id)=>{
  if(id==='three')return THREE;
  if(id.endsWith('/model/assemble') || id==='../../../model/assemble')return {transformBox,unionBox};
  if(id.startsWith('.')){const target=path.resolve(path.dirname(filename),id);if(fs.existsSync(target+'.ts'))return load(target+'.ts')}
  return require(id);
 };
 mod._compile(compiled,filename);cache.set(filename,mod.exports);return mod.exports;
}
const {validateMechanismProgram}=load('src/anim/motion/v4/mechanismProgram.ts');
const {MechanismSolver}=load('src/anim/motion/v4/mechanismSolver.ts');
const {ReducedGravityPreview}=load('src/anim/motion/v4/physicsPreview.ts');
const {compileMechanismStage}=load('src/anim/motion/v4/mechanismStage.ts');
const {mechanismPoseAt}=load('src/anim/motion/v4/mechanismPlayback.ts');
const at=(x=0,y=0,z=0)=>new Matrix4().makeTranslation(x,y,z);
const box={min:[-1,-1,-1],max:[1,1,1]};
const assembly=keys=>({instances:keys.map(x=>({key:x[0],part:x[0],world:at(...(x[1]??[0,0,0])),worldBox:box})),nodes:[],problems:[],bounds:null});
const metrics=()=>({full:box,body:box});
const timeline=a=>({tracks:new Map(a.instances.map(i=>[i.key,{final:i.world.clone(),moves:[],floor:i.world.clone(),appear:0}])),
 sceneBox:box,buildBox:box,camKeys:[],buildEnd:10,duration:12,pacing:{outro:2}});
const approx=(a,b,tol=1e-5)=>assert(Math.abs(a-b)<=tol,`${a} != ${b} (tol ${tol})`);
function test(name,fn){try{fn();console.log('PASS',name)}catch(e){console.error('FAIL',name,e.stack);process.exitCode=1}}
const pair=()=>({mode:'kinematic',duration:2,sampleHz:60,
  joints:[{id:'a',body:'A',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]},{id:'b',body:'B',kind:'revolute',axis:[0,0,1],pivot:[8,0,0]}],
  gears:[{a:'a',b:'b',teethA:8,teethB:24,mesh:'external',moduleLdu:.5,source:'user'}],driver:{joint:'a',amplitude:Math.PI/2}});
const scene=()=>assembly([['A'],['B',[8,0,0]]]);
test('program validation',()=>{assert.equal(validateMechanismProgram(pair()).length,0);assert(validateMechanismProgram({...pair(),gears:[{...pair().gears[0],teethA:-1}]}).length>0)});
test('gear ratio and fixed world pivot',()=>{const s=new MechanismSolver(scene(),pair());const frame=s.solve(Math.PI/2);approx(frame.joints.get('b'),-Math.PI/6);approx(frame.poses.get('B').elements[12],8);assert.throws(()=>new MechanismSolver(scene(),{...pair(),gears:[{...pair().gears[0],moduleLdu:1}]}),/pitch circles/)});
test('contradictory gear cycle',()=>{const p=pair();p.joints.push({id:'c',body:'C',kind:'revolute',axis:[0,0,1],pivot:[15,0,0]});p.gears.push({a:'b',b:'c',teethA:24,teethB:16,mesh:'external',source:'user'},{a:'c',b:'a',teethA:16,teethB:8,mesh:'external',source:'user'});assert.throws(()=>new MechanismSolver(assembly([['A'],['B',[8,0,0]],['C',[15,0,0]]]),p),/Contradictory/)});
test('closed linkage solves and unreachable report',()=>{const a=assembly([['crank'],['coupler',[2,0,0]],['rocker',[5,0,0]]]);const p={mode:'kinematic',duration:2,joints:[{id:'crank',body:'crank',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]},{id:'coupler',body:'coupler',parent:'crank',kind:'revolute',axis:[0,0,1],pivot:[2,0,0]},{id:'rocker',body:'rocker',kind:'revolute',axis:[0,0,1],pivot:[5,0,0]}],closures:[{a:{body:'coupler',local:[2,2,0]},b:{body:'rocker',local:[-1,2,0]},toleranceLdu:.06}],driver:{joint:'crank',amplitude:.2}};const solver=new MechanismSolver(a,p);for(const q of [0,.02,.04,.06,.10,.15,.2,.1,0])assert(solver.solve(q).maxClosureErrorLdu<.061);assert.throws(()=>solver.solve(Math.PI),/Unreachable|stop/)});
test('reduced gravity produces finite constrained swing',()=>{const program={mode:'gravity',duration:2,joints:[{id:'s',body:'arm',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]}],driver:{joint:'s',amplitude:.5},gravity:{acceleration:[0,9.81,0],bodies:[{body:'arm',massKg:.1,centreLocal:[5,0,0],inertiaKgM2:.001}],damping:.002,releaseAt:.3}};const a=assembly([['arm']]);const solver=new MechanismSolver(a,program),gravity=new ReducedGravityPreview(solver,a,metrics);gravity.reset(.3);assert(gravity.accelerationAt(.3,0).acceleration>0);for(let i=0;i<12;i++)gravity.step(1/240);assert(Number.isFinite(gravity.position));});
test('stage playback and exact reset',()=>{const a=scene(),tl=timeline(a),p=pair();const stage=compileMechanismStage(a,metrics,tl,p);assert.equal(stage.frames,121);assert.equal(stage.collisionStatus,'unverified');const base=tl.tracks.get('B').final,mid=mechanismPoseAt(stage,stage.start+stage.duration/4,'B',base),end=mechanismPoseAt(stage,stage.start+stage.duration,'B',base);assert(mid&&end);approx(mid.elements[0],Math.cos(-Math.PI/6),.001);for(let i=0;i<16;i++)approx(end.elements[i],base.elements[i]);const serialized=JSON.parse(JSON.stringify(stage));assert.deepEqual(serialized,stage)});
test('fixed connection cannot separate',()=>{const a=assembly([['A'],['B',[8,0,0]],['axle']]);assert.throws(()=>compileMechanismStage(a,metrics,timeline(a),pair(),[],{edges:[{id:'weld',a:'A',b:'axle',motion:'fixed'}]}),/Fixed connection/)});
if(process.exitCode)process.exit(process.exitCode);

test('carrier separation invalidates gear pitch engagement',()=>{
 const p={mode:'kinematic',duration:2,joints:[
  {id:'arm',body:'carrier',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]},
  {id:'a',body:'A',parent:'carrier',kind:'revolute',axis:[0,0,1],pivot:[2,0,0]},
  {id:'b',body:'B',kind:'revolute',axis:[0,0,1],pivot:[8,0,0]}],
  gears:[{a:'a',b:'b',teethA:8,teethB:24,mesh:'external',moduleLdu:.375,source:'user'}],
  driver:{joint:'arm',amplitude:.9}};
 const solver=new MechanismSolver(assembly([['carrier'],['A',[2,0,0]],['B',[8,0,0]]]),p);
 solver.solve(0);assert.throws(()=>solver.solve(.9),/moving shafts lose pitch engagement/);
});
test('gravity requires explicit distinct masses for driven followers',()=>{
 const p={mode:'gravity',duration:2,joints:[{id:'arm',body:'A',kind:'revolute',axis:[0,0,1],pivot:[0,0,0]}],
 rigidFollowers:[{leader:'A',bodies:['B']}],driver:{joint:'arm',amplitude:.1},
 gravity:{acceleration:[0,9.81,0],damping:.02,releaseAt:.1,bodies:[{body:'A',massKg:.1}]}};
 assert(validateMechanismProgram(p).some(x=>x.includes('moving body B')));
 p.gravity.bodies.push({body:'B',massKg:.03});
 assert.equal(validateMechanismProgram(p).length,0);
 p.gravity.bodies.push({body:'B',massKg:.04});
 assert(validateMechanismProgram(p).some(x=>x.includes('Duplicate physical mass')));
});
test('gravity stage compiles to sampled playback and exact final rest',()=>{
 const p={mode:'gravity',duration:1,sampleHz:24,joints:[
  {id:'hinge',body:'arm',kind:'revolute',pivot:[0,0,0],axis:[0,0,1],limits:{min:-.9,max:.9,source:'user'}}],
 driver:{joint:'hinge',amplitude:.2},gravity:{acceleration:[0,9.81,0],damping:.01,releaseAt:.2,
 bodies:[{body:'arm',massKg:.1,centreLocal:[5,0,0],inertiaKgM2:.001}]}};
 const a=assembly([['arm']]),tl=timeline(a),stage=compileMechanismStage(a,metrics,tl,p);
 assert.equal(stage.mode,'gravity');assert.equal(stage.frames,25);assert(stage.diagnostics.physicsSteps>0);
 assert.equal(stage.collisionStatus,'unverified');
 const pose=mechanismPoseAt(stage,stage.start+stage.duration,'arm',tl.tracks.get('arm').final);
 pose.elements.forEach((v,i)=>approx(v,tl.tracks.get('arm').final.elements[i],1e-9));
});
if(process.exitCode)process.exit(process.exitCode);

module.exports={test,assert,approx,load,assembly,scene,metrics,timeline,Matrix4,Vector3};
