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
   if(name==='../standardMotion')return {buildStandardMotionTimeline:()=>fakeV3Timeline,jointsFor:()=>fakeV3Joints};
   if(name==='../routeSelection')return {InstalledRouteIndex:OfflineInstalledRouteIndex};
   if(name.endsWith('/model/assemble') || name==='../../../model/assemble' || name==='../../model/assemble')return {transformBox,unionBox};
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
const kin=load('src/anim/motion/jointKinematics.ts');
const candidates=load('src/anim/motion/kinematicCandidates.ts');
const graphMod=load('src/anim/motion/v4/mechanismGraph.ts');
const limits=load('src/anim/motion/v4/jointLimits.ts');
const mesh=load('src/anim/motion/v4/meshCertifier.ts');
const cube=(lo,hi)=>{let v=[];for(const x of [lo[0],hi[0]])for(const y of [lo[1],hi[1]])for(const z of [lo[2],hi[2]])v.push([x,y,z]);
 const faces=[[0,2,3,1],[4,5,7,6],[0,1,5,4],[2,6,7,3],[0,4,6,2],[1,3,7,5]];
 return new Float32Array(faces.flatMap(([a,b,c,d])=>[...v[a],...v[b],...v[c],...v[a],...v[c],...v[d]]));};
const met=(missing=[])=>id=>({id,body:box(),full:box(),placeholder:missing.includes(id),
 mesh:missing.includes(id)?undefined:cube([-.5,-.5,-.5],[.5,.5,.5]),footprint:{w:1,d:1},heightPlates:1});
const asm=names=>({instances:names.map(key=>({key,part:key})),nodes:[],problems:[],bounds:null});
const joint=(type,motion,axis=[0,0,1],centre=[0,0,0])=>({id:`${type}:${axis.join(',')}`,male:'moving',female:'host',type,motion,axis,centre,engagement:12});
const move=(from,to,unit=0)=>({unit,from,to,rel:null,skyY:-30,hold:0,entry:[0,0,0],posePath:[from,to]});
const scene=parts=>{const units=parts.filter(p=>p.move).map(p=>({kind:'piece',keys:[p.key],start:p.start??0,dur:(p.end??1)-(p.start??0),step:0}));
const tracks=new Map(parts.map(p=>[p.key,{appear:p.appear??-1,ctx:0,floor:p.floor,final:p.final,floorBox:box(),
 moves:p.move?[{...p.move,unit:units.findIndex(u=>u.keys[0]===p.key)}]:[]}]));return {units,tracks,duration:100}};
