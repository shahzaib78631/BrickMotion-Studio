/**
 * Geometry-screened (still UNVERIFIED) LEGO mechanism candidates. No mesh
 * collision / tooth flank / axle clearance is decided by bounding boxes.
 *
 * Unlike V5 description-only suggestions, each result carries the actual
 * shaft-angle, pitch-distance and cluster checks that accepted or rejected it.
 * All measurements are in assembled world LDraw units. No filename guessing.
 */
// Structural inputs keep the screening math independent of Three.js.
export type Vec3 = [number,number,number];
export type ScreenPart = { key:string; category:string; description:string; axis?:Vec3; pivot?:Vec3; teeth?:number };

export type SpatialBounds = { min: Vec3; max: Vec3 };
export type GeometryMechanismKind = 'gear'|'rack-pinion'|'worm'|'belt'|'chain';
export type GeometryCandidate = {
  id: string; kind: GeometryMechanismKind; a:string;b:string;
  evidence: 'axis-and-bounds-screen'; status: 'plausible'|'rejected';
  /** Every proposal still requires manual validation of actual engagement. */
  confidence: 'geometry-consistent-review-required'|'rejected';
  metrics: { separationLdu: number; axisDot?: number; pitchErrorLdu?: number; axialSeparationLdu?: number };
  reasons: string[];
  /** Suggested authoring values, NOT confirmed tooth contacts / load transfer. */
  draft?: { teethA?:number;teethB?:number;starts?:number;pitchRadiusLdu?:number;axis:Vec3 };
};
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const scale=(a:Vec3,x:number):Vec3=>[a[0]*x,a[1]*x,a[2]*x];
const norm=(a:Vec3)=>Math.hypot(...a);
const finite=(a:Vec3)=>a.length===3&&a.every(Number.isFinite);
const validAxis=(a:Vec3|undefined):a is Vec3=>!!a&&finite(a)&&norm(a)>1e-8;
const normal=(a:Vec3):Vec3=>scale(a,1/(norm(a)||1));
const centre=(b:SpatialBounds):Vec3=>[
 (b.min[0]+b.max[0])/2,(b.min[1]+b.max[1])/2,(b.min[2]+b.max[2])/2];
const largestAxis=(b:SpatialBounds):{axis:Vec3;span:number;reliable:boolean}=>{
 const ex=[0,1,2].map(i=>b.max[i]-b.min[i]);
 const sorted=[0,1,2].sort((i,j)=>ex[j]-ex[i]);
 return {axis:sorted[0]===0?[1,0,0]:sorted[0]===1?[0,1,0]:[0,0,1],
  span:ex[sorted[0]],reliable:ex[sorted[0]]>1.3*ex[sorted[1]]};
};
const family=(p:ScreenPart)=>{
 const s=p.description.toLowerCase();
 if(/\brack\b/.test(s))return 'rack';
 if(/\bworm\b/.test(s))return 'worm';
 if(/\b(sprocket|chain wheel)\b/.test(s))return 'chain';
 if(/\bpulley\b/.test(s))return 'belt';
 if(p.category==='gear'&&p.teeth&&!/\b(bevel|crown|worm)\b/.test(s))return 'spur';
 return 'other';
};
const clustered=(a:string,b:string,clusters:readonly (readonly string[])[])=>clusters.some(c=>c.length>1&&c.includes(a)&&c.includes(b));
export const GEOMETRY_SCREEN_VERSION='v6.1';

/** A distance-first ranked list. Rejected entries are included deliberately:
 * users can see WHY apparently adjacent pieces were excluded. */
