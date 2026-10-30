/** V8 deterministic offline spatial pose-clip baker.
 * Exports body positions/orientations and explicit members mapping, not
 * collision-verified or dynamics-certified keyframes. No Three/browser APIs.
 */
import {SpatialMechanismSolver,type SpatialModel,type SpatialPose} from '../kinematics/spatialModel';
export type SpatialClipRig={model:SpatialModel;members:Readonly<Record<string,readonly string[]>>};
export type SpatialClipOptions={
  driver:string;amplitude:number;mode:'forward'|'oscillate';
  durationSeconds:number;sampleHz:number;
  additionalMotors?:Readonly<Record<string,number>>;
};
export type SpatialClipFrame={
  timeSeconds:number;driverPosition:number;
  maxResidualLdu:number;
  poses:Readonly<Record<string,SpatialPose>>;
};
export type SpatialClip={
  format:'brickmotion-v8-sampled-spatial-clip';version:1;
  evidence:'sampled-ideal-kinematics-only';
  source:{model:SpatialModel;members:Readonly<Record<string,readonly string[]>>};
  options:SpatialClipOptions;
  frames:SpatialClipFrame[];
  summary:{checkedFrames:number;maximumResidualLdu:number;durationSeconds:number};
  disclaimer:string;
};
/** Fail-closed: an invalid frame throws and no apparently certified clip is
 * emitted. Accepts up to eight turns when step size preserves winding. */
export function bakeSpatialClip(preview:SpatialClipRig,options:SpatialClipOptions):SpatialClip{
 if(!preview||!preview.model||!preview.members)throw Error('Spatial clip needs a reviewed rig and members mapping');
 const {driver,amplitude,mode,durationSeconds,sampleHz}=options??{} as SpatialClipOptions;
 const joint=preview.model.constraints.find(c=>c.id===driver);
 if(!joint||(joint.kind!=='hinge'&&joint.kind!=='slider'))throw Error('Clip driver must be a hinge or slider');
 if(mode!=='forward'&&mode!=='oscillate')throw Error('Unsupported clip motion mode');
 if(!Number.isFinite(durationSeconds)||durationSeconds<.25||durationSeconds>12||
    !Number.isInteger(sampleHz)||sampleHz<4||sampleHz>60)
  throw Error('Clip duration must be .25–12 seconds and sampling 4–60 Hz');
 const count=Math.round(durationSeconds*sampleHz)+1;
 if(count>241)throw Error('Spatial clip is limited to 241 frames; reduce the duration or sample rate');
 if(!Number.isFinite(amplitude)||amplitude<=0||
   (joint.kind==='hinge'&&amplitude>Math.PI*16)||
   (joint.kind==='slider'&&amplitude>2000))
  throw Error('Invalid spatial clip amplitude');
 const swing=mode==='oscillate'?2*Math.PI:1;
 if(joint.kind==='hinge'&&amplitude*swing/(count-1)>=Math.PI*.85)
  throw Error('Clip angular step could lose the correct winding branch; increase sampling');
 if(mode==='oscillate'&&preview.model.mechanics?.some(m=>m.kind==='ratchet'&&m.engaged!==false))
  throw Error('One-way ratchet requires a forward-only spatial clip');
 const secondary=options.additionalMotors??{};
 if(!secondary||typeof secondary!=='object'||Array.isArray(secondary))throw Error('Invalid additional clip motors');
 if(Object.prototype.hasOwnProperty.call(secondary,driver))throw Error('Additional clip motors must not override driver');
 for(const [id,value]of Object.entries(secondary)){
  const c=preview.model.constraints.find(c=>c.id===id);
  if(!c||(c.kind!=='hinge'&&c.kind!=='slider')||!Number.isFinite(value))
   throw Error(`Invalid clip motor ${id}`);
 }
 const solver=new SpatialMechanismSolver(preview.model);
 const frames:SpatialClipFrame[]=[];let maxResidual=0;
 for(let i=0;i<count;i++){
  const progress=i/(count-1);
  const position=mode==='forward'?amplitude*progress:amplitude*Math.sin(progress*2*Math.PI);
  const frame=solver.solve({...secondary,[driver]:position},{maxIterations:85,toleranceLdu:.035});
  if(frame.status!=='converged')throw Error(`Clip failed at sample ${i}/${count-1} (${(progress*durationSeconds).toFixed(3)}s): ${frame.warning??'Linkage did not close'}`);
  maxResidual=Math.max(maxResidual,frame.maxResidualLdu);
  const poses:Record<string,SpatialPose>=Object.create(null);
  for(const [id,p]of frame.poses)poses[id]={p:[...p.p],q:[...p.q]};
  frames.push({timeSeconds:durationSeconds*progress,driverPosition:position,maxResidualLdu:frame.maxResidualLdu,poses});
 }
 return {
  format:'brickmotion-v8-sampled-spatial-clip',version:1,
  evidence:'sampled-ideal-kinematics-only',
  source:{model:structuredClone(preview.model),members:structuredClone(preview.members)},
  options:{...options,additionalMotors:{...secondary}},frames,
  summary:{checkedFrames:count,maximumResidualLdu:maxResidual,durationSeconds},
  disclaimer:'Offline sampled 3D rigid-body poses only. No intermediate continuous collision certificate, loads, force dynamics, string tension, contact, tire slip, render-stage integration, or verified LEGO-set behavior.',
 };
}
