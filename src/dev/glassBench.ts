import * as THREE from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { stabilizePathTracer } from '../render/pathTracerNumerics';
import { initPartService, ensureParts, geometryOf, getColors, setStudLogos } from '../state/partService';
import { materialFor, setBrickMaterials } from '../render/materials';
import { transportGlass, transmittedFraction } from '../render/glassOptics';
import { ensureGlassThickness } from '../render/glassThickness';
import type { GlassLook } from '../render/looks';

const state={ready:false,error:'',shaderErrors:[] as string[],results:[] as unknown[],absorptionChecks:[] as unknown[],thickness:{} as Record<string,unknown>};
const canvas=document.getElementById('canvas') as HTMLCanvasElement;
const status=document.getElementById('status')!;
const qs=new URLSearchParams(location.search),w=Number(qs.get('w')??720),h=Number(qs.get('h')??440),samples=Number(qs.get('samples')??96);
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(1);renderer.setSize(w,h);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1;
renderer.debug.onShaderError=(gl,_program,vs,fs)=>{state.shaderErrors.push(`${gl.getShaderInfoLog(vs)}\n${gl.getShaderInfoLog(fs)}`);};
const camera=new THREE.PerspectiveCamera(35,w/h,.1,100);
camera.position.set(9,9,16);camera.lookAt(.6,.5,0);camera.updateMatrixWorld();
const nextFrame=()=>new Promise<void>(r=>requestAnimationFrame(()=>r()));
let busy=false;
function environment(){
 const width=256,height=128,data=new Float32Array(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  let v=y>85?.08:.25;
  if((x>65&&x<90&&y>27&&y<72)||(x>175&&x<182&&y>22&&y<80))v=5;
  if(y>10&&y<22)v=2;
  const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=v;data[i+3]=1;
 }
 const texture=new THREE.DataTexture(data,width,height,THREE.RGBAFormat,THREE.FloatType);
 texture.mapping=THREE.EquirectangularReflectionMapping;texture.needsUpdate=true;return texture;
}
const env=environment();
function baseScene(){
 const scene=new THREE.Scene();scene.background=new THREE.Color('#bcbcbc');scene.environment=env;
 const image=new Uint8Array(64*64*4);
 for(let y=0;y<64;y++)for(let x=0;x<64;x++){
  const i=(y*64+x)*4,v=((x>>3)^(y>>3))&1?210:70;image[i]=image[i+1]=image[i+2]=v;image[i+3]=255;
 }
 const texture=new THREE.DataTexture(image,64,64);texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;
 const floor=new THREE.Mesh(new THREE.PlaneGeometry(19,9),new THREE.MeshStandardMaterial({map:texture,roughness:1}));
 floor.rotation.x=-Math.PI/2;floor.position.y=-.005;scene.add(floor);
 return scene;
}
function sceneFor(mode:'legacy'|'live'|'path'){
 const scene=baseScene(),group=new THREE.Group();group.rotation.x=Math.PI;group.scale.setScalar(1/20);scene.add(group);
 const code=Number((document.getElementById('color') as HTMLSelectElement).value);
 const look=(document.getElementById('look') as HTMLSelectElement).value as GlassLook;
 setBrickMaterials({finish:'eyesight',palette:'studio',texture:'none',glass:look});
 const source=materialFor(getColors().get(code),false) as THREE.MeshPhysicalMaterial;
 const items=[
  {part:'3068b',x:-100,y:-8,z:0},
  {part:'3068b',x:-20,y:-8,z:0},{part:'3068b',x:20,y:-8,z:0},
  {part:'3068b',x:-20,y:-8,z:40},{part:'3068b',x:20,y:-8,z:40},
  {part:'3020',x:110,y:-8,z:15},{part:'3020',x:110,y:-16,z:15},{part:'3020',x:110,y:-24,z:15},
 ];
 for(const item of items){
  const part=geometryOf(item.part)!;
  for(const original of [part.main,part.mainDoubleSided].filter((v):v is THREE.BufferGeometry=>!!v)){
   state.thickness[item.part]=ensureGlassThickness(original);
   const geometry=original.clone();
   let material:THREE.MeshPhysicalMaterial;
   if(mode==='path')material=transportGlass(source);
   else{
    material=source.clone();material.onBeforeCompile=source.onBeforeCompile;material.customProgramCacheKey=()=>source.customProgramCacheKey()+'|glass-comparison-'+mode;
    if(mode==='legacy'){
     const tint=source.attenuationColor.clone(),milky=look==='milky';
     material.color.copy(tint).lerp(new THREE.Color(1,1,1),milky?.35:.8);
     material.transmission=milky?.3:look==='clear'?1:.92;
     const thickness=new Float32Array(geometry.attributes.position.count).fill(milky?1.6:1.2);
     geometry.setAttribute('bmGlassThickness',new THREE.BufferAttribute(thickness,1));
    }
   }
   const mesh=new THREE.Mesh(geometry,material);mesh.position.set(item.x,item.y,item.z);group.add(mesh);
  }
 }
 return scene;
}
function disposeScene(scene:THREE.Scene){scene.traverse(o=>{
 const mesh=o as THREE.Mesh;if(!mesh.isMesh)return;
 mesh.geometry.dispose();for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
  (material as THREE.MeshStandardMaterial).map?.dispose();material.dispose();
 }
});}
async function trace(scene:THREE.Scene,cam:THREE.Camera,count:number){
 const tracer=new WebGLPathTracer(renderer);
 Object.assign(tracer,{renderToCanvas:true,synchronizeRenderSize:true,dynamicLowRes:false,rasterizeScene:false,minSamples:0,renderDelay:0,fadeDuration:0,bounces:12,transmissiveBounces:32,filterGlossyFactor:0});
 tracer.setScene(scene,cam);
 stabilizePathTracer(tracer);
 while(tracer.samples<count){tracer.renderSample();if(Math.floor(tracer.samples)%4===0)await nextFrame();}
 return tracer;
}
function shot(name:string){
 const image=new Image();image.src=canvas.toDataURL();image.alt=name;
 const figure=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=name;figure.append(caption,image);document.getElementById('shots')!.append(figure);
}
async function compare(){
 if(busy||!state.ready)return;busy=true;state.results=[];document.getElementById('shots')!.replaceChildren();
 try{
  for(const mode of ['legacy','live','path'] as const){
   status.textContent='Rendering '+mode+'…';const scene=sceneFor(mode),start=performance.now();
   if(mode==='path'){const tracer=await trace(scene,camera,samples);shot(mode);tracer.dispose();}
   else{renderer.render(scene,camera);shot(mode);}
   state.results.push({mode,ms:performance.now()-start,width:w,height:h,samples:mode==='path'?samples:1});
   disposeScene(scene);
   if(state.shaderErrors.length)throw Error(state.shaderErrors.join('\n'));
  }
  const error=renderer.getContext().getError();if(error)throw Error('WebGL error '+error);
  status.textContent='Comparison complete';document.getElementById('results')!.textContent=JSON.stringify(state,null,2);
 }catch(e){state.error=String(e);throw e;}finally{busy=false;}
 return state;
}
/** Neutral-IOR slabs isolate absorption from Fresnel and refraction. Geometry
 * ray distances, rather than a photo fit, supply the independent expectation. */