export function screenMechanismGeometry(parts:readonly ScreenPart[],
 boxes:ReadonlyMap<string,SpatialBounds>,
 rigidClusters:readonly (readonly string[])[]=[]):GeometryCandidate[] {
 const used=new Set<string>();
 const selected=parts.filter(p=>{
  if(typeof p?.key!=='string'||!p.key||used.has(p.key))return false;
  used.add(p.key);return typeof p.description==='string'&&
   ['spur','worm','rack','belt','chain'].includes(family(p));
 }).slice(0,280);
 const results:GeometryCandidate[]=[];
 for(let i=0;i<selected.length;i++)for(let j=i+1;j<selected.length;j++){
  const aa=selected[i],bb=selected[j],fa=family(aa),fb=family(bb);
  let kind:GeometryMechanismKind|null=null,a=aa,b=bb;
  if(fa==='spur'&&fb==='spur')kind='gear';
  else if((fa==='spur'&&fb==='rack')||(fb==='spur'&&fa==='rack')){
   kind='rack-pinion';if(fb==='spur'){a=bb;b=aa;}
  }else if((fa==='worm'&&fb==='spur')||(fb==='worm'&&fa==='spur')){
   kind='worm';if(fb==='worm'){a=bb;b=aa;}
  }else if(fa===fb&&(fa==='belt'||fa==='chain'))kind=fa;
  if(!kind)continue;
  const ba=boxes.get(a.key),bb2=boxes.get(b.key);if(!ba||!bb2)continue;
  const pa=a.pivot??centre(ba),pb=b.pivot??centre(bb2);
  if(!finite(pa)||!finite(pb)||!finite(ba.min)||!finite(ba.max)||!finite(bb2.min)||!finite(bb2.max))continue;
  const delta=sub(pb,pa),distance=norm(delta);
  if(distance>155)continue;
  const reasons:string[]=[],reject=(reason:string)=>reasons.push(reason);
  if(clustered(a.key,b.key,rigidClusters))reject('Both parts are fixed in the same rigid cluster');
  if((fa==='spur'&&(!Number.isSafeInteger(aa.teeth)||aa.teeth!<4||aa.teeth!>200))||
     (fb==='spur'&&(!Number.isSafeInteger(bb.teeth)||bb.teeth!<4||bb.teeth!>200)))
    reject('Gear tooth counts must be finite whole numbers in the supported range 4–200');
  if(distance<1e-6)reject('Proposed mechanism pivots coincide; cannot infer a distinct meshing pair');
  if(!validAxis(a.axis)||(!validAxis(b.axis)&&kind!=='rack-pinion'))
   reject('Missing or invalid LDCad shaft axes');
  const ua=validAxis(a.axis)?normal(a.axis):null,ub=validAxis(b.axis)?normal(b.axis):null;
  const axial=ua?Math.abs(dot(delta,ua)):undefined;
  const parallel=ua&&ub?Math.abs(dot(ua,ub)):undefined;
  let pitchError: number|undefined;
  if(kind==='gear'){
   if(!a.teeth||!b.teeth)reject('Tooth count absent');
   if(parallel!==undefined&&parallel<.985)reject(`Shafts are not parallel (|dot|=${parallel.toFixed(3)})`);
   if(ua&&a.teeth&&b.teeth){
    const radial=norm(sub(delta,scale(ua,dot(delta,ua))));
    const expected=1.25*(a.teeth+b.teeth);
    pitchError=Math.abs(radial-expected);
    if(pitchError>Math.max(1.25,expected*.045))reject(`Pitch centre distance differs by ${pitchError.toFixed(2)} LDU`);
    if(axial!==undefined&&axial>12)reject(`Axial gear planes are separated by ${axial!.toFixed(2)} LDU`);
   }
  }else if(kind==='rack-pinion'){
   if(!a.teeth)reject('Pinion tooth count missing');
   if(ua){
    const {axis,span,reliable}=largestAxis(bb2);
    if(!reliable)reject('Rack direction is ambiguous from its world AABB (rotated/short rack)');
    if(Math.abs(dot(ua,axis))>.20)reject('Rack length is not transverse to pinion shaft');
    const radial=sub(delta,scale(ua,dot(delta,ua))),radialLength=norm(radial);
    if(radialLength<1e-6)reject('Rack centre lies on pinion axle');
    else if(Math.abs(dot(axis,normal(radial)))>.4)reject('Rack length does not follow the pinion tangent');
    const pitchRadius=1.25*(a.teeth??0);
    // AABB thickness and tooth position are unknown, so only reject grossly
    // impossible separation, never certify true tooth contact.
    const minHalf=Math.min(...[0,1,2].filter(i=>axis[i]===0).map(i=>(bb2.max[i]-bb2.min[i])/2));
    pitchError=Math.abs(radialLength-pitchRadius);
    if(radialLength<pitchRadius-minHalf-4 || radialLength>pitchRadius+minHalf+5)
     reject(`Rack body is outside the rough ${pitchRadius.toFixed(1)} LDU pitch corridor`);
    if(span<10)reject('Rack has insufficient visible travel length');
   }
  }else if(kind==='worm'){
   if(!b.teeth)reject('Worm wheel has no tooth count');
   if(parallel!==undefined&&parallel>.16)reject('Worm and wheel shafts must be approximately orthogonal');
   if(ua&&ub){
    const offsetAlongWorm=Math.abs(dot(delta,ua)),offsetAlongWheel=Math.abs(dot(delta,ub));
    if(offsetAlongWorm>18||offsetAlongWheel>18)
     reject('Worm / gear centres are too far along their respective shaft axes');
    // Worm and wheel axes are normally SKEW, rather than intersecting: the
    // shortest line-to-line offset is the nominal centre distance. Its exact
    // magnitude needs a proper worm pitch diameter (not present in LDraw).
    const shaftOffset=Math.abs(dot(delta,normal([
      ua[1]*ub[2]-ua[2]*ub[1],ua[2]*ub[0]-ua[0]*ub[2],ua[0]*ub[1]-ua[1]*ub[0]])));
    if(shaftOffset<Math.max(1,1.25*(b.teeth??0)*.45)||shaftOffset>1.25*(b.teeth??0)+30)
     reject('Worm-to-wheel shaft offset is outside a broad pitch corridor');
   }
  }else{
   if(parallel!==undefined&&parallel<.985)reject('Pulley / sprocket shafts are not parallel');
   if(distance<8)reject('Pulley / sprocket centres are effectively coincident');
   if(axial!==undefined&&axial>12)reject('Pulley / sprocket planes are not aligned');
  }
  const plausible=!reasons.length;
  results.push({id:`${kind}:${a.key}:${b.key}`,kind,a:a.key,b:b.key,
    evidence:'axis-and-bounds-screen',status:plausible?'plausible':'rejected',
    confidence:plausible?'geometry-consistent-review-required':'rejected',
    metrics:{separationLdu:distance,...(parallel===undefined?{}:{axisDot:parallel}),
      ...(pitchError===undefined?{}:{pitchErrorLdu:pitchError}),
      ...(axial===undefined?{}:{axialSeparationLdu:axial})},
    reasons:plausible?['Passed coarse axis/pitch tests; actual tooth contact, bearings and collisions still UNVERIFIED.']:reasons,
    ...(plausible&&ua?{draft:{axis:ua,
      ...(a.teeth?{teethA:a.teeth}:{}),...(b.teeth?{teethB:b.teeth}:{}),
      ...(kind==='rack-pinion'?{pitchRadiusLdu:1.25*(a.teeth??0)}:{}),
      ...(kind==='worm'?{starts:Number(/(\d{1,2})\s*start/i.exec(a.description)?.[1]??'1')}:{}),
    }}:{}),
  });
 }
 return results.sort((a,b)=>Number(b.status==='plausible')-Number(a.status==='plausible')||
    a.metrics.separationLdu-b.metrics.separationLdu||a.id.localeCompare(b.id)).slice(0,100);
}
