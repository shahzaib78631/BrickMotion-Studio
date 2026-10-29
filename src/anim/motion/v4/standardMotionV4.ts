/**
 * Standard Motion v4: six-phase mechanical animation engine.
 * Phase 1: build a real, shared connector mobility graph;
 * Phase 2: mesh-level continuous path certificates (or explicit unresolved);
 * Phase 3: actual signed joint limits and constrained FK, not guessed stops.
 * Phase 4: explicit gear ratios and closed-chain mechanism solving;
 * Phase 5: optional reduced-coordinate constrained gravity preview;
 * Phase 6: one timeline and baker/export transform sampler.
 *
 * In contrast to Construction V4, Standard Motion v4 is permissive and keeps
 * an editable visual fallback when mechanical feasibility cannot be proved.
 * No path is ever labelled certified unless its proof completed.
 */
import type { Box } from '../../../ldraw/flatten';
import { type Assembly, type Metrics } from '../../../model/assemble';
import type { AssemblySpot } from '../../../plan/types';
import type { MechanicalJoint } from '../../construction/mechanicalConstraintGraph';
import type { AnimOptions } from '../../pacing';
import type { PlanningProgress } from '../../planning';
import type { Move, Timeline } from '../../timeline';
import type { JointLimitRule } from './jointLimits';
import { constrainJointCandidate, matchingLimit, validateJointLimitRules } from './jointLimits';
import { buildMotionMechanismGraph, type MechanismEdge } from './mechanismGraph';
import { TimedMeshCertifier, type Certificate, type Verdict } from './meshCertifier';
import { adaptiveClearanceApproaches, clearanceApproaches, mechanicalApproaches, type MotionCandidate } from '../kinematicCandidates';
import { InstalledRouteIndex } from '../routeSelection';
import { buildStandardMotionTimeline, jointsFor } from '../standardMotion';
import { compileMechanismStage } from './mechanismStage';
import { validateMechanismProgram } from './mechanismProgram';
import { detectAutomaticMechanics, refineKnownMechanicalJoints } from './autoMechanics';

const join = (a:string,b:string) => a.localeCompare(b);
const severity=(status:Verdict)=>status==='clear'?0:status==='unverified'?1:2;
const convert = (move:Move,candidate:MotionCandidate):Move=>({ ...move,
  posePath: candidate.poses, kinematicSegments:candidate.kinematicSegments,translationPath:undefined });
/** Reject paths whose claimed pivot/axis disagrees with the engaged LDraw
 * connector. Comparing metadata labels alone could bind the wrong hinge. */
const agreesWithJoint = (candidate:MotionCandidate,edge:MechanismEdge):boolean => {
  for(const seg of candidate.kinematicSegments??[]){
    if(Math.abs(seg.axis.reduce((sum,n,k)=>sum+n*edge.axis[k],0))<0.995)return false;
    if(seg.kind==='revolute'){
      if(!seg.pivot)return false;
      const displacement=seg.pivot.map((n,i)=>n-edge.centre[i]);
      const projection=displacement.reduce((sum,n,k)=>sum+n*edge.axis[k],0);
      if(Math.hypot(...displacement.map((n,k)=>n-projection*edge.axis[k]))>0.75)return false;
    }
  }
  return true;
};
const freeLeaf = (tl:Timeline,key:string,move:Move)=>{
  const u=tl.units[move.unit],track=tl.tracks.get(key);
  return !!u && u.kind==='piece'&&u.keys.length===1&&u.keys[0]===key&&
    (track?.ctx??0)===0&&!move.rel&&!move.rigidDeltas?.length&&!move.stationary;
};