async function verifyAbsorption(){
 const saved={tone:renderer.toneMapping,colorSpace:renderer.outputColorSpace,size:renderer.getSize(new THREE.Vector2())};
 renderer.setSize(64,64);renderer.toneMapping=THREE.NoToneMapping;renderer.outputColorSpace=THREE.LinearSRGBColorSpace;
 const cam=new THREE.OrthographicCamera(-.4,.4,.4,-.4,.01,10);cam.position.z=3;cam.lookAt(0,0,0);cam.updateMatrixWorld();
 const tint=new THREE.Color().setRGB(.3,.7,1),thickness=.2;
 try{
  for(const layers of [1,2,3]){
   const scene=new THREE.Scene();scene.background=new THREE.Color(1,1,1);
   const white=new THREE.DataTexture(new Float32Array(8*4*4).fill(1),8,4,THREE.RGBAFormat,THREE.FloatType);
   white.mapping=THREE.EquirectangularReflectionMapping;white.needsUpdate=true;scene.environment=white;scene.background=white;
   for(let layer=0;layer<layers;layer++){
    const geometry=new THREE.BoxGeometry(20,20,thickness*20).toNonIndexed();ensureGlassThickness(geometry);
    const material=materialFor(getColors().get(43),false) as THREE.MeshPhysicalMaterial;
    const m=transportGlass(material,'clear');m.color.setRGB(1,1,1);m.attenuationColor.copy(tint);m.ior=1.01;m.roughness=.02;m.transmission=1;
    const mesh=new THREE.Mesh(geometry,m);mesh.scale.setScalar(1/20);mesh.position.z=-layer*.4;scene.add(mesh);
   }
   const tracer=await trace(scene,cam,1024);
   const gl=renderer.getContext(),target=tracer.target,raw=new Float32Array(64*64*4);
   renderer.readRenderTargetPixels(target,0,0,64,64,raw);
   const mean=[0,0,0];let count=0;
   for(let y=8;y<56;y++)for(let x=8;x<56;x++){count++;for(let c=0;c<3;c++)mean[c]+=raw[(y*64+x)*4+c];}
   mean.forEach((v,c)=>mean[c]=v/count);
   if(mean.some(v=>!Number.isFinite(v)))throw Error("Non-finite traced radiance");
   const expected=transmittedFraction(tint,thickness*layers).toArray().map(v=>Math.round(v*255));
   const actual=mean.map(v=>Math.round(Math.min(1,Math.max(0,v))*255));
   const error=Math.max(...expected.map((v,i)=>Math.abs(v-actual[i])));
   state.absorptionChecks.push({layers,expected,actual,meanLinear:mean,samples:tracer.samples,averagedPixels:count,maxByteError:error});
   tracer.dispose();disposeScene(scene);white.dispose();
   if(state.shaderErrors.length)throw Error(state.shaderErrors.join("\n"));
   if(error>3)throw Error(`Absorption check failed: ${JSON.stringify(state.absorptionChecks.at(-1))}`);
  }
 }finally{renderer.setSize(saved.size.x,saved.size.y);renderer.toneMapping=saved.tone;renderer.outputColorSpace=saved.colorSpace;}
 return state.absorptionChecks;
}
Object.assign(window,{__aoBench:state,aoBench:{compare},glassBench:{compare,verifyAbsorption}});
document.getElementById('compare')!.onclick=()=>{void compare();};
async function main(){
 await initPartService();await setStudLogos(false);await ensureParts(['3068b','3020']);
 state.ready=true;status.textContent='Ready';
}
main().catch(e=>{state.error=String(e);status.textContent=state.error;console.error(e);});
