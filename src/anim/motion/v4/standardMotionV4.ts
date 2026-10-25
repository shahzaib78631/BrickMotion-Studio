/**
 * Standard Motion v4: three-phase mechanical animation engine.
 * Phase 1: build a real, shared connector mobility graph;
 * Phase 2: mesh-level continuous path certificates (or explicit unresolved);
 * Phase 3: actual signed joint limits and constrained FK, not guessed stops.
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
  const rules: readonly JointLimitRule[]=opts.motionV4Limits ?? [];
  const validation=validateJointLimitRules(rules);
  if(validation.length) throw new Error(`Invalid Standard Motion v4 joint limits: ${validation.join('; ')}`);
  // Keep V3's tested sequencing / pivots / staging / exact authored placement.
  const tl=buildStandardMotionTimeline(asm,metrics,opts,onProgress,layoutBox,workBaySpots);
  let hints:MechanicalJoint[]=[];
  try{hints=jointsFor(asm,metrics);}catch{/* Incomplete shadow metadata cannot certify mobility. */}
  const graph=buildMotionMechanismGraph(asm,hints);
  const verifier=new TimedMeshCertifier(asm,tl,metrics,graph,{
    maxExactPairs:asm.instances.length>800?160:640,maxDepth:9,maxIntervals:320,
  });
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
  const considered = new Set<string>();
  let routesProcessed=0;
  for(const [key,track] of routes){
    routesProcessed++;
    const m=track.moves[0],u=m&&tl.units[m.unit],inst=byKey.get(key);
    if(!u||!inst||!freeLeaf(tl,key,m))continue;
    const installed=new Set([...finish].filter(([,end])=>end<=u.start+1e-5).map(([id])=>id));
    const engaged=(graph.byBody.get(key)??[]).filter(edge=>installed.has(edge.a===key?edge.b:edge.a));
    const available:MotionCandidate[]=[];
    let legacy:MotionCandidate|undefined;
    if(m.posePath?.length && m.kinematicSegments?.length){
      legacy={poses:m.posePath,motion:u.motion??'preview',
        kinematicSegments:m.kinematicSegments,preference:-0.25};
    }
    const checkCandidate=(candidate:MotionCandidate):MotionCandidate|undefined=>{
      if(!candidate.kinematicSegments?.length)return candidate;
      const kind=candidate.kinematicSegments[0].kind;
      const matches=engaged.filter(e=>candidate.host ? (e.a===candidate.host||e.b===candidate.host) :
        (kind==='revolute'?e.motion==='revolute'||e.motion==='ball':true));
      for(const edge of matches){
        if(!agreesWithJoint(candidate,edge))continue;
        const host=edge.a===key?edge.b:edge.a;
        const mobility=graph.mobility(key,host,installed,kind);
        if(!mobility.allowed){conflicting++;continue;}
        const rule=matchingLimit(rules,key,host,edge,kind);
        const result=constrainJointCandidate(candidate,rule);
        if(rule)declared++;
        if(result.status==='violated'||result.status==='invalid-rule'){
          rejected++;continue;
        }
        if(result.status==='adjusted')adjusted++;
        considered.add(edge.id);
        return {...result.candidate!,host};
      }
      // No valid active joint -> do not invent a pivot without a host.
      rejected++;
      return undefined;
    };
    // V3's selected kinematic segment must also pass V4's mobility & limit
    // gate. If not, an ordinary unconstrained insertion can still be planned.
    if(legacy){
      const c=checkCandidate(legacy);
      if(c)available.push(c);
    }
    for(const edge of engaged.slice(0,8)){
      const host=edge.a===key?edge.b:edge.a;
      const kind=edge.motion==='revolute'||edge.motion==='ball'?'revolute':'prismatic';
      if(!graph.mobility(key,host,installed,kind).allowed)continue;
      for(const candidate of mechanicalApproaches(m,edge.joint,key)){
        const compatible=checkCandidate(candidate);
        if(compatible)available.push(compatible);
      }
    }
    const defaultMove:Move={...m,posePath:undefined,kinematicSegments:undefined,translationPath:undefined};
    // Explicitly include a valid unconstrained option when the v3 arc violates
    // a declared stop. Such free-flight happens BEFORE the connector engages.
    const baselineAllowed=!legacy||available.some(c=>c.poses===m.posePath);
    let winner=baselineAllowed?m:defaultMove;
    let best=verifier.verify(key,m,winner===m?undefined:winner);
    tested++;
    const baselineScore=()=>index.assess(winner,key,inst.part,u.start,metrics,16).hits;
    let hint=baselineScore();
    const evaluate=(candidate:MotionCandidate)=>{
      const alt=convert(m,candidate);
      const certificate=verifier.verify(key,m,alt);tested++;
      const severityScore=severity(certificate.status), bestScore=severity(best.status);
      if(severityScore>bestScore)return;
      // Among equally uncertified options, prefer fewer advisory overlaps.
      const aabb=severityScore?index.assess(alt,key,inst.part,u.start,metrics,16,candidate.host,false).hits:0;
      if(severityScore===bestScore && (aabb>hint||aabb===hint&&candidate.preference>=0))return;
      best=certificate;winner=alt;hint=aabb;
    };
    const isWinnerClear=()=>best.status==='clear';
    if(!isWinnerClear()){
      for(const candidate of available){
        evaluate(candidate);
        if(isWinnerClear())break;
      }
    }
    if(!isWinnerClear()){
      // The mesh checker, not AABB rank, decides which obstacle-size approach
      // actually wins. Its rigorous envelopes include staged and flying parts.
      const obstacles=index.obstacleBoxes(u.start,u.start+u.dur,key);
      const body=metrics(inst.part).full;
      for(const candidate of adaptiveClearanceApproaches(m,body,obstacles)){
        evaluate(candidate);if(isWinnerClear())break;
      }
      if(!isWinnerClear()){
        const extent=Math.max(...[0,1,2].map(i=>body.max[i]-body.min[i]));
        for(const candidate of clearanceApproaches(m,extent)){
          evaluate(candidate);if(isWinnerClear())break;
        }
      }
    }
    if(winner!==m){
      const changed=winner.posePath!==m.posePath||winner.kinematicSegments!==m.kinematicSegments;
      m.translationPath=winner.translationPath;
      m.posePath=winner.posePath;
      m.kinematicSegments=winner.kinematicSegments;
      if(changed){rerouted++;index.noteUpdatedMove(key,m);u.motion=winner.kinematicSegments?.some(s=>s.kind==='revolute')?'hinge':
        winner.kinematicSegments?.length?'pin-hole':'clearance-route';}
    }
    if(routesProcessed%32===0)onProgress?.({phase:'validation',completed:routesProcessed,total:routes.length,
      item:'Verifying continuous mesh paths and joint constraints'});
  }
  // A consistent second replay is essential: changing earlier flights can
  // invalidate previously recorded moving-vs-moving or parked-piece conflicts.
  const issues:NonNullable<NonNullable<Timeline['motion']>['issues']>=[];
  let checked=0,certified=0,blocked=0,unverified=0,meshSweeps=0,meshPairs=0;
  const unitStatus=new Map<number,Verdict>();
  for(const [key,track] of routes){
    for(const move of track.moves){
      const u=tl.units[move.unit];if(!u)continue;
      const cert=verifier.verify(key,move);
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
  }
  for(const [id,status] of unitStatus)tl.units[id].uncertified=status!=='clear';
  const matchedRules=new Set(rules.filter(rule=>graph.edges.some(edge=>
    (edge.a===rule.moving&&edge.b===rule.host || edge.b===rule.moving&&edge.a===rule.host) &&
    (!rule.type||rule.type===edge.type))).map(rule=>`${rule.moving}|${rule.host}|${rule.kind}`));
  tl.motion={...tl.motion,engine:'standard-motion-v4',parts:tl.tracks.size,articulated:tl.motion?.articulated??0,
    review:blocked+unverified,checked,obstructed:blocked,interferenceScore:blocked,
    issues,kinematics:tl.motion?.kinematics,
    v4:{version:1,phases:[1,2,3],graph:{edges:graph.edges.length,rigidClusters:graph.rigidClusters.length,
      constrainedBodies:asm.instances.length-graph.uncertainBodies.length,unknownBodies:graph.uncertainBodies.length},
      mesh:{certified,blocked,unverified,exactChecks:meshSweeps,candidateChecks:tested,pairsExamined:meshPairs,rerouted},
      limits:{rules:rules.length,matches:matchedRules.size,checked:declared,adjusted,rejected,
        conflicts:conflicting,unspecified:graph.edges.length-considered.size}}};
  return tl;
}