export function buildStandardMotionV4Timeline(asm:Assembly,metrics:Metrics,opts:AnimOptions,
  onProgress?: (p:PlanningProgress)=>void,layoutBox:Box|null=null,
  workBaySpots:Record<string,AssemblySpot>={}):Timeline {
  // A stale mechanism JSON program can refer to instance keys from a previous
  // model. Invalid optional demonstrations must never make ASSEMBLY planning fail.
  // They remain disabled and are explicitly reported for correction.
  const warnings:string[]=[];
  const configuredRules=opts.motionV4Limits??[];
  const validation=validateJointLimitRules(configuredRules);
  if(validation.length)warnings.push(`Invalid joint-limit rules disabled: ${validation.join('; ')}`);
  const rules:readonly JointLimitRule[]=validation.length?[]:configuredRules;
  const programErrors=opts.motionV4Mechanism?validateMechanismProgram(opts.motionV4Mechanism):[];
  if(programErrors.length)warnings.push(`Invalid mechanical demonstration disabled: ${programErrors.join('; ')}`);
  // In a large build, legacy Standard used to score 3-4 ENTIRE plans before
  // v4 even began. Use its same graph/placement baseline only once; v4 then
  // handles route choice and conservative collision review under bounded work.
  // V3 remains untouched for its ordinary callers.
  const large=asm.instances.length>32;
  const tl=buildStandardMotionTimeline(asm,metrics,opts,onProgress,layoutBox,workBaySpots,large);
  let hints:MechanicalJoint[]=[];
  try{hints=refineKnownMechanicalJoints(jointsFor(asm,metrics),asm);}
  catch{/* Incomplete shadow metadata cannot certify mobility. */}
  const graph=buildMotionMechanismGraph(asm,hints);
  // Never let optional metadata inference stop a correctly imported model.
  let detection:ReturnType<typeof detectAutomaticMechanics>;
  try { detection=detectAutomaticMechanics(asm,metrics,graph); }
  catch (error) {
    warnings.push(`Automatic mechanics could not be inferred: ${String((error as Error)?.message??error)}`);
    detection={scanned:asm.instances.length,described:0,connectors:0,movableJoints:0,
      kinds:{gear:0,turntable:0,hinge:0,axle:0,pin:0,shaft:0,wheel:0,other:asm.instances.length},
      parts:[],joints:[],gearMeshes:[],functionalHints:[],suggestions:[],warnings:['Detector failed; manual mechanisms remain available.']};
  }
  const now=()=>typeof performance==='undefined'?Date.now():performance.now();
  // A standard animation is always deliverable: exact verification is an
  // explicit review stage and cannot monopolize the worker indefinitely.
  const routeDeadline=now()+(large?7000:12000);
  let skippedRouteChecks=0,skippedCertificates=0;
  const verifier=new TimedMeshCertifier(asm,tl,metrics,graph,large?{
    maxExactPairs:12,maxDepth:5,maxIntervals:64,maxCandidatePairs:24,maxMilliseconds:24,
  }:{maxExactPairs:160,maxDepth:9,maxIntervals:320});
  const safeVerify=(key:string,move:Move,alternative?:Move):Certificate=>{
    try{return verifier.verify(key,move,alternative);}
    catch(error){return {status:'unverified',blockers:[],verifiedPairs:0,meshSweeps:0,
      examinedPairs:0,reason:`Collision verifier failed: ${String((error as Error)?.message??error)}`};}
  };
  const index=new InstalledRouteIndex(asm,tl,metrics);
  const byKey=new Map(asm.instances.map(inst=>[inst.key,inst]));
  const finish=new Map<string,number>();
  for(const [key,track] of tl.tracks){const last=track.moves.at(-1);
    if(last){const unit=tl.units[last.unit];if(unit)finish.set(key,unit.start+unit.dur);}}
  const routes=[...tl.tracks].sort((a,b)=>{
    const am=a[1].moves[0],bm=b[1].moves[0];
    return (am?tl.units[am.unit]?.start??0:0)-(bm?tl.units[bm.unit]?.start??0:0)||join(a[0],b[0]);
  });
  let tested=0,rerouted=0,declared=0,adjusted=0,rejected=0,conflicting=0;
  const considered=new Set<string>();
  let routesProcessed=0;
  for(const [key,track] of routes){
    routesProcessed++;
    if(now()>routeDeadline){skippedRouteChecks++;continue;}
    const m=track.moves[0],u=m&&tl.units[m.unit],inst=byKey.get(key);
    if(!u||!inst||!freeLeaf(tl,key,m))continue;
    const installed=new Set([...finish].filter(([,end])=>end<=u.start+1e-5).map(([id])=>id));
    const engaged=(graph.byBody.get(key)??[]).filter(edge=>installed.has(edge.a===key?edge.b:edge.a));
    let legacy:MotionCandidate|undefined;
    if(m.posePath?.length && m.kinematicSegments?.length)
      legacy={poses:m.posePath,motion:u.motion??'preview',kinematicSegments:m.kinematicSegments,preference:-0.25};
    const checkCandidate=(candidate:MotionCandidate):MotionCandidate|undefined=>{
      if(!candidate.kinematicSegments?.length)return candidate;
      const kind=candidate.kinematicSegments[0].kind;
      const matches=engaged.filter(e=>candidate.host?(e.a===candidate.host||e.b===candidate.host):
        (kind==='revolute'?e.motion==='revolute'||e.motion==='ball':true));
      for(const edge of matches){
        if(!agreesWithJoint(candidate,edge))continue;
        const host=edge.a===key?edge.b:edge.a;
        const mobility=graph.mobility(key,host,installed,kind);
        if(!mobility.allowed){conflicting++;continue;}
        const rule=matchingLimit(rules,key,host,edge,kind);
        const result=constrainJointCandidate(candidate,rule);
        if(rule)declared++;
        if(result.status==='violated'||result.status==='invalid-rule'){rejected++;continue;}
        if(result.status==='adjusted')adjusted++;
        considered.add(edge.id);
        return {...result.candidate!,host};
      }
      rejected++;
      return undefined;
    };
    const acceptedLegacy=legacy?checkCandidate(legacy):undefined;
    // No compatible host means the arc is NOT mechanically justified.
    const defaultMove:Move={...m,posePath:undefined,kinematicSegments:undefined,translationPath:undefined};
    let winner:Move=legacy&&!acceptedLegacy?defaultMove:m;
    const samples=large?12:16;
    let bestHits=index.assess(winner,key,inst.part,u.start,metrics,samples).hits;
    let currentCert:Certificate|undefined;
    // On small models verify the baseline before route ranking; this catches
    // thin-obstacle tunnelling even where an AABB sampler reports no hits.
    // On larger models a conservative bounded verification is performed for
    // troubled paths and in the final consistent replay below.
    if(!large){currentCert=safeVerify(key,m,winner);tested++;}
    const firstBlocked=currentCert?.status==='blocked';
    const mayImprove=bestHits>0||firstBlocked||winner!==m;
    if(mayImprove){
      const available:MotionCandidate[]=[];
      if(acceptedLegacy)available.push(acceptedLegacy);
      for(const edge of engaged.slice(0,4)){
        const host=edge.a===key?edge.b:edge.a;
        const kind=edge.motion==='revolute'||edge.motion==='ball'?'revolute':'prismatic';
        if(!graph.mobility(key,host,installed,kind).allowed)continue;
        for(const candidate of mechanicalApproaches(m,edge.joint,key)){
          const compatible=checkCandidate(candidate);
          if(compatible)available.push(compatible);
        }
      }
      const obstacles=index.obstacleBoxes(u.start,u.start+u.dur,key);
      const body=metrics(inst.part).full;
      available.push(...adaptiveClearanceApproaches(m,body,obstacles));
      const extent=Math.max(...[0,1,2].map(i=>body.max[i]-body.min[i]));
      available.push(...clearanceApproaches(m,extent));
      // First rank inexpensive visual paths. The exact mesh checker is NEVER
      // run for dozens of detours per piece as in the earlier stalled release.
      const scored:{move:Move;hits:number;preference:number}[]=[];
      // Include approach diversity (overhead and both transverse axes) before
      // spending any expensive broad-phase samples. Earlier versions checked
      // more than fifteen variations per brick regardless of model size.
      const rankedCandidates=large ? [
        ...available.filter(c=>!!c.kinematicSegments).slice(0,2),
        ...available.filter(c=>!c.kinematicSegments && c.motion==='clearance-route').slice(0,5),
      ] : available;
      for(const candidate of rankedCandidates.slice(0,large?6:18)){
        if(now()>routeDeadline)break;
        const alt=convert(m,candidate);
        const hint=index.assess(alt,key,inst.part,u.start,metrics,samples,candidate.host,false).hits;
        if(hint>bestHits && !firstBlocked)continue;
        scored.push({move:alt,hits:hint,preference:candidate.preference});
      }
      scored.sort((a,b)=>a.hits-b.hits||a.preference-b.preference);
      // Only a bounded number of promising routes are checked with the exact
      // verifier. If none is certified, preserve an editable, flagged preview.
      const attempts=large?2:4;
      for(const entry of scored.slice(0,attempts)){
        if(now()>routeDeadline)break;
        // Exact proof is still performed for small models. Large assemblies
        // choose a conservative AABB-ranked preview, verified once below.
        const proof=large?undefined:safeVerify(key,m,entry.move);
        if(proof)tested++;
        const oldScore=severity(currentCert?.status??'unverified');
        const nextScore=severity(proof?.status??'unverified');
        const better=nextScore<oldScore || nextScore===oldScore &&
          (entry.hits<bestHits || firstBlocked && proof?.status!=='blocked' && entry.hits<=bestHits);
        if(!better)continue;
        winner=entry.move;bestHits=entry.hits;currentCert=proof;
        if(proof?.status==='clear')break;
      }
      // With an exhausted proof budget, prefer a less-obstructed visual route
      // only when the original was blocked or the AABB advisory improves.
      if(winner===m && scored.length && (firstBlocked||scored[0].hits<bestHits)){
        winner=scored[0].move;bestHits=scored[0].hits;
      }
    }
    if(winner!==m){
      const changed=winner.posePath!==m.posePath||winner.kinematicSegments!==m.kinematicSegments;
      m.translationPath=winner.translationPath;
      m.posePath=winner.posePath;
      m.kinematicSegments=winner.kinematicSegments;
      if(changed){rerouted++;index.noteUpdatedMove(key,m);verifier.noteUpdatedMove(key,m);
        u.motion=winner.kinematicSegments?.some(s=>s.kind==='revolute')?'hinge':
          winner.kinematicSegments?.length?'pin-hole':'clearance-route';}
    }
    if(routesProcessed%12===0)onProgress?.({phase:'routing',completed:routesProcessed,total:routes.length,
      item:'Selecting bounded, editable Standard Motion v4 flights'});
  }
  // A consistent second replay is essential: changing earlier flights can
  // invalidate previously recorded moving-vs-moving or parked-piece conflicts.
  const issues:NonNullable<NonNullable<Timeline['motion']>['issues']>=[];
  let checked=0,certified=0,blocked=0,unverified=0,meshSweeps=0,meshPairs=0;
  const verificationDeadline=now()+(large?7000:12000);
  const unitStatus=new Map<number,Verdict>();
  for(const [key,track] of routes){
    for(const move of track.moves){
      const u=tl.units[move.unit];if(!u)continue;
      const deferred=now()>verificationDeadline;
      const cert=deferred ? (
        {status:'unverified',blockers:[],verifiedPairs:0,meshSweeps:0,examinedPairs:0,
          reason:'Global continuous-mesh review budget reached; flight preserved for editing'} as Certificate
      ) : safeVerify(key,move);
      if(deferred)skippedCertificates++;
      checked++;meshSweeps+=cert.meshSweeps;meshPairs+=cert.examinedPairs;
      const result=cert.status;
      if(result==='clear')certified++;
      else if(result==='blocked')blocked++;
      else unverified++;
      const prior=unitStatus.get(move.unit)??'clear';
      if(severity(result)>severity(prior))unitStatus.set(move.unit,result);
      else if(!unitStatus.has(move.unit))unitStatus.set(move.unit,result);
      if(result!=='clear' && issues.length<200)issues.push({key,unit:move.unit,
        time:u.start+(cert.firstHit??.5)*u.dur,blockers:cert.blockers,firstHit:cert.firstHit,
        status:result,reason:cert.reason});
    }
    if(checked%16===0)onProgress?.({phase:'validation',completed:checked,total:asm.instances.length,
      item:'Checking selected routes; unresolved geometry remains flagged'});
  }
  for(const [id,status] of unitStatus)tl.units[id].uncertified=status!=='clear';
  const matchedRules=new Set(rules.filter(rule=>graph.edges.some(edge=>
    (edge.a===rule.moving&&edge.b===rule.host || edge.b===rule.moving&&edge.a===rule.host) &&
    (!rule.type||rule.type===edge.type))).map(rule=>`${rule.moving}|${rule.host}|${rule.kind}`));
  if(skippedRouteChecks)warnings.push(`Candidate search was time-bounded for ${skippedRouteChecks} flight(s); original Standard routes were retained.`);
  if(skippedCertificates)warnings.push(`Mesh certification was time-bounded for ${skippedCertificates} flight(s); these are UNVERIFIED, never CLEAR.`);
  if (large && unverified)warnings.push(`${unverified} motion(s) require review; bounded mesh verification never treats a timeout or unsupported contact as CLEAR.`);
  tl.motion={...tl.motion,engine:'standard-motion-v4',parts:tl.tracks.size,articulated:tl.motion?.articulated??0,
    review:blocked+unverified,checked,obstructed:blocked,interferenceScore:blocked,
    issues,kinematics:tl.motion?.kinematics,
    v4:{version:1,phases:[1,2,3],graph:{edges:graph.edges.length,rigidClusters:graph.rigidClusters.length,
      constrainedBodies:asm.instances.length-graph.uncertainBodies.length,unknownBodies:graph.uncertainBodies.length},
      mesh:{certified,blocked,unverified,exactChecks:meshSweeps,candidateChecks:tested,pairsExamined:meshPairs,rerouted},
      planning:{mode:large?'bounded-preview':'mesh-reviewed',warnings:warnings.slice(0,12),
        retainedMoves:tl.tracks.size,limitedVerification:large,
        deferredRoutes:skippedRouteChecks,deferredCertificates:skippedCertificates},
      limits:{rules:rules.length,matches:matchedRules.size,checked:declared,adjusted,rejected,
        conflicts:conflicting,unspecified:graph.edges.length-considered.size},
      detection:{scanned:detection.scanned,described:detection.described,connectors:detection.connectors,movableJoints:detection.movableJoints,
        kinds:detection.kinds,matchedJoints:detection.joints.length,gearMeshes:detection.gearMeshes.length,
        jointDetails:detection.joints.slice(0,40).map(j=>({a:j.a,b:j.b,kind:j.kind,motion:j.motion,evidence:j.evidence})),
        gearDetails:detection.gearMeshes.slice(0,32).map(g=>({...g})),
        suggestions:detection.suggestions,warnings:detection.warnings}}};
  if(opts.motionV4Mechanism && !programErrors.length && !validation.length){
    try {
    const stage=compileMechanismStage(asm,metrics,tl,opts.motionV4Mechanism,rules,graph);
    tl.mechanismStage=stage;
    const originalOutro=tl.duration-tl.buildEnd;
    tl.duration=Math.max(tl.duration,stage.start+stage.duration+Math.max(.5,originalOutro));
    tl.pacing.outro=tl.duration-tl.buildEnd;
    tl.motion!.v4!.phases=[1,2,3,4,5,6];
    tl.motion!.v4!.demonstration={mode:stage.mode,bodies:stage.tracks.length,frames:stage.frames,
      gearPairs:stage.diagnostics.gearPairs,loopClosures:stage.diagnostics.loopClosures,
      maxClosureErrorLdu:stage.diagnostics.maxClosureErrorLdu,
      collisionStatus:stage.collisionStatus,
      approximateInertias:stage.diagnostics.approximateInertias};
    } catch(error) {
      // A program created for a different MPD may contain stale instance keys;
      // it can fail without preventing the helicopter assembly from rendering.
      tl.motion.v4!.planning!.warnings.push(`Optional mechanism was not run: ${String((error as Error)?.message??error)}`);
    }
  }
  return tl;
}
