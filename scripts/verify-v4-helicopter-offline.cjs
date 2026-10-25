// Dependency-free numeric smoke verification using an intentionally minimal
// 3D matrix implementation (this is not the project's full Vitest suite).
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
// esbuild ships with Vite; the `typescript` package here is the native 7.x
// preview, which no longer exposes transpileModule/ModuleKind.
const esbuild = require('esbuild');
const root = path.resolve(__dirname,'..');
class Matrix4 {
  constructor() { this.elements = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }
  clone() { return new Matrix4().copy(this); }
  copy(other) { this.elements = other.elements.slice(); return this; }
  set(n11,n12,n13,n14,n21,n22,n23,n24,n31,n32,n33,n34,n41,n42,n43,n44) {
    this.elements=[n11,n21,n31,n41, n12,n22,n32,n42, n13,n23,n33,n43, n14,n24,n34,n44];return this;
  }
  makeTranslation(x,y,z) { this.elements = [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]; return this; }
  makeRotationAxis(axis, angle) {
    const [x,y,z] = [axis.x,axis.y,axis.z], c = Math.cos(angle), s=Math.sin(angle), t=1-c;
    this.elements=[t*x*x+c,t*x*y+s*z,t*x*z-s*y,0, t*x*y-s*z,t*y*y+c,t*y*z+s*x,0, t*x*z+s*y,t*y*z-s*x,t*z*z+c,0, 0,0,0,1];
    return this;
  }
  makeRotationY(angle) { return this.makeRotationAxis(new Vector3(0,1,0),angle); }
  multiply(b) { const a=this.elements, v=b.elements, out=Array(16).fill(0);
    for(let row=0;row<4;row++)for(let col=0;col<4;col++)for(let k=0;k<4;k++)out[col*4+row]+=a[k*4+row]*v[col*4+k];
    this.elements=out; return this; }
  premultiply(m) { return this.copy(m.clone().multiply(this)); }
  fromArray(elements,index=0){this.elements=Array.from(elements).slice(index,index+16);return this;}
  equals(o){return this.elements.every((n,i)=>n===o.elements[i]);}
  invert(){
    // Sufficient for matrices with an invertible linear 3x3 block.
    const e=this.elements;const [a,b,c,d,f,g,h,i,j]=[e[0],e[4],e[8],e[1],e[5],e[9],e[2],e[6],e[10]];
    const det=a*(f*j-g*i)-b*(d*j-g*h)+c*(d*i-f*h);assert(Math.abs(det)>1e-10);
    const inv=[(f*j-g*i)/det,(c*i-b*j)/det,(b*g-c*f)/det,(g*h-d*j)/det,(a*j-c*h)/det,(c*d-a*g)/det,(d*i-f*h)/det,(b*h-a*i)/det,(a*f-b*d)/det];
    const t=[e[12],e[13],e[14]];
    this.elements=[inv[0],inv[3],inv[6],0,inv[1],inv[4],inv[7],0,inv[2],inv[5],inv[8],0,
      -inv[0]*t[0]-inv[1]*t[1]-inv[2]*t[2], -inv[3]*t[0]-inv[4]*t[1]-inv[5]*t[2], -inv[6]*t[0]-inv[7]*t[1]-inv[8]*t[2],1];
    return this;
  }
}
class Vector3 {
  constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;}
  clone(){return new Vector3(this.x,this.y,this.z);}
  copy(a){this.x=a.x;this.y=a.y;this.z=a.z;return this;}
  lengthSq(){return this.x**2+this.y**2+this.z**2;}
  length(){return Math.sqrt(this.lengthSq());}
  distanceTo(b){return this.clone().sub(b).length();}
  normalize(){return this.multiplyScalar(1/(this.length()||1));}
  multiplyScalar(s){this.x*=s;this.y*=s;this.z*=s;return this;}
  dot(v){return this.x*v.x+this.y*v.y+this.z*v.z;}
  cross(b){const [x,y,z]=[this.y*b.z-this.z*b.y,this.z*b.x-this.x*b.z,this.x*b.y-this.y*b.x];this.x=x;this.y=y;this.z=z;return this;}
  sub(b){this.x-=b.x;this.y-=b.y;this.z-=b.z;return this;}
  addScaledVector(b,s){this.x+=b.x*s;this.y+=b.y*s;this.z+=b.z*s;return this;}
  setFromMatrixPosition(m){this.x=m.elements[12];this.y=m.elements[13];this.z=m.elements[14];return this;}
  applyMatrix4(m){const e=m.elements,[x,y,z]=[this.x,this.y,this.z];const w=1/(e[3]*x+e[7]*y+e[11]*z+e[15]);
    this.x=(e[0]*x+e[4]*y+e[8]*z+e[12])*w;
    this.y=(e[1]*x+e[5]*y+e[9]*z+e[13])*w;
    this.z=(e[2]*x+e[6]*y+e[10]*z+e[14])*w;return this;}
}

