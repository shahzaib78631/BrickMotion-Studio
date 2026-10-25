/** Phase 6: codec-friendly, deterministic transform playback.
 * Every delta is a WORLD rigid displacement from the exact assembled pose.
 * During demo export we interpolate rotation as a quaternion (never blend
 * matrix entries), and after demo the original final transform is restored.
 */
import * as THREE from 'three';
import type { MechanismStage } from '../../timelineData';
const cache=new WeakMap<MechanismStage,Map<string,MechanismStage['tracks'][number]>>();
function lookup(stage:MechanismStage,key:string){
  let entries=cache.get(stage);
  if(!entries){entries=new Map(stage.tracks.map(t=>[t.key,t]));cache.set(stage,entries);}
  return entries.get(key);
}
export function hasMechanismTrack(stage:MechanismStage,key:string):boolean{return !!lookup(stage,key);}
export function mechanismPoseAt(stage:MechanismStage,t:number,key:string,base:THREE.Matrix4):THREE.Matrix4|null {
  const track=lookup(stage,key);
  if(!track || t<stage.start-1e-9 || t>stage.start+stage.duration+1e-9)return null;
  const n=track.deltas.length;
  if(n!==stage.frames || n<2)return null;
  const f=Math.max(0,Math.min(n-1,(t-stage.start)/stage.duration*(n-1)));
  const a=Math.min(n-2,Math.floor(f)),u=f-a;
  const m0=new THREE.Matrix4().fromArray(track.deltas[a]),m1=new THREE.Matrix4().fromArray(track.deltas[a+1]);
  if(!m0.elements.every(Number.isFinite)||!m1.elements.every(Number.isFinite))return null;
  const p0=new THREE.Vector3(),p1=new THREE.Vector3();
  const q0=new THREE.Quaternion(),q1=new THREE.Quaternion();
  const s0=new THREE.Vector3(),s1=new THREE.Vector3();
  m0.decompose(p0,q0,s0);m1.decompose(p1,q1,s1);
  // The stage writer rejects nonrigid deltas. Interpolating scale here would
  // otherwise distort geometry when an authored part has a mirrored basis.
  const pose=new THREE.Matrix4().compose(p0.lerp(p1,u),q0.slerp(q1,u),new THREE.Vector3(1,1,1));
  return pose.multiply(base);
}
