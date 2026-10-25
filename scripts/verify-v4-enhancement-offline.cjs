// Offline focused numerical tests. Not equivalent to full browser / Vitest verification.
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),Module=require('module');
// esbuild ships with Vite; the `typescript` package here is the native 7.x
// preview, which no longer exposes transpileModule/ModuleKind/ScriptTarget.
const esbuild=require('esbuild');
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

const {verifyMechanismCollision,playbackSweptBox,meshBoxTree}=load('src/anim/motion/v4/mechanismCollision.ts');
const {countGearTeeth,refineKnownMechanicalJoints,detectAutomaticMechanics}=load('src/anim/motion/v4/autoMechanics.ts');
const box={min:[-.45,-.45,-.45],max:[.45,.45,.45]};
function cube(h=.45){
 const pts=[[-h,-h,-h],[h,-h,-h],[h,h,-h],[-h,h,-h],[-h,-h,h],[h,-h,h],[h,h,h],[-h,h,h]];
 const faces=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[3,7,6,2],[0,4,7,3],[1,2,6,5]];
 const out=[];for(const [a,b,c,d] of faces)for(const i of [a,b,c,a,c,d])out.push(...pts[i]);
 return new Float32Array(out);
}
const mesh=cube();
function assembly(keys){return {instances:keys.map(([key,pos,part])=>({key,part:part??key,world:new Matrix4().makeTranslation(...(pos??[0,0,0])),worldBox:box,placeholder:false})),nodes:[],problems:[],bounds:box};}
function stage(tracks,frames=3){return {start:10,duration:1,frames,sampleHz:24,mode:'kinematic',collisionStatus:'unverified',tracks:tracks.map(([key,poses])=>({key,deltas:poses.map(p=>p.elements.slice())})),diagnostics:{joints:1,gearPairs:0,loopClosures:0,rigidFollowers:0,maxClosureErrorLdu:0,physicsSteps:0,approximateInertias:0,sampledAabbOverlapAdvisories:0}};}
const at=(x=0,y=0,z=0)=>new Matrix4().makeTranslation(x,y,z);
const metrics=(part)=>({id:part,full:box,body:box,placeholder:false,mesh});
const check=(label,fn)=>{try{fn();console.log('PASS',label);}catch(e){console.error('FAIL',label,e.stack);process.exitCode=1;}};
check('gear tooth counts only from explicit LDraw header',()=>{
 assert.equal(countGearTeeth('Technic Gear  8 Tooth'),8);
 assert.equal(countGearTeeth('Technic Gear 24 Teeth'),24);
 assert.equal(countGearTeeth('Technic Gear without size'),null);
 assert.equal(countGearTeeth('Tyre 12.7/ 51 x 30'),null);
});
check('stationary distant obstacle continuously clear',()=>{
 const a=assembly([['A',[0,0,0]],['B',[100,0,0]]]),s=stage([['A',[at(),at(4),at()]]]);
 const r=verifyMechanismCollision(a,metrics,s);
 assert.equal(r.status,'clear');assert.equal(r.clearPairs,1);assert.equal(r.blockedPairs,0);
});
check('hundreds of stationary parts are all examined, never skipped',()=>{
 const members=[['moving',[0,0,0]]];
 for(let k=0;k<500;k++)members.push([`P${k}`,[150+k*3,0,0]]);
 const a=assembly(members),s=stage([['moving',[at(),at(6),at()]]]);
 const r=verifyMechanismCollision(a,metrics,s);
 assert.equal(r.status,'clear');assert.equal(r.checkedPairs,500);assert.equal(r.clearPairs,500);
});
check('static obstruction mid-way between mechanism samples gets blocked',()=>{
 const a=assembly([['A',[0,0,0]],['B',[2.5,0,0]]]),s=stage([['A',[at(),at(5),at()]]]);
 const r=verifyMechanismCollision(a,metrics,s);
 assert.equal(r.status,'blocked',JSON.stringify(r));assert(r.issues.some(x=>x.b==='B'));
});
check('stale part broadphase bounds cannot hide real triangles',()=>{
 const a=assembly([['A',[0,0,0]],['B',[2.5,0,0]]]),s=stage([['A',[at(),at(5),at()]]]);
 const lying=p=>({...metrics(p),full:{min:[-.001,-.001,-.001],max:[.001,.001,.001]}});
 const r=verifyMechanismCollision(a,lying,s);
 assert.equal(r.status,'blocked',JSON.stringify(r));
});
check('two simultaneously moving solids cannot tunnel through',()=>{
 const a=assembly([['A',[-2,0,0]],['B',[2,0,0]]]);
 const s=stage([['A',[at(),at(4),at()]],['B',[at(),at(-4),at()]]]);
 const r=verifyMechanismCollision(a,metrics,s);
 assert.equal(r.status,'blocked',JSON.stringify(r));assert.equal(r.blockedPairs,1);
});
check('quarter-segment collision found despite clear midpoint',()=>{
 const a=assembly([['A',[0,0,0]],['B',[1,0,0]]]);
 const s=stage([['A',[at(-3),at(3)]]],2);
 const r=verifyMechanismCollision(a,metrics,s);
 assert.equal(r.status,'blocked',JSON.stringify(r));
});
check('duplicated playback tracks cannot be certified',()=>{
 const a=assembly([['A',[0,0,0]]]);
 const s=stage([['A',[at(),at(.1)]],['A',[at(),at(.2)]]],2);
 const r=verifyMechanismCollision(a,metrics,s);
 assert.equal(r.status,'unverified',JSON.stringify(r));
});
check('unavailable remote mesh fails closed',()=>{
 const a=assembly([['A',[0,0,0]],['B',[100,0,0]]]),s=stage([['A',[at(),at(5),at()]]]);
 const r=verifyMechanismCollision(a,p=>p==='B'?{full:box,body:box,placeholder:true}:metrics(p),s);
 assert.equal(r.status,'unverified');assert.equal(r.unverifiedPairs,1);
});
check('same assembled intersection does not become false new obstruction',()=>{
 const a=assembly([['A',[0,0,0]],['B',[0,0,0]]]);
 const s=stage([['A',[at(),at(.1),at()]]]);
 const r=verifyMechanismCollision(a,metrics,s);
 assert.equal(r.status,'unverified',JSON.stringify(r));
});
check('all degenerate triangle geometry is not certified clear',()=>{
 const degenerate=new Float32Array([0,0,0,1,0,0,2,0,0]);
 const a=assembly([['A',[0,0,0]],['B',[100,0,0]]]),s=stage([['A',[at(),at(5),at()]]]);
 const r=verifyMechanismCollision(a,p=>p==='A'?{...metrics(p),mesh:degenerate}:metrics(p),s);
 assert.equal(r.status,'unverified',JSON.stringify(r));
});
check('conservative budgets do not certify uncertain path',()=>{
 const a=assembly([['A',[0,0,0]],['B',[1,0,0]]]);
 const s=stage([['A',[at(),at(.2),at()]]]);
 const r=verifyMechanismCollision(a,metrics,s,undefined,undefined,{maxNodeTests:0});
 assert.equal(r.status,'unverified',JSON.stringify(r));
});
check('part-and-connector-based gear pitch auto detection',()=>{
 const a=assembly([['gearA',[0,0,0],'3647.dat'],['gearB',[40,0,0],'3648.dat']]);
 const graph={edges:[],rigidClusters:[['gearA'],['gearB']],uncertainBodies:['gearA','gearB'],isMate:()=>false};
 const fm=part=>({...metrics(part),description:part==='3647.dat'?'Technic Gear 8 Tooth':'Technic Gear 24 Tooth',
 snaps:[{kind:'cyl',gender:'F',shapes:['A'],axis:[0,0,1],start:[0,0,-1],length:2}]});
 const r=detectAutomaticMechanics(a,fm,graph);
 assert.equal(r.kinds.gear,2);assert.equal(r.gearMeshes.length,1,JSON.stringify(r));
 assert(r.suggestions.some(p=>p.program.gears?.length===1),JSON.stringify(r));
});
check('turntable pair only upgraded when matched connector engaged',()=>{
 const a=assembly([['base',null,'3403.dat'],['top',null,'3404.dat']]);
 const joints=[{id:'turn',male:'base',female:'top',type:'cylindrical',motion:'fixed',axis:[0,1,0],centre:[0,0,0],engagement:9}];
 assert.equal(refineKnownMechanicalJoints(joints,a)[0].motion,'revolute');
 assert.equal(refineKnownMechanicalJoints([{...joints[0],engagement:0}],a)[0].motion,'fixed');
 assert.equal(refineKnownMechanicalJoints([{...joints[0],type:'stud-socket'}],a)[0].motion,'fixed');
 assert.equal(refineKnownMechanicalJoints([{...joints[0],centre:[20,0,0]}],a)[0].motion,'fixed');
});
check('detected hinge proposal uses exact keys; no guessed joint stops',()=>{
 const a=assembly([['A',null,'4275b.dat'],['B',null,'4276b.dat']]);
 const edge={id:'hinge',a:'A',b:'B',motion:'revolute',axis:[0,0,1],centre:[0,0,0],type:'hinge'};
 const graph={edges:[edge],rigidClusters:[['A'],['B']],uncertainBodies:[],isMate:()=>true};
 const fm=p=>({...metrics(p),description:'Hinge Plate'});
 const r=detectAutomaticMechanics(a,fm,graph);
 assert.equal(r.suggestions.length,1,JSON.stringify(r));
 assert.equal(r.suggestions[0].program.joints[0].body,'A');
 assert(!r.suggestions[0].program.joints[0].limits);
});
if(process.exitCode)process.exit(process.exitCode);