Vector3.prototype.add=function(b){this.x+=b.x;this.y+=b.y;this.z+=b.z;return this};
Vector3.prototype.getComponent=function(i){return i===0?this.x:i===1?this.y:this.z};
const THREE={Matrix4,Vector3};
const box=(half=.5)=>({min:[-half,-half,-half],max:[half,half,half]});
const transformBox=(b,m)=>{const pts=[];for(const x of [b.min[0],b.max[0]])for(const y of [b.min[1],b.max[1]])for(const z of [b.min[2],b.max[2]])pts.push(new Vector3(x,y,z).applyMatrix4(m));return {min:[0,1,2].map(k=>Math.min(...pts.map(p=>[p.x,p.y,p.z][k]))),max:[0,1,2].map(k=>Math.max(...pts.map(p=>[p.x,p.y,p.z][k])))};};
const unionBox=(a,b)=>!a?b:{min:[0,1,2].map(k=>Math.min(a.min[k],b.min[k])),max:[0,1,2].map(k=>Math.max(a.max[k],b.max[k]))};
const cache=new Map();
let fakeV3Timeline=null;
let fakeV3Joints=[];
let recordedV3SinglePass=null;
class OfflineInstalledRouteIndex {
  constructor(){}
  assess(){return {hits:0,firstHit:0,blockers:[],assessed:true};}
  obstacleBoxes(){return []}
  noteUpdatedMove(){}
}

function load(rel){
 const file=path.resolve(root,rel);if(cache.has(file))return cache.get(file);
 const js=esbuild.transformSync(fs.readFileSync(file,'utf8'),{loader:'ts',format:'cjs',target:'node20',sourcefile:file}).code;
 const m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));cache.set(file,m.exports);
 m.require=(name)=>{
   if(name==='three')return THREE;
   if(name==='../standardMotion')return {buildStandardMotionTimeline:(...args)=>{recordedV3SinglePass=args[6]===true;return fakeV3Timeline;},jointsFor:()=>fakeV3Joints};
   if(name==='../routeSelection')return load('src/anim/motion/routeSelection.ts');
   if(name.endsWith('/model/assemble') || name==='../../../model/assemble' || name==='../../model/assemble')return load('src/model/assemble.ts');
   if(name.endsWith('/timeline') || name==='../../timeline')return {flightPose,poseAt};
   if(name.startsWith('.')){
     const candidate=path.resolve(path.dirname(file),name);
     const tsFile=fs.existsSync(candidate+'.ts')?candidate+'.ts':fs.existsSync(candidate+'.tsx')?candidate+'.tsx':null;
     if(tsFile)return load(tsFile);
   }
   return require(name);
 };
 m._compile(js,file);cache.set(file,m.exports);return m.exports;
}
const at=(x=0,y=0,z=0)=>new Matrix4().makeTranslation(x,y,z);
const cubic=x=>x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;
function flightPose(m,u,out=new Matrix4()){
 if(m.stationary)return out.copy(m.from);
 u=Math.max(0,Math.min(1,(u-m.hold)/(1-m.hold)));
 if(u<=0)return out.copy(m.from);
 if(u>=1)return out.copy(m.to);
 if(m.posePath?.length){const scaled=cubic(u)*(m.posePath.length-1),i=Math.min(m.posePath.length-2,Math.floor(scaled)),q=scaled-i;
  const segment=m.kinematicSegments?.find(s=>s.index===i);
  if(segment&&kin.interpolateJointSegment(m.posePath[i],segment,q,out))return out;
  const a=m.posePath[i],b=m.posePath[i+1];
  for(let j=0;j<16;j++)out.elements[j]=a.elements[j]+(b.elements[j]-a.elements[j])*q;
  return out;
 }
 if(m.translationPath?.length){const scaled=cubic(u)*(m.translationPath.length-1),i=Math.min(m.translationPath.length-2,Math.floor(scaled)),q=scaled-i;
  out.copy(m.from);for(let j=0;j<3;j++)out.elements[12+j]+=(m.translationPath[i][j]*(1-q)+m.translationPath[i+1][j]*q);return out;}
 throw Error('unsupported offline sample');
}
function poseAt(tl,t){return key=>{const tr=tl.tracks.get(key);if(!tr||t<tr.appear)return null;
 if(!tr.moves.length)return tr.final.clone();const first=tl.units[tr.moves[0].unit];if(t<first.start)return tr.floor.clone();
 for(let i=0;i<tr.moves.length;i++){const m=tr.moves[i],u=tl.units[m.unit];if(t<u.start)return tr.moves[i-1].to.clone();
  if(t<u.start+u.dur)return flightPose(m,(t-u.start)/u.dur);}
 return tr.final.clone()}};