const mkCert=(a,tl,m=met())=>new mesh.TimedMeshCertifier(a,tl,m,graphMod.buildMotionMechanismGraph(a,[]));
const c=(actual,expected)=>assert.equal(actual,expected,JSON.stringify(actual));
{
 const graph=graphMod.buildMotionMechanismGraph(asm(['moving','host','fixed','unknown']),[
 joint('hinge','revolute'),{...joint('stud-socket','fixed'),id:'weld',female:'fixed'}]);
 c(graph.edges.length,2);c(graph.uncertainBodies.length,1);
 c(graph.mobility('moving','host',new Set(['host','fixed']),'revolute').allowed,false);
 c(graph.mobility('moving','host',new Set(['host']),'revolute').allowed,true);
 console.log('PASS v4 graph fixed clusters / incompatible engaged hinges');
}
{
 const cand=candidates.mechanicalApproaches(move(at(-80,-50),at(40)),joint('hinge','revolute'),'moving')[0];
 const initial=-cand.kinematicSegments.reduce((s,x)=>s+x.travel,0), q=Math.PI/5;
 const rule={moving:'moving',host:'host',kind:'revolute',min:initial<0?-q:0,max:initial>0?q:0,source:'user'};
 c(limits.validJointLimit(rule),true);
 const result=limits.constrainJointCandidate(cand,rule);
 c(result.status,'adjusted');
 c(result.candidate.poses.at(-1).equals(cand.poses.at(-1)),true);
 const opened=-result.candidate.kinematicSegments.reduce((s,x)=>s+x.travel,0);
 assert(Math.abs(opened-(initial<0?-q:q))<1e-6);
 c(limits.constrainJointCandidate(cand,{...rule,min:0,max:0}).status,'violated');
 console.log('PASS v4 signed limits / keyed endpoint invariant');
}
{
 const b=mesh.revoluteEnvelope({min:[-.1,-.1,-.1],max:[.1,.1,.1]},at(3),[0,0,0],[0,0,1],Math.PI/2);
 for(let t=0;t<=1;t+=.01){const p=[3*Math.cos(t*Math.PI/2),3*Math.sin(t*Math.PI/2),0];for(let k=0;k<3;k++)assert(p[k]>=b.min[k]&&p[k]<=b.max[k]);}
 console.log('PASS exact continuous hinge envelope over 101 samples');
}
{
 const a=asm(['moving','wall']),m=move(at(-7),at(7));
 const tl=scene([{key:'moving',floor:m.from,final:m.to,move:m},{key:'wall',floor:at(0),final:at(0)}]);
 const outcome=mkCert(a,tl).verify('moving',tl.tracks.get('moving').moves[0]);
 console.log('moving crosses wall:',outcome.status,outcome.reason,'sweeps',outcome.meshSweeps);
 c(outcome.status,'blocked');
 const other=scene([{key:'moving',floor:m.from,final:m.to,move:m},{key:'wall',floor:at(0,10),final:at(0,10)}]);
 c(mkCert(a,other).verify('moving',other.tracks.get('moving').moves[0]).status,'clear');
 console.log('PASS swept mesh translation vs static / distant obstacle');
}
{
 const a=asm(['moving','missing']),m=move(at(-7),at(7));
 const tl=scene([{key:'moving',floor:m.from,final:m.to,move:m},{key:'missing',floor:at(1000),final:at(1000)}]);
 c(mkCert(a,tl,met(['missing'])).verify('moving',tl.tracks.get('moving').moves[0]).status,'unverified');
 console.log('PASS fail-closed missing remote geometry');
}
{
 const a=asm(['moving','staged']),m=move(at(-7),at(7)),park=move(at(0),at(100));
 const tl=scene([{key:'moving',floor:m.from,final:m.to,move:m},{key:'staged',floor:park.from,final:park.to,move:park,start:5,end:6}]);
 c(mkCert(a,tl).verify('moving',tl.tracks.get('moving').moves[0]).status,'blocked');
 console.log('PASS occupancy of parked staging');
}
{
 const a=asm(['moving','other']),m=move(at(-5),at(5)),o=move(at(5),at(-5));
 const tl=scene([{key:'moving',floor:m.from,final:m.to,move:m},{key:'other',floor:o.from,final:o.to,move:o}]);
 c(mkCert(a,tl).verify('moving',tl.tracks.get('moving').moves[0]).status,'blocked');
 console.log('PASS simultaneous-motion collision');
}
{
 const a=asm(['moving','obstacle']),pivot=[198,0,0],m={...move(at(200),at(198,2).multiply(new Matrix4().makeRotationAxis(new Vector3(0,0,1),Math.PI/2))),kinematicSegments:[{index:0,kind:'revolute',axis:[0,0,1],pivot,travel:Math.PI/2}]};
 const tl=scene([{key:'moving',floor:m.from,final:m.to,move:m},{key:'obstacle',floor:at(199.4,1.4),final:at(199.4,1.4)}]);
 const outcome=mkCert(a,tl).verify('moving',tl.tracks.get('moving').moves[0]);
 console.log('non-origin pivot:',outcome.status,outcome.reason,'sweeps',outcome.meshSweeps);
 assert.notEqual(outcome.status,'clear');
 console.log('PASS non-origin hinge cannot tunnel through mesh');
}
{
 const a=asm(['moving','wall']),m=move(at(-7),at(7));
 const tl=scene([{key:'moving',floor:m.from,final:m.to,move:m},{key:'wall',floor:at(0),final:at(0)}]);
 tl.motion={engine:'standard-motion',parts:2,articulated:0,review:2};fakeV3Timeline=tl;fakeV3Joints=[];
 const v4=load('src/anim/motion/v4/standardMotionV4.ts');
 const done=v4.buildStandardMotionV4Timeline(a,met(),{targetSeconds:12,heroOrbit:false,planner:'standard-motion-v4'});
 const actual=done.tracks.get('moving').moves[0];
 console.log('end-to-end v4 planner', done.motion.engine,done.motion.v4.mesh,'path length',actual.posePath?.length);
 c(done.motion.engine,'standard-motion-v4');assert(actual.posePath?.length>=3);
 c(done.motion.v4.mesh.certified,1);c(done.motion.v4.mesh.blocked,0);
 c(actual.posePath.at(-1).equals(m.to),true);
 console.log('PASS v4 reroutes an actually obstructed flight and preserves final placement');
}
{
 // A saved mechanism from a DIFFERENT MPD must not suppress the assembly
 // timeline. The old v4 release threw and left the editor without a Build.
 const a=asm(['moving','wall']),m=move(at(-10),at(-5));
 const makeBase=()=>{
  const t=scene([{key:'moving',floor:m.from,final:m.to,move:m},
    {key:'wall',floor:at(40),final:at(40)}]);
  t.motion={engine:'standard-motion',parts:2,articulated:0,review:0};
  t.buildEnd=2;t.pacing={outro:1};t.sceneBox=box();t.buildBox=box();
  t.camKeys=[];return t;
 };
 const obsolete={duration:1,mode:'kinematic',
  joints:[{id:'old-hinge',body:'old-model/removed-part',kind:'revolute',
    axis:[0,0,1],pivot:[0,0,0]}],
  driver:{joint:'old-hinge',amplitude:0.4,cycles:1}};
 const v4=load('src/anim/motion/v4/standardMotionV4.ts');
 fakeV3Timeline=makeBase();fakeV3Joints=[];
 const salvaged=v4.buildStandardMotionV4Timeline(a,met(),
  {targetSeconds:12,heroOrbit:false,planner:'standard-motion-v4',motionV4Mechanism:obsolete});
 c(salvaged.tracks.size,2);
 c(salvaged.motion.engine,'standard-motion-v4');
 c(!!salvaged.mechanismStage,false);
 assert(salvaged.motion.v4.planning.warnings.some(v=>v.includes('Optional mechanism was not run')));
 fakeV3Timeline=makeBase();
 const invalid=v4.buildStandardMotionV4Timeline(a,met(),
  {targetSeconds:12,heroOrbit:false,planner:'standard-motion-v4',
   motionV4Limits:[{moving:'moving',host:'wall',kind:'revolute',min:2,max:1,source:'user'}]});
 c(invalid.tracks.size,2);
 assert(invalid.motion.v4.planning.warnings.some(v=>v.includes('Invalid joint-limit rules disabled')));
 console.log('PASS stale optional model program and invalid joint stops cannot block Build');
}
console.log('ALL V4 offline safety checks passed (not a full application build)');
