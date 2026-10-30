/**
 * Optional author-reviewed linkage rig interchange. This is not an automatic
 * inference or a signed physics certificate. JSON never mutates model parts.
 * Explicit member mapping allows custom hinges when LDCad metadata is absent.
 */
import type { Assembly } from '../../../model/assemble';
import { SpatialMechanismSolver, validateSpatialModel, type SpatialModel } from '../kinematics/spatialModel';
import type { SpatialLinkagePreview } from './spatialAdapter';

export const SPATIAL_RIG_FORMAT='brickmotion-v7-mechanics-rig';
export const SPATIAL_RIG_V8_FORMAT='brickmotion-v8-mechanics-rig';
const V8_MECHANICS=new Set(['slider-crank','scotch-yoke','linear-coupler','hydraulic-pair',
 'backlash-gear','detent','cam-profile','intermittent-indexer','differential-drive']);
export const SPATIAL_RIG_LEGACY_FORMAT='brickmotion-v6-spatial-rig';
export function serializeSpatialRig(preview:SpatialLinkagePreview):string {
 const newFeature=preview.model.mechanics?.some(m=>V8_MECHANICS.has(m.kind));
 return JSON.stringify({format:newFeature?SPATIAL_RIG_V8_FORMAT:SPATIAL_RIG_FORMAT,
  version:newFeature?3:2,model:preview.model,members:preview.members,driver:preview.driver},null,2);
}

export function parseSpatialRig(text:string,asm:Assembly):SpatialLinkagePreview {
 if(typeof text!=='string'||text.length>1024*1024)throw Error('Spatial rig JSON must be text of at most 1 MB');
 let obj:unknown;
 try {obj=JSON.parse(text);} catch {throw Error('Invalid spatial rig JSON');}
 if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error('Spatial rig must be a JSON object');
 const doc=obj as Record<string,unknown>;
 if(!((doc.format===SPATIAL_RIG_V8_FORMAT&&doc.version===3)||
   (doc.format===SPATIAL_RIG_FORMAT&&doc.version===2)||
   (doc.format===SPATIAL_RIG_LEGACY_FORMAT&&doc.version===1)))
  throw Error(`Use format "${SPATIAL_RIG_V8_FORMAT}" version 3 (V7 v2 and V6 v1 also supported)`);
 const model=doc.model as SpatialModel;
 if(!model||!Array.isArray(model.bodies)||!Array.isArray(model.constraints))
  throw Error('Spatial rig requires a model containing bodies and constraints arrays');
 for(const c of model.constraints){
  if(!c||typeof c!=='object'||!['hinge','slider','ball','weld','distance','cylindrical','universal','planar'].includes(c.kind))
   throw Error('Unsupported spatial constraint; expected hinge, slider, ball, weld, distance, cylindrical, universal or planar');
 }
 let errors:string[];
 try {errors=validateSpatialModel(model);} catch {throw Error('Malformed spatial constraint body or anchor');}
 if(errors.length)throw Error(errors.join(' · '));
 if(typeof doc.driver!=='string')throw Error('Spatial rig needs an explicit motor joint ID');
 const driver=model.constraints.find(c=>c.id===doc.driver);
 if(!driver||(driver.kind!=='hinge'&&driver.kind!=='slider'))
  throw Error('Motor must reference an existing single-angle hinge or single-axis slider');
 if(!doc.members||typeof doc.members!=='object'||Array.isArray(doc.members))
  throw Error('Spatial rig requires an explicit body-to-instance members map');
 const raw=doc.members as Record<string,unknown>;
 if(Object.keys(raw).length>16)throw Error('Spatial rig exceeds the 16-body members limit');
 const ids=new Set(asm.instances.filter(i=>!i.placeholder).map(i=>i.key));
 const bodyIds=new Set(model.bodies.map(b=>b.id));
 const mapped=new Set<string>();
 let total=0;
 const members:Record<string,string[]>=Object.create(null);
 for(const [body,partList] of Object.entries(raw)){
  if(!bodyIds.has(body)||!Array.isArray(partList)||!partList.length)
   throw Error(`Members entry ${body}: use an existing rigid body and a nonempty array`);
  const checked:string[]=[];
  for(const key of partList){
   if(typeof key!=='string'||!ids.has(key))throw Error(`Members entry ${body}: unknown placed instance ${String(key)}`);
   if(mapped.has(key))throw Error(`Part ${key} appears in multiple rigid bodies`);
   mapped.add(key);checked.push(key);
   if(++total>180)throw Error('Spatial rig exceeds 180 moving/grounded part instances');
  }
  members[body]=checked;
 }
 if(Object.keys(members).length!==model.bodies.length)
  throw Error('Every spatial rigid body must map to one or more placed instance keys');
 // Constructor also verifies that the imported assembly actually closes at
 // rest; importing a malformed/inconsistent rig cannot animate random parts.
 new SpatialMechanismSolver(model);
 return {model,members,driver:doc.driver,kind:driver.kind,
  source:'user-authored-json',warning:
   'User-authored spatial mechanics rig: bodies, gear ratios, axes, stops, contact and ground require independent review. Preview and sampled sweep do not certify collision, forces, rope tension or real-world motion.'};
}
