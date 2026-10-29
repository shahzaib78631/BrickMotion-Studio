/** Phase 6: compile a mechanical demonstration to deterministic, editable
 * playback samples. The saved samples are world-rigid DELTAS from authored
 * assembly, so codec, exporter, viewport, and rebaker all sample one source.
 * Continuous mesh verification is applied after the final sampled paths are baked.
 */
import * as THREE from 'three';
import type { Assembly, Metrics } from '../../../model/assemble';
import { transformBox, unionBox } from '../../../model/assemble';
import type { Timeline } from '../../timeline';
import type { MechanismStage } from '../../timelineData';
import type { MechanismProgram } from './mechanismProgram';
import { MechanismSolver } from './mechanismSolver';
import { ReducedGravityPreview } from './physicsPreview';
import type { JointLimitRule } from './jointLimits';
import type { MechanismGraph } from './mechanismGraph';
import { verifyMechanismCollision } from './mechanismCollision';
const ease=(x:number)=>x*x*(3-2*x);
const IDENTITY=new THREE.Matrix4();
function matrixDistance(a:THREE.Matrix4,b:THREE.Matrix4){return Math.max(...a.elements.map((v,i)=>Math.abs(v-b.elements[i])));}

export function compileMechanismStage(asm:Assembly,metrics:Metrics,tl:Timeline,program:MechanismProgram,
  limits:readonly JointLimitRule[]=[], graph?:MechanismGraph):MechanismStage {
  const solver=new MechanismSolver(asm,program,limits);
  const sampleHz=program.sampleHz??60;
  const count=Math.max(2,Math.ceil(program.duration*sampleHz)+1);
  const leaders=program.joints.map(j=>j.body);
  const followers=new Map<string,string>();
  for(const group of program.rigidFollowers??[])
    for(const body of group.bodies){
      if(!solver.rest.has(body))throw Error(`Missing rigid follower ${body}`);
      followers.set(body,group.leader);
    }
  const animated=[...new Set([...leaders,...followers.keys()])].sort();
  // An explicitly fixed LDCad connection must never be ripped apart by a
  // demonstration: every connected moving member needs the SAME rigid delta.
  const clusterOwner=(body:string)=>followers.get(body)??(leaders.includes(body)?body:null);
  for(const edge of graph?.edges??[])if(edge.motion==='fixed'){
    const a=clusterOwner(edge.a),b=clusterOwner(edge.b);
    if((a||b) && a!==b)throw Error(`Fixed connection ${edge.id} would separate ${edge.a} from ${edge.b}; add welded members as rigidFollowers or correct connector metadata`);
  }
  if(count*animated.length>40000)throw Error('Mechanism exceeds 40,000 pose samples. Reduce duration, frequency or moving bodies.');
  // Reject time-varying assembly bases: machine demo is post-assembly and its
  // source matrices must be IDENTICAL to the authored final scene.
  for(const key of animated){
    const rest=solver.rest.get(key)!,track=tl.tracks.get(key);
    if(!track || matrixDistance(rest,track.final)>.01)
      throw Error(`Body ${key} has no matching authored final timeline pose`);
  }
  const frames=animated.map(key=>({key,deltas:[] as number[][]}));
  const originals=new Map(animated.map(key=>[key,solver.rest.get(key)!]));
  const inverse=new Map(animated.map(key=>[key,solver.rest.get(key)!.clone().invert()]));
  let worstClosure=0, worstTransmissionResidual=0, inertiaApproximations=0;
  let engine:ReducedGravityPreview|null=null;
  if(program.mode==='gravity'){
    engine=new ReducedGravityPreview(solver,asm,metrics);
    inertiaApproximations=engine.approximateInertias;
  }
  let preceding=0;
  let collisionHints=0;
  const instances=new Map(asm.instances.map(i=>[i.key,i]));
  const restBoxes=asm.instances.map(i=>({key:i.key,box:i.worldBox}));
  let cameraBounds=tl.sceneBox;
  const frameAt=(q:number,progress:number,endpoint:boolean)=>{
    const independent=program.mode==='kinematic' ? (program.secondaryMotors??[]) : [];
    const result=independent.length
      ? solver.solveInputs({[program.driver.joint]:q,
          ...Object.fromEntries(independent.map(m=>[m.joint,
            endpoint?0:m.amplitude*Math.sin(2*Math.PI*(m.cycles??1)*progress)]))})
      : solver.solve(q);
    worstClosure=Math.max(worstClosure,result.maxClosureErrorLdu);
    worstTransmissionResidual=Math.max(worstTransmissionResidual,result.transmissionResidual??0);
    const all=new Map(result.poses);
    for(const [body,leader] of followers){
      const leaderPose=all.get(leader)!;
      all.set(body,leaderPose.clone().multiply(solver.rest.get(leader)!.clone().invert()).multiply(originals.get(body)!));
    }
    return all;
  };
  let physicsSteps=0;
  const animatedKeys=new Set(animated);
  const sampledStride=Math.max(1,Math.ceil(sampleHz/10));
  const overlaps=(a:typeof restBoxes[number]['box'],b:typeof restBoxes[number]['box'])=>
    [0,1,2].every(k=>a.max[k]>b.min[k]+.02&&b.max[k]>a.min[k]+.02);
  for(let i=0;i<count;i++){
    const t=i/(count-1)*program.duration,progress=t/program.duration;
    let q=0;
    if(program.mode==='kinematic'){
      q=i===0||i===count-1?0:program.driver.amplitude*Math.sin(2*Math.PI*(program.driver.cycles??1)*progress);
    }else {
      const gravity=program.gravity!;
      const preload=.18,releaseEnd=.86;
      if(progress<preload){q=gravity.releaseAt*ease(progress/preload);}
      else if(progress<releaseEnd){
        if(preceding<preload*program.duration){engine!.reset(gravity.releaseAt);preceding=preload*program.duration;}
        const end=t;
        while(preceding<end-1e-10){
          const dt=Math.min(1/240,end-preceding);
          engine!.step(dt);physicsSteps++;
          preceding+=dt;
        }
        q=engine!.position;
      }else{
        // Clearly signalled cinematic reset; not a physical force/impact.
        q=engine!.position*(1-ease((progress-releaseEnd)/(1-releaseEnd)));
      }
      if(i===0||i===count-1)q=0;
    }
    const all=frameAt(q,progress,i===0||i===count-1);
    for(const track of frames){
      const delta=(all.get(track.key)??originals.get(track.key)!).clone().multiply(inverse.get(track.key)!);
      if(delta.elements.some(v=>!Number.isFinite(v)))throw Error(`Nonfinite mechanism transform: ${track.key}`);
      // Preserve the EXACT zero pose at the demo endpoints.
      track.deltas.push(i===0||i===count-1 ? IDENTITY.elements.slice() : delta.elements.slice());
    }
    if(i%sampledStride===0){
      const movingBoxes=animated.map(key=>{
        const part=instances.get(key)!;
        const box=transformBox(metrics(part.part).full,all.get(key)??originals.get(key)!);
        cameraBounds=unionBox(cameraBounds,box);
        return {key,box};
      });
      if(i>0 && i<count-1){
        // Broad-phase ADVISORIES only; connected gear teeth and studs can
        // legitimately have overlapping bounding boxes. Do not call clear.
        const parked=restBoxes.filter(item=>!animatedKeys.has(item.key));
        for(let j=0;j<movingBoxes.length;j++){
          const a=movingBoxes[j];
          for(const b of parked)if(overlaps(a.box,b.box))collisionHints++;
          for(let k=j+1;k<movingBoxes.length;k++)
            if(overlaps(a.box,movingBoxes[k].box))collisionHints++;
        }
      }
    }
  }
  // Every driven/follower body must return EXACTLY to its authored matrix.
  if(frames.some(t=>matrixDistance(new THREE.Matrix4().fromArray(t.deltas.at(-1)!),IDENTITY)>1e-10))
    throw Error('Mechanism failed to return to assembled pose');
  tl.sceneBox=unionBox(tl.sceneBox,cameraBounds);
  tl.buildBox=unionBox(tl.buildBox,cameraBounds);
  for(const cam of tl.camKeys)if(cam.t>=tl.buildEnd-0.1)cam.box=unionBox(cam.box,cameraBounds);
  const stage:MechanismStage={start:tl.buildEnd+.2,duration:program.duration,frames:count,sampleHz,mode:program.mode,
    collisionStatus:'unverified',tracks:frames,
    diagnostics:{joints:program.joints.length,gearPairs:program.gears?.length??0,
      transmissionConstraints:program.transmissions?.filter(t=>t.kind!=='clutch'||t.engaged).length??0,
      maxTransmissionResidual:worstTransmissionResidual,secondaryMotorTracks:program.secondaryMotors?.length??0,
      loopClosures:program.closures?.length??0,rigidFollowers:followers.size,
      maxClosureErrorLdu:worstClosure,physicsSteps,approximateInertias:inertiaApproximations,
      sampledAabbOverlapAdvisories:collisionHints}};
  try {
    const cert=verifyMechanismCollision(asm,metrics,stage,graph,program);
    stage.collisionStatus=cert.status;
    stage.diagnostics.continuousCollision=cert;
  } catch(error) {
    // Never let an unexpected checker failure result in an accepted/certified
    // mechanism. Playback survives for review with an explicit unresolved mark.
    stage.collisionStatus='unverified';
    stage.diagnostics.continuousCollision={checkedPairs:0,clearPairs:0,blockedPairs:0,
      unverifiedPairs:1,testedIntervals:0,triangleNodeTests:0,staticWitnesses:0,
      issues:[{a:'(verification)',b:'(engine)',time:stage.start,status:'unverified',
        reason:`Verifier failed: ${String((error as Error)?.message??error)}`}]};
  }
  return stage;
}