async function run(){
 const mpdFile=process.argv[2]??path.resolve(root,'samples/helicopter/helicopter.mpd');
 const startAll=performance.now();
 const {importLDraw}=load('src/io/ldrawImport.ts');
 const {assemble,transformBox:actualBox}=load('src/model/assemble.ts');
 const {PartLibrary}=load('src/ldraw/library.ts');
 const {measurePart}=load('src/ldraw/metrics.ts');
 const {parseLDConfig}=load('src/ldraw/colors.ts');
 const plan=importLDraw(fs.readFileSync(mpdFile,'utf8'),'helicopter.mpd');
 const ids=new Set();
 const visit=steps=>{for(const step of steps)for(const item of step.pieces){if(item.part)ids.add(item.part);if(item.submodel)visit(plan.submodels[item.submodel].steps)}};
 visit(plan.steps);
 const base=path.resolve(root,'public/ldraw');
 const fetchText=async file=>{try{return fs.readFileSync(path.resolve(base,file),'utf8');}catch{return null;}};
 const lib=new PartLibrary(fetchText);
 const loaded=await Promise.all([...ids].map(async id=>[id,measurePart(await lib.loadPart(id),id)]));
 const lookup=new Map(loaded);
 const m=id=>lookup.get(id)??measurePart(null,id);
 const colors=parseLDConfig(fs.readFileSync(path.resolve(base,'LDConfig.ldr'),'utf8'));
 const a=assemble(plan,m,colors);
 console.log('Imported helicopter:',a.instances.length,'instances,',ids.size,'distinct DAT parts,',a.problems.length,'assembly warnings,',loaded.filter(([,v])=>v.placeholder).length,'placeholder meshes');
 const maxN=Number(process.env.MAX_BODIES??Infinity),instances=a.instances.slice(0,maxN);
 a.instances=instances;
 const units=[],tracks=new Map();
 const n=instances.length;
 let sceneBox=null;
 for(let i=0;i<n;i++){
  const inst=instances[i];
  const pose=inst.world.clone();
  const floor=pose.clone();floor.elements[12]=(i%18-9)*30;
  floor.elements[13]=-10;
  floor.elements[14]=230+Math.floor(i/18)*34;
  const sky=-260;
  const elevated=origin=>{const v=origin.clone();v.elements[13]=sky;return v;};
  const mv={unit:i,from:floor,to:pose,rel:null,skyY:sky,hold:0,entry:[0,0,0],posePath:[floor.clone(),elevated(floor),elevated(pose),pose.clone()]};
  const start=i*0.12;
  const unit={kind:'piece',keys:[inst.key],start,dur:0.4,step:Math.floor(i/15),motion:'preview'};
  unit.box=actualBox(m(inst.part).full,pose);
  units.push(unit);
  const floorBox=actualBox(m(inst.part).full,floor);
  tracks.set(inst.key,{appear:-Infinity,ctx:0,floor,floorBox,final:pose,moves:[mv]});
  sceneBox=unionBox(sceneBox,inst.worldBox);
 }
 fakeV3Timeline={units,tracks,duration:n*.12+4,buildEnd:n*.12+.4,intro:0,pacing:{outro:3},sceneBox,buildBox:sceneBox,modelBox:sceneBox,
  camKeys:[],steps:[],subBuilds:[],motion:{engine:'standard-motion',parts:n,articulated:0,review:n}};
 fakeV3Joints=[];
 const v4=load('src/anim/motion/v4/standardMotionV4.ts');
 const start=performance.now(),progress=[];
 const tl=v4.buildStandardMotionV4Timeline(a,m,{targetSeconds:30,heroOrbit:false,planner:'standard-motion-v4'},p=>{progress.push(p); if(p.phase==='routing'||p.phase==='validation')console.log('PROGRESS',p.phase,p.completed+'/'+p.total,'sec',Math.round((performance.now()-start)/1000));});
 const elapsed=Math.round(performance.now()-start),final=tl.motion.v4.mesh;
 assert.equal(recordedV3SinglePass,instances.length>32,'v4 large-scene baseline must use single-pass scheduling');
 assert.equal(tl.tracks.size,instances.length);
 assert.equal(tl.motion.engine,'standard-motion-v4');
 assert.equal(final.certified+final.blocked+final.unverified,instances.length);
 for(const inst of instances){const tr=tl.tracks.get(inst.key);assert(tr,'missing track');assert(tr.final.equals(inst.world),'final placement changed: '+inst.key)}
 console.log(JSON.stringify({model:'helicopter.mpd',instances:n,datParts:ids.size,placeholderParts:loaded.filter(([,v])=>v.placeholder).length,
   assemblyProblems:a.problems.length,seconds:elapsed/1000,endToEndSeconds:Math.round(performance.now()-startAll)/1000,
   reviewed:tl.motion.review,mesh:final,progressUpdates:progress.length,planning:tl.motion.v4.planning},null,2));

 console.log('PASS helicopter source-derived planning regression');
}
run().catch(err=>{console.error('FAIL helicopter planning regression',err.stack);process.exitCode=1});
