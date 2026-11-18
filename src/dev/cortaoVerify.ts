import * as THREE from 'three';
import { CortaoPass } from '../render/cortao/pass';
import { bindCortaoLighting, installCortaoLighting } from '../render/cortao/lighting';
import { expectedPacked, selectedMip, rawOracle, filterOracle } from '../../tests/helpers/cortaoOracle';

const state = { ready: false, error: '', shaderErrors: [] as string[], results: [] as unknown[], lightingResults: {} as Record<string, unknown> };
Object.assign(window, { __aoBench: state, aoBench: { compare: () => state } });
const renderer = new THREE.WebGLRenderer();
renderer.debug.onShaderError = (gl, _program, vs, fs) => {
  state.shaderErrors.push(`${gl.getShaderInfoLog(vs)}\n${gl.getShaderInfoLog(fs)}`);
  console.error(state.shaderErrors.at(-1));
};
function compare(a: ArrayLike<number>,b: ArrayLike<number>) {
 let max=0,total=0,different=0;
 for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);total+=d;if(d)different++;}
 return {maxError:max,meanError:total/a.length,different,total:a.length};
}
async function verify() {
 for(const projection of ['perspective','ortho'] as const) for(const scene of ['plane','step','tilted','tilted-step','sky'] as const) {
  const w=49,h=35;
  const camera=projection==='perspective'?new THREE.PerspectiveCamera(50,w/h,.1,100):new THREE.OrthographicCamera(-3.5,3.5,2.5,-2.5,.1,100);
  const depth=new Float32Array(w*h),normals=new Float32Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const i=y*w+x,uv=new THREE.Vector3((x+.5)/w*2-1,(y+.5)/h*2-1,.5).unproject(camera);
   const origin=projection==='perspective'?new THREE.Vector3():new THREE.Vector3(uv.x,uv.y,0);
   const direction=projection==='perspective'?uv.normalize():new THREE.Vector3(0,0,-1);
   const n=new THREE.Vector3(scene.startsWith('tilted')?.3:0,scene.startsWith('tilted')?.2:0,1).normalize();
   let t=(-5-n.dot(origin))/n.dot(direction);
   const point=origin.clone().addScaledVector(direction,t);
   if(scene.includes('step')){
    t=(-4.5-origin.z)/direction.z;
    const front=origin.clone().addScaledVector(direction,t);
    if(Math.abs(front.x)<.75&&Math.abs(front.y)<.75){point.copy(front);n.set(0,0,1);}
   }
   depth[i]=scene==='sky'?1:point.project(camera).z*.5+.5;
   normals[i*4]=n.x*.5+.5;normals[i*4+1]=n.y*.5+.5;normals[i*4+2]=n.z*.5+.5;normals[i*4+3]=1;
  }
  const dt=new THREE.DataTexture(depth,w,h,THREE.RedFormat,THREE.FloatType),nt=new THREE.DataTexture(normals,w,h,THREE.RGBAFormat,THREE.FloatType);
  dt.needsUpdate=nt.needsUpdate=true;
  const output=new THREE.WebGLRenderTarget(w,h,{depthBuffer:false,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
  const pass=new CortaoPass();pass.render(renderer,camera,dt,nt,output,1.5);
  if(state.shaderErrors.length)throw Error(state.shaderErrors.join('\n'));
  const read=pass.readback(renderer),filtered=new Uint8Array(w*h*4);
  renderer.readRenderTargetPixels(output,0,0,w,h,filtered);
  const actualRaw=Uint8Array.from({length:w*h},(_,i)=>read.raw[i*4]);
  const actualFiltered=Uint8Array.from({length:w*h},(_,i)=>filtered[i*4]);
  const expected=expectedPacked(depth,normals,w,h,camera);
  // Packed FP32 depth can differ by a few ULP across GPU FMA implementations.
  const depthError=compare(read.packed[0].map(v=>v>>>10),expected.map(v=>v>>>10));
  const normalError=compare(read.packed[0].map(v=>v&1023),expected.map(v=>v&1023));
  for(let level=1;level<read.packed.length;level++){
   const expectedMip=selectedMip(read.packed[0],w,h,level);
   if(compare(expectedMip,read.packed[level]).maxError)throw Error(`${projection}/${scene}: mip ${level} differs from reference scatter`);
  }
  const referenceRaw=rawOracle(read.packed,normals,camera,w,h,1.5);
  const rawError=compare(actualRaw,referenceRaw);
  const filterError=compare(actualFiltered,filterOracle(read.packed[0],actualRaw,w,h));
  const result={projection,scene,depthError,normalError,rawError,filterError};state.results.push(result);
  if(normalError.maxError||depthError.maxError>1||rawError.maxError>1||filterError.maxError>1)throw Error(`Reference mismatch: ${JSON.stringify(result)}`);
  if((scene==='plane'||scene==='sky')&&actualRaw.some(v=>v!==255))throw Error('Unoccluded plane/sky is occluded');
  if(scene.includes('step')&&!actualRaw.some(v=>v<255))throw Error(`${projection} step fixture has no occlusion: ${JSON.stringify(result)}`);
  if(renderer.getContext().getError())throw Error('WebGL error');
  pass.dispose();output.dispose();dt.dispose();nt.dispose();
 }
 // Verify the host integration independently of AO estimation: black visibility
 // must affect ambient light, preserve direct light/emission, and stay out of
 // another camera's reflection render.
 const material=new THREE.MeshStandardMaterial({color:0xffffff,roughness:1});
 installCortaoLighting(material);
 const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);
 camera.position.z=5;camera.lookAt(0,0,0);camera.updateMatrixWorld();
 const geometry=new THREE.PlaneGeometry(2,2);scene.add(new THREE.Mesh(geometry,material));
 const ambient=new THREE.AmbientLight(0xffffff,1),direct=new THREE.DirectionalLight(0xffffff,1);
 direct.position.set(0,0,4);scene.add(ambient,direct);
 const rt=new THREE.WebGLRenderTarget(16,16,{depthBuffer:false});
 const black=new THREE.DataTexture(new Uint8Array([0,0,0,255]),1,1);black.needsUpdate=true;
 renderer.toneMapping=THREE.NoToneMapping;
 const render=(ao: boolean,otherCamera=false)=>{
  bindCortaoLighting(ao?black:null,null,new THREE.Vector4(0,0,16,16),1,0,camera);
  renderer.setRenderTarget(rt);renderer.render(scene,otherCamera?camera.clone():camera);
  const pixel=new Uint8Array(4);renderer.readRenderTargetPixels(rt,8,8,1,1,pixel);
  bindCortaoLighting(null);return Array.from(pixel.slice(0,3));
 };
 ambient.visible=false;
 const directBefore=render(false),directAfter=render(true);
 if(compare(directBefore,directAfter).maxError)throw Error('AO changed direct lighting');
 direct.visible=false;ambient.visible=true;
 const ambientBefore=render(false),ambientAfter=render(true),reflection=render(true,true);
 if(!ambientBefore.some(v=>v>0)||ambientAfter.some(v=>v!==0))throw Error('AO failed to occlude ambient lighting');
 if(compare(ambientBefore,reflection).maxError)throw Error('Screen AO leaked into another camera');
 ambient.visible=false;material.emissive.setRGB(.2,.1,.05);
 const emissionBefore=render(false),emissionAfter=render(true);
 if(compare(emissionBefore,emissionAfter).maxError)throw Error('AO changed emission');
 state.lightingResults={directBefore,directAfter,ambientBefore,ambientAfter,reflection,emissionBefore,emissionAfter};
 material.dispose();geometry.dispose();rt.dispose();black.dispose();renderer.setRenderTarget(null);
 if(state.shaderErrors.length)throw Error(state.shaderErrors.join('\n'));
 state.ready=true;document.getElementById('result')!.textContent=JSON.stringify(state,null,2);
}
verify().catch(e=>{state.error=String(e);document.getElementById('result')!.textContent=state.error;console.error(e);});
