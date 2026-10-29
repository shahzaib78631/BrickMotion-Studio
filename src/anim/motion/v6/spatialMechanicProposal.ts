/** Review-only bridge from V6 geometry-screened part pairs to V7 spatial
 * joint relationships. An ambiguous body/joint assignment is rejected, not
 * guessed. Geometric proximity is NEVER evidence of true tooth engagement.
 */
import type {GeometryCandidate} from './geometryScreen';
import type {SpatialLinkagePreview} from './spatialAdapter';
import type {SpatialMechanic} from './spatialConstraints';

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
  const id=`geometry:${candidate.id}`;
  const draft=candidate.draft;
  if(!draft)throw Error('Geometry screen has no authorable axis/tooth proposal');
  let mechanic:SpatialMechanic;
  switch(candidate.kind){
    case 'gear':case 'belt':case 'chain':{
      if(!draft.teethA||!draft.teethB)throw Error('Missing exact pitch/tooth counts; enter them manually');
      mechanic={id,kind:candidate.kind,input:jointFor(candidate.a,'hinge'),
        output:jointFor(candidate.b,'hinge'),inputTeeth:draft.teethA,outputTeeth:draft.teethB};
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
      mechanic={id,kind:'rack-pinion',rotary:jointFor(candidate.a,'hinge'),
        linear:jointFor(candidate.b,'slider'),pitchRadiusLdu:draft.pitchRadiusLdu};
      break;
    }
  }
  return {mechanic,status:'needs-author-review',rationale:
    'Joint assignment is unambiguous and coarse axes/pitch are plausible, but teeth, bearings, physical clearance and transmitted forces are NOT verified. Review this exact pair before animating.'};
}
