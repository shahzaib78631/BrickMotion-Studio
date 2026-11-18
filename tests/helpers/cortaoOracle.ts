/** Independent scalar CPU transcription of CORTAO v1.0.1's occlusion-only
 * equations and default filter. It does not import the generated GLSL. */
import { type OrthographicCamera, type PerspectiveCamera } from 'three';
import masks from '../../src/render/cortao/occluders.json';
type V = [number, number, number];
const dot = (a: V, b: V) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const mul = (a: V, k: number): V => [a[0]*k,a[1]*k,a[2]*k];
const add = (a: V,b: V): V => [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const norm = (a: V): V => mul(a,1/Math.hypot(...a));
const clamp = (v: number, min: number, max: number) => Math.max(min,Math.min(max,v));
const bits = new DataView(new ArrayBuffer(4));
const asFloat = (n: number) => {bits.setUint32(0,n,true);return bits.getFloat32(0,true);};
const asUint = (n: number) => {bits.setFloat32(0,n,true);return bits.getUint32(0,true);};
const hash = (n: number) => Math.imul(n,n^(n>>>15))>>>0;
const seed = (x: number,y: number) => (Math.imul(x,1719413*929)^Math.imul(y,140473*2467*11))>>>0;
function basis(n: V): [V,V] {
 const a=1/(1+n[2]), b=n[0]*n[1]*a;
 return [[n[0]*n[0]*a-1,b,n[0]],[b,n[1]*n[1]*a-1,n[1]]];
}
export function expectedPacked(depth: Float32Array, normals: Float32Array, w: number,h: number,camera: PerspectiveCamera|OrthographicCamera) {
 const p='isPerspectiveCamera' in camera && camera.isPerspectiveCamera;
 const scale=Math.fround(p?(camera.near-camera.far)/(camera.near*camera.far):camera.far-camera.near);
 const offset=Math.fround(p?1/camera.near:camera.near), out=new Uint32Array(w*h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const i=y*w+x;if(depth[i]===(scale<0?1:0))continue;
  const d=Math.fround(Math.fround(depth[i]*scale)+offset);
  const linear=p?Math.fround(1/d):d;
  const n=norm([normals[i*4]*2-1,normals[i*4+1]*2-1,normals[i*4+2]*2-1]);
  const random=hash(seed(x,y)), dx=(random&65535)/65535,dy=(random>>>16)/65535;
  const a=1/Math.sqrt(n[2]*2+2);
  const nx=Math.floor(n[0]*a*15+dx)&31,ny=Math.floor(n[1]*a*15+dy)&31;
  out[i]=((asUint(linear)&~1023)|(nx|(ny<<5)))>>>0;
 }
 return out;
}
export function selectedMip(base: Uint32Array,w: number,h: number,level: number) {
 const mw=Math.max(1,w>>level),mh=Math.max(1,h>>level),out=new Uint32Array(mw*mh);
 // Forward scatter, independently of the fragment adapter's inverse mapping.
 for(let sy=0;sy<h;sy++)for(let sx=0;sx<w;sx++){
  let x=sx,y=sy,valid=true;
  for(let l=1;l<=level;l++){
   const nx=x>>>1,ny=y>>>1;
   if(((x^ny)|(y^nx))&1){valid=false;break;}
   x=nx;y=ny;
   if(x>=Math.max(1,w>>l)||y>=Math.max(1,h>>l)){valid=false;break;}
  }
  if(valid)out[y*mw+x]=base[sy*w+sx];
 }
 return out;
}
function decode(n: number): V {
 const x=(n<<27)>>27,y=(n<<22)>>27,ex=x/15,ey=y/15,z=1-ex*ex-ey*ey;
 return [ex*2*Math.sqrt(z),ey*2*Math.sqrt(z),z*2-1];
}
export function rawOracle(packed: Uint32Array[], normals: Float32Array, camera: PerspectiveCamera|OrthographicCamera,w: number,h: number,radius: number) {
 const p=camera.projectionMatrix.elements,inv=camera.projectionMatrixInverse.elements;
 const perspective='isPerspectiveCamera' in camera && camera.isPerspectiveCamera;
 const unproject=(u: number,v: number,d: number): V => perspective
  ?[(2*u-1+p[8])*inv[0]*d,(2*v-1+p[9])*inv[5]*d,-d]
  :[(2*u-1)*inv[0]+inv[12],(2*v-1)*inv[5]+inv[13],-d];
 const apparent=inv[5]*.4,maxCoefficient=apparent/Math.sqrt(apparent*apparent+1);
 const mipBias=Math.log2(p[5]*h*.5)-4,normalBias=inv[0]/w*Math.SQRT2;
 const sample=(u: number,v: number,lod: number) => {
  if(u<0||v<0||u>=1||v>=1)return 0;
  const l=clamp(Math.floor(lod+.5),0,packed.length-1),mw=Math.max(1,w>>l),mh=Math.max(1,h>>l);
  return packed[l][Math.floor(v*mh)*mw+Math.floor(u*mw)];
 };
 const out=new Uint8Array(w*h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const i=y*w+x,d=asFloat(packed[0][i]);out[i]=255;if(d===0)continue;
  const uv=[(x+.5)/w,(y+.5)/h], n=norm([normals[i*4]*2-1,normals[i*4+1]*2-1,normals[i*4+2]*2-1]);
  let pos=unproject(uv[0],uv[1],d);
  const random=hash(seed(x,y)),rotation=random*(2*Math.PI/4294967295),dither=random/4294967295;
  const sr=[Math.sin(rotation),Math.cos(rotation)];
  const r=perspective?Math.min(radius,d*maxCoefficient):radius;
  const vd: V=perspective?mul(norm(pos),-1):[0,0,1];
  const apparentR=perspective?r/Math.sqrt(d*d-r*r):1;
  const circleRadius=perspective?apparentR*d:r;
  const bias=perspective?normalBias*d:normalBias;
  pos=add(pos,mul(n,bias));
  const [right0,up]=perspective?basis(vd):[[1,0,0],[0,1,0]] as [V,V];
  const right=perspective && (random&1)===0?mul(right0,-1):right0;
  const [t,bt]=basis(n); // seed 0 gives random.x == random.y and tangent rotation 0.
  let rayBits=0;
  for(let j=0;j<16;j++){
   const angle=j*2.3999632297286533,inner=(j/16)**1.75,outer=((j+1)/16)**1.75;
   const radial=inner+(outer-inner)*dither,sx=Math.cos(angle)*radial,sy=Math.sin(angle)*radial;
   const rx=circleRadius*(sr[0]*sx+sr[1]*sy),ry=circleRadius*(-sr[1]*sx+sr[0]*sy);
   let u: number,v: number;
   if(perspective){
    const cp=add(pos,add(mul(right,rx),mul(up,ry)));
    u=(.5*p[0]*cp[0]+(-.5+.5*p[8])*cp[2])/-cp[2];
    v=(.5*p[5]*cp[1]+(-.5+.5*p[9])*cp[2])/-cp[2];
   }else{u=uv[0]+.5*p[0]*rx;v=uv[1]+.5*p[5]*ry;}
   const lod=(perspective?Math.log2(apparentR/Math.sqrt(vd[2])):0)+mipBias+Math.log2(outer);
   const packedSample=sample(u,v,lod),sd=asFloat(packedSample);
   const delta=add(unproject(u,v,sd),mul(pos,-1)),len2=dot(delta,delta);
   if(len2>=r*r||dot(delta,n)<=0)continue;
   const sn=decode(packedSample),slope=1/Math.sqrt(Math.max(dot(sn,vd),.25));
   let dir=mul(delta,1/Math.sqrt(len2)),occluderR=r*Math.sqrt(outer*outer-inner*inner)*slope/Math.sqrt(len2);
   if(dot(sn,dir)<.5){
    const offset=-occluderR/Math.max(1-occluderR*occluderR*.5,.000001);
    dir=norm(add(dir,mul(sn,offset)));
   }else occluderR*=1+(slope-1)*.5;
   const hemi: V=[dot(dir,t),dot(dir,bt),dot(dir,n)];if(hemi[2]<=-.99)continue;
   const m=1/Math.sqrt(hemi[2]*8+8);
   const lx=clamp(Math.floor((hemi[0]*m+.5)*24),0,23),ly=clamp(Math.floor((hemi[1]*m+.5)*24),0,23),lz=clamp(Math.floor(occluderR*Math.SQRT1_2*16),0,15);
   rayBits|=masks[(lz*24+ly)*24+lx];
  }
  let count=0;for(let b=rayBits;b;b&=b-1)count++;
  out[i]=Math.round((1-count/16)*255);
 }
 return out;
}
export function filterOracle(packed: Uint32Array,raw: Uint8Array,w: number,h: number) {
 const out=new Uint8Array(w*h);
 const at=(x: number,y: number)=>clamp(y,0,h-1)*w+clamp(x,0,w-1);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const i=y*w+x;if(!packed[i]){out[i]=255;continue;}
  const bx=x|1,by=y|1,coords=[[bx-1,by],[bx,by],[bx,by-1],[bx-1,by-1]];
  const component=coords.findIndex(([cx,cy])=>cx===x&&cy===y);
  const ds=coords.map(([cx,cy])=>asFloat(packed[at(cx,cy)])),d=ds[component];
  const dx=(component<2?ds[0]-ds[1]:ds[3]-ds[2])/d*512;
  const dy=(component===0||component===3?ds[3]-ds[0]:ds[2]-ds[1])/d*512;
  const nx=(packed[i]<<27)>>27,ny=(packed[i]<<22)>>27;
  let sum=raw[i]/255,weights=1;
  for(const [ox,oy] of [[3,0],[-3,0],[0,3],[0,-3]]){
   const si=at(x+ox,y+oy),word=packed[si],sx=(word<<27)>>27,sy=(word<<22)>>27;
   const err=Math.abs(asFloat(word)/d*512-512+dx*ox+dy*oy)+((sx-nx)**2+(sy-ny)**2)*.5;
   const weight=2**(-err);sum+=raw[si]/255*weight;weights+=weight;
  }
  out[i]=Math.round(sum/weights*255);
 }
 return out;
}
