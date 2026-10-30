/** Review-only bridge from V6 geometry-screened part pairs to V7 spatial
 * joint relationships. An ambiguous body/joint assignment is rejected, not
 * guessed. Geometric proximity is NEVER evidence of true tooth engagement.
 */
import type {GeometryCandidate} from './geometryScreen';
import type {SpatialLinkagePreview} from './spatialAdapter';
import type {Q4,SpatialMechanic,V3} from '../kinematics/spatialModel';

const rotate=(q:Q4,v:V3):V3=>{
  const [x,y,z,w]=q,[vx,vy,vz]=v;
  const tx=2*(y*vz-z*vy),ty=2*(z*vx-x*vz),tz=2*(x*vy-y*vx);
  return [vx+w*tx+y*tz-z*ty,vy+w*ty+z*tx-x*tz,vz+w*tz+x*ty-y*tx];
};

export type SpatialMechanicProposal={
  mechanic:SpatialMechanic;
  status:'needs-author-review';
  rationale:string;
};
export function proposeSpatialMechanic(candidate:GeometryCandidate,
  preview:SpatialLinkagePreview):SpatialMechanicProposal {
  if(candidate.status!=='plausible'||candidate.confidence!=='geometry-consistent-review-required')
    throw Error('Only geometry-screened plausible pairs can be proposed; rejected contacts remain rejected');
  const owners=new Map<string,string>();
  for(const [body,members] of Object.entries(preview.members))for(const key of members){
    if(owners.has(key))throw Error(`Ambiguous rigid-body membership for ${key}`);
    owners.set(key,body);
  }
  const jointFor=(key:string,kind:'hinge'|'slider'):string=>{
    const body=owners.get(key);
    if(!body)throw Error(`Part ${key} is outside the active spatial rig`);
    const found=preview.model.constraints.filter(c=>
      (c.kind==='hinge'||c.kind==='slider')&&c.kind===kind&&
      (c.a.body===body||c.b.body===body)
    );
    if(found.length!==1)throw Error(`${key}: expected exactly one ${kind} joint on this body; found ${found.length}. Choose the correct joint in the V7 composer rather than guessing.`);
    return found[0].id;
  };
  /** +1 when the joint's coordinate grows as `key` turns (or slides) positively
   * about the measured world axis, -1 when it shrinks. The joint measures body b
   * against body a about a's axis, so the owning side and the axis both matter. */
  const sense=(jointId:string,key:string,measured:V3):1|-1=>{
    const c=preview.model.constraints.find(x=>x.id===jointId);
    if(!c||!('axisA' in c))throw Error(`${jointId}: joint has no axis`);
    const rest=preview.model.bodies.find(b=>b.id===c.a.body)?.rest;
    if(!rest)throw Error(`${jointId}: unknown body ${c.a.body}`);
    const w=rotate(rest.q,c.axisA),d=w[0]*measured[0]+w[1]*measured[1]+w[2]*measured[2];
    if(Math.abs(d)<1e-6*Math.hypot(...w))throw Error(`${jointId}: joint axis is not along the measured axis`);
    return (d>0?1:-1)*(c.b.body===owners.get(key)?1:-1) as 1|-1;
  };
  const id=`geometry:${candidate.id}`;
  const draft=candidate.draft;
  if(!draft)throw Error('Geometry screen has no authorable axis/tooth proposal');
  let mechanic:SpatialMechanic;
  switch(candidate.kind){
    case 'gear':case 'bevel':case 'belt':case 'chain':{
      if(!draft.teethA||!draft.teethB)throw Error('Missing exact pitch/tooth counts; enter them manually');
      const input=jointFor(candidate.a,'hinge'),output=jointFor(candidate.b,'hinge');
      const teeth={inputTeeth:draft.teethA,outputTeeth:draft.teethB};
      if(candidate.kind==='belt'||candidate.kind==='chain'){
        mechanic={id,kind:candidate.kind,input,output,...teeth};break;
      }
      // Measured pairs know which way the output turns about each shaft;
      // translate that into the two joints' own sign conventions.
      const same=draft.axisA&&draft.axisB&&draft.reversed!==undefined
        ?sense(input,candidate.a,draft.axisA)*sense(output,candidate.b,draft.axisB)*(draft.reversed?1:-1)===1
        :undefined;
      if(candidate.kind==='bevel'){
        if(same===undefined)throw Error('Bevel pair has no measured axes; author its direction manually');
        mechanic={id,kind:'bevel-gear',input,output,...teeth,...(same?{}:{reversed:true})};
      }else mechanic={id,kind:'gear',input,output,...teeth,...(same?{internal:true}:{})};
      break;
    }
    case 'worm':{
      if(!draft.starts||!draft.teethB)throw Error('Missing worm starts or driven wheel teeth');
      mechanic={id,kind:'worm',input:jointFor(candidate.a,'hinge'),
        output:jointFor(candidate.b,'hinge'),starts:draft.starts,wheelTeeth:draft.teethB};
      break;
    }
    case 'rack-pinion':{
      if(!draft.pitchRadiusLdu)throw Error('Unknown pinion pitch radius');
      const rotary=jointFor(candidate.a,'hinge'),linear=jointFor(candidate.b,'slider');
      const flipped=draft.axisA&&draft.slideAxis&&draft.reversed!==undefined&&
        sense(rotary,candidate.a,draft.axisA)*sense(linear,candidate.b,draft.slideAxis)*(draft.reversed?-1:1)===-1;
      mechanic={id,kind:'rack-pinion',rotary,linear,pitchRadiusLdu:draft.pitchRadiusLdu,...(flipped?{reversed:true}:{})};
      break;
    }
  }
  return {mechanic,status:'needs-author-review',rationale:
    'Joint assignment is unambiguous and coarse axes/pitch are plausible, but teeth, bearings, physical clearance and transmitted forces are NOT verified. Review this exact pair before animating.'};
}
