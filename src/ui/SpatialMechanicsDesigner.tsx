/** Author-reviewed V7 mechanical relationships for an existing spatial rig.
 * Uses real detected/JSON hinge and slider joint IDs; it never creates fake
 * contact connections or changes source LDraw geometry. */
import {useState} from 'react';
import type {SpatialLinkagePreview} from '../anim/motion/v6/spatialAdapter';
import {SpatialMechanismSolver,validateSpatialModel,
  type SpatialMechanic, type SpatialModel} from '../anim/motion/v6/spatialConstraints';

type Kind=SpatialMechanic['kind'];
const KINDS:{kind:Kind;label:string;hint:string}[]=[
 {kind:'gear',label:'Spur or internal gear mesh',hint:'Opposite shaft rotation for external teeth; same direction for internal teeth.'},
 {kind:'bevel-gear',label:'Bevel / crown gears',hint:'Author effective tooth ratio and sign across non-parallel shaft axes. Physical cone contact is not checked.'},
 {kind:'belt',label:'Belt and pulley pair',hint:'Open belts drive in the same direction; crossed belts reverse direction.'},
 {kind:'chain',label:'Chain and sprockets',hint:'Ideal synchronous, no slip or chain sag.'},
 {kind:'worm',label:'Worm gear reducer',hint:'Uses worm starts divided by wheel teeth; does not model self-locking friction.'},
 {kind:'cv-joint',label:'Constant-velocity joint',hint:'Equal angular displacement, even when the two shaft axes differ.'},
 {kind:'clutch',label:'Engageable shaft clutch',hint:'Equal-speed coupling when engaged, independent shafts when released. No slip/friction torque is simulated.'},
 {kind:'universal-drive',label:'Hooke universal shaft',hint:'Nonuniform output angle from ideal bent-shaft geometry; not a physical cross-bearing.'},
 {kind:'rack-pinion',label:'Rack and pinion',hint:'Linear follower travel equals pinion rotation multiplied by pitch radius.'},
 {kind:'wheel-rolling',label:'Ideal wheel rolling',hint:'Couples wheel rotation to a single chassis translation coordinate at the authored wheel radius. No real tire contact, slip or ground reaction.'},
 {kind:'screw',label:'Linear actuator / leadscrew',hint:'Converts shaft rotations into slider travel using an authored lead.'},
 {kind:'winch',label:'Winch and block-and-tackle',hint:'Drum cable travel is divided by the number of supporting rope segments.'},
 {kind:'differential',label:'Open differential',hint:'Two outputs sum to twice the differential carrier rotation.'},
 {kind:'ackermann-steering',label:'Ackermann steering geometry',hint:'Ideal inner/outer wheel steering angles from wheelbase, track width and the authored centre steering shaft. No rack/tie-rod/tyre forces.'},
 {kind:'planetary',label:'Planetary epicyclic gearset',hint:'Sun/ring/carrier satisfy Ns·sun + Nr·ring = (Ns+Nr)·carrier. Lock a shaft with an engaged brake for reduction.'},
 {kind:'cam-follower',label:'Cam and follower',hint:'Ideal closed-contact cosine cam profile; no follower spring or loss of contact.'},
 {kind:'stop',label:'Hard travel stops',hint:'Enforces authored joint bounds and reports impossible commanded motion.'},
 {kind:'brake',label:'Holding brake',hint:'Ideal lock at the assembled rest coordinate while engaged; no braking torque or friction modelling.'},
 {kind:'ratchet',label:'One-way ratchet/pawl',hint:'Stores last accepted motion and refuses reverse travel while engaged.'},
 {kind:'slider-crank',label:'Offset slider-crank engine',hint:'Exact connecting-rod geometry on a specified branch; full travel needs rod length larger than crank radius plus offset.'},
 {kind:'scotch-yoke',label:'Scotch yoke / reciprocator',hint:'Pure harmonic crank-to-slider translation, optionally phase shifted.'},
 {kind:'linear-coupler',label:'Coupled linear sliders',hint:'Ideal positive or reversed linear motion with a fixed ratio. No hydraulic/elastic loads.'},
 {kind:'hydraulic-pair',label:'Linked hydraulic pistons (ideal volume)',hint:'Piston displacements conserve authored fluid volume. Pressure, force and compressibility are not simulated.'},
 {kind:'backlash-gear',label:'Gear with tooth backlash',hint:'Reversible clearance, free rotation in the gap, and pose continuation for undriven shafts. Not friction physics.'},
 {kind:'detent',label:'Indexed selector / detent lock',hint:'An engaged selector is restricted to authored discrete positions. No snap spring or contact forces.'},
 {kind:'cam-profile',label:'Sampled variable-lift cam',hint:'Periodic authored lift profile with smooth interpolation, no follower contact force.'},
 {kind:'intermittent-indexer',label:'Intermittent indexer with dwell',hint:'Idealized continuous indexing profile, not an exact Geneva contact model.'},
 {kind:'differential-drive',label:'Two-wheel differential drive',hint:'Two wheel angles map to body-frame forward travel and yaw; no tyre slip or global curved-path odometry.'},
];
export function SpatialMechanicsDesigner({preview,onApply}:{
  preview:SpatialLinkagePreview;
  onApply(model:SpatialModel):void;
}){
 const [kind,setKind]=useState<Kind>('gear');
 const [inJoint,setInJoint]=useState('');
 const [outJoint,setOutJoint]=useState('');
 const [thirdJoint,setThirdJoint]=useState('');
 const [forwardJoint,setForwardJoint]=useState('');
 const [teethA,setTeethA]=useState(12);
 const [teethB,setTeethB]=useState(24);
 const [starts,setStarts]=useState(1);
 const [radius,setRadius]=useState(20);
 const [rodLength,setRodLength]=useState(60);
 const [guideOffset,setGuideOffset]=useState(0);
 const [linearRatio,setLinearRatio]=useState(-1);
 const [areaFirst,setAreaFirst]=useState(2);
 const [areaSecond,setAreaSecond]=useState(4);
 const [backlash,setBacklash]=useState(.06);
 const [detentPitch,setDetentPitch]=useState(.5);
 const [slotCount,setSlotCount]=useState(6);
 const [activeFraction,setActiveFraction]=useState(.3);
 const [camSamples,setCamSamples]=useState('0, 4, 8, 4');
 const [wheelbase,setWheelbase]=useState(80);
 const [trackWidth,setTrackWidth]=useState(40);
 const [lead,setLead]=useState(3.73);
 const [segments,setSegments]=useState(2);
 const [bend,setBend]=useState(25);
 const [lift,setLift]=useState(8);
 const [lobes,setLobes]=useState(1);
 const [phase,setPhase]=useState(0);
 const [minimum,setMinimum]=useState(-.4);
 const [maximum,setMaximum]=useState(.4);
 const [crossed,setCrossed]=useState(false);
 const [internal,setInternal]=useState(false);
 const [reversed,setReversed]=useState(false);
 const [ratchetDirection,setRatchetDirection]=useState<'positive'|'negative'>('positive');
 const [message,setMessage]=useState('');
 const hinges=preview.model.constraints.filter(c=>c.kind==='hinge').map(c=>c.id);
 const sliders=preview.model.constraints.filter(c=>c.kind==='slider').map(c=>c.id);
 const all=[...hinges,...sliders];
 const pick=(ids:readonly string[],preferred:string,not?:string):string=>
  preferred&&ids.includes(preferred)&&preferred!==not?preferred:ids.find(x=>x!==not)??'';
 const rotary=pick(hinges,inJoint);
 const otherRotor=pick(hinges,outJoint,rotary);
 const slide=pick(sliders,kind==='differential-drive'?forwardJoint:outJoint);
 const sliderInput=pick(sliders,inJoint);
 const sliderOutput=pick(sliders,outJoint,sliderInput);
 const anyJoint=pick(all,inJoint);
 const second=pick(hinges,outJoint,rotary);
 const third=pick(hinges,thirdJoint,rotary)===second?
  hinges.find(id=>id!==rotary&&id!==second)??'':pick(hinges,thirdJoint,rotary);
 const sliderPair=kind==='linear-coupler'||kind==='hydraulic-pair';
 const differentialVehicle=kind==='differential-drive';
 const requireSlide=['rack-pinion','wheel-rolling','screw','winch','cam-follower',
  'slider-crank','scotch-yoke','cam-profile'].includes(kind);
 const three=kind==='differential'||kind==='planetary'||kind==='ackermann-steering'||differentialVehicle;
 const single=kind==='stop'||kind==='ratchet'||kind==='brake'||kind==='detent';
 const missing=single?!anyJoint:sliderPair?!sliderInput||!sliderOutput:
  differentialVehicle?!rotary||!second||!third||!sliders.length:
  three?!rotary||!second||!third:requireSlide?!rotary||!slide:!rotary||!otherRotor;
 const definition=KINDS.find(k=>k.kind===kind)!;
 const build=():SpatialMechanic=>{
  const id=`mechanic-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
  switch(kind){
   case 'gear':return {id,kind,input:rotary,output:otherRotor,inputTeeth:teethA,outputTeeth:teethB,internal};
   case 'bevel-gear':return {id,kind,input:rotary,output:otherRotor,inputTeeth:teethA,outputTeeth:teethB,reversed};
   case 'belt':case 'chain':return {id,kind,input:rotary,output:otherRotor,inputTeeth:teethA,outputTeeth:teethB,crossed};
   case 'worm':return {id,kind,input:rotary,output:otherRotor,starts,wheelTeeth:teethB,reversed};
   case 'cv-joint':return {id,kind,input:rotary,output:otherRotor,reversed};
   case 'clutch':return {id,kind,input:rotary,output:otherRotor,engaged:true,reversed};
   case 'universal-drive':return {id,kind,input:rotary,output:otherRotor,bendAngleRad:bend*Math.PI/180,reversed};
   case 'rack-pinion':return {id,kind,rotary,linear:slide,pitchRadiusLdu:radius,reversed};
   case 'wheel-rolling':return {id,kind,rotary,linear:slide,wheelRadiusLdu:radius,reversed};
   case 'screw':return {id,kind,rotary,linear:slide,leadLduPerTurn:lead,reversed};
   case 'winch':return {id,kind,rotary,linear:slide,drumRadiusLdu:radius,supportedSegments:segments,reversed};
   case 'cam-follower':return {id,kind,cam:rotary,follower:slide,liftLdu:lift,lobes,phaseRad:phase*Math.PI/180,reversed};
   case 'differential':return {id,kind,carrier:rotary,left:second,right:third};
   case 'ackermann-steering':return {id,kind,input:rotary,left:second,right:third,wheelbaseLdu:wheelbase,trackWidthLdu:trackWidth};
   case 'planetary':return {id,kind,sun:rotary,ring:second,carrier:third,sunTeeth:teethA,ringTeeth:teethB};
   case 'stop':return {id,kind,joint:anyJoint,min:minimum,max:maximum};
   case 'brake':return {id,kind,joint:anyJoint,engaged:true};
   case 'ratchet':return {id,kind,joint:anyJoint,direction:ratchetDirection,engaged:true};
   case 'slider-crank':return {id,kind,crank:rotary,slider:slide,crankRadiusLdu:radius,rodLengthLdu:rodLength,guideOffsetLdu:guideOffset,reversed};
   case 'scotch-yoke':return {id,kind,crank:rotary,slider:slide,radiusLdu:radius,phaseRad:phase*Math.PI/180,reversed};
   case 'linear-coupler':return {id,kind,input:sliderInput,output:sliderOutput,ratio:linearRatio};
   case 'hydraulic-pair':return {id,kind,first:sliderInput,second:sliderOutput,areaFirst,areaSecond};
   case 'backlash-gear':return {id,kind,input:rotary,output:otherRotor,inputTeeth:teethA,outputTeeth:teethB,clearanceRad:backlash,internal};
   case 'detent':return {id,kind,joint:anyJoint,pitch:detentPitch,engaged:true};
   case 'cam-profile':return {id,kind,cam:rotary,follower:slide,profileLdu:camSamples.split(/[\s,;]+/).filter(Boolean).map(Number),lobes,phaseRad:phase*Math.PI/180,reversed};
   case 'intermittent-indexer':return {id,kind,input:rotary,output:otherRotor,slots:slotCount,activeFraction,phaseRad:phase*Math.PI/180,reversed};
   case 'differential-drive':return {id,kind,left:rotary,right:second,forward:slide,yaw:third,wheelRadiusLdu:radius,trackWidthLdu:trackWidth};
  }
 };
 const apply=(mechanics:SpatialMechanic[])=>{
  try{
   const next={...preview.model,mechanics};
   const errors=validateSpatialModel(next);
   if(errors.length)throw Error(errors.join(' · '));
   // Check that every newly authored relation is consistent at the original
   // assembled rest pose. A spatial rig must never be silently reassembled.
   const solver=new SpatialMechanismSolver(next);
   const atRest=solver.solve({});
   if(atRest.status!=='converged')throw Error(atRest.warning??'Assembly is inconsistent at rest');
   onApply(next);
   setMessage(`Applied ${mechanics.length} authored mechanical relationship(s). Run a sampled sweep before treating movement as plausible.`);
  }catch(e){setMessage(e instanceof Error?e.message:String(e));}
 };
 return <details className="nx-group" open>
  <summary>V8 mechanical network composer · {preview.model.mechanics?.length??0} relations</summary>
  <p className="nx-hint">Connect real spatial joints in the <strong>same</strong> simultaneous 3D linkage solver. All contacts, ratios, mountings and physical limits are user-reviewed hypotheses. Other spatial bodies continue to obey their hinges, sliders and closed loops.</p>
  {(preview.model.mechanics??[]).map((mechanic,i)=><div className="nx-row nx-wrap" key={mechanic.id}>
   <span>{i+1}. {mechanic.kind} · {mechanic.id}</span>
   {(mechanic.kind==='clutch'||mechanic.kind==='brake'||mechanic.kind==='ratchet'||mechanic.kind==='detent')&&<label>
    <input type="checkbox" checked={mechanic.engaged!==false}
      onChange={e=>apply((preview.model.mechanics??[]).map(m=>m.id===mechanic.id?{...m,engaged:e.target.checked}:m))}/>
    Engaged
   </label>}
   <button className="nx-btn nx-sm" onClick={()=>apply((preview.model.mechanics??[]).filter(m=>m.id!==mechanic.id))}>Remove</button>
  </div>)}
  <label className="nx-field">Add mechanical component
   <select value={kind} onChange={e=>{setKind(e.target.value as Kind);setMessage('');}}>
    {KINDS.map(k=><option key={k.kind} value={k.kind}>{k.label}</option>)}
   </select>
  </label>
  <p className="nx-hint">{definition.hint}</p>
  {single?<label className="nx-field">Constrained hinge / slider
   <select value={anyJoint} onChange={e=>setInJoint(e.target.value)}>{all.map(j=><option key={j} value={j}>{j}</option>)}</select>
  </label>:sliderPair?<>
   <label className="nx-field">Input slider<select value={sliderInput} onChange={e=>{setInJoint(e.target.value);setOutJoint('');}}>{sliders.map(j=><option key={j} value={j}>{j}</option>)}</select></label>
   <label className="nx-field">Output slider<select value={sliderOutput} onChange={e=>setOutJoint(e.target.value)}>{sliders.filter(j=>j!==sliderInput).map(j=><option key={j} value={j}>{j}</option>)}</select></label>
  </>:<>
   <label className="nx-field">{kind==='planetary'?'Sun shaft':kind==='ackermann-steering'?'Centre steering hinge':differentialVehicle?'Left drive wheel':three?'Carrier shaft':'Input hinge shaft'}
    <select value={rotary} onChange={e=>{setInJoint(e.target.value);setOutJoint('');}}>{hinges.map(j=><option key={j} value={j}>{j}</option>)}</select>
   </label>
   <label className="nx-field">{kind==='planetary'?'Ring shaft':differentialVehicle?'Right drive wheel':three?'Left wheel steering hinge':requireSlide?'Sliding follower':'Output hinge shaft'}
    <select value={requireSlide?slide:differentialVehicle?second:otherRotor} onChange={e=>setOutJoint(e.target.value)}>
     {(requireSlide?sliders:hinges.filter(id=>id!==rotary)).map(j=><option key={j} value={j}>{j}</option>)}
    </select>
   </label>
   {three&&<label className="nx-field">{kind==='planetary'?'Carrier shaft':differentialVehicle?'Vehicle yaw hinge':kind==='ackermann-steering'?'Right wheel steering hinge':'Right output hinge'}
    <select value={third} onChange={e=>setThirdJoint(e.target.value)}>
     {hinges.filter(id=>id!==rotary&&id!==second).map(j=><option key={j} value={j}>{j}</option>)}
    </select>
   </label>}
   {differentialVehicle&&<label className="nx-field">Vehicle forward slider
    <select value={slide} onChange={e=>setForwardJoint(e.target.value)}>{sliders.map(j=><option key={j} value={j}>{j}</option>)}</select>
   </label>}
  </>}
  {(['gear','bevel-gear','belt','chain','planetary','backlash-gear'].includes(kind))&&<div className="nx-row nx-wrap">
   <label className="nx-field bm-lab-field">{kind==='planetary'?'Sun':'Input'} teeth<input type="number" min={1} max={1000} value={teethA} onChange={e=>setTeethA(Number(e.target.value))}/></label>
   <label className="nx-field bm-lab-field">{kind==='planetary'?'Ring':'Output'} teeth<input type="number" min={1} max={1000} value={teethB} onChange={e=>setTeethB(Number(e.target.value))}/></label>
  </div>}
  {kind==='worm'&&<div className="nx-row nx-wrap">
   <label className="nx-field bm-lab-field">Worm starts<input type="number" min={1} max={8} value={starts} onChange={e=>setStarts(Number(e.target.value))}/></label>
   <label className="nx-field bm-lab-field">Wheel teeth<input type="number" min={1} max={1000} value={teethB} onChange={e=>setTeethB(Number(e.target.value))}/></label>
  </div>}
  {(kind==='gear'||kind==='backlash-gear')&&<label className="nx-row nx-wrap"><input type="checkbox" checked={internal} onChange={e=>setInternal(e.target.checked)}/> Internal ring gear (same rotation direction)</label>}
  {kind==='belt'&&<label className="nx-row nx-wrap"><input type="checkbox" checked={crossed} onChange={e=>setCrossed(e.target.checked)}/> Cross belt (reverses rotation)</label>}
  {(['rack-pinion','wheel-rolling','winch','slider-crank','scotch-yoke','differential-drive'].includes(kind))&&<label className="nx-field">{kind==='winch'?'Drum radius':kind==='wheel-rolling'||kind==='differential-drive'?'Wheel radius':kind==='slider-crank'?'Crank radius':kind==='scotch-yoke'?'Yoke radius':'Pinion pitch radius'} (LDU)
   <input type="number" min={.1} max={100000} step={.5} value={radius} onChange={e=>setRadius(Number(e.target.value))}/></label>}
  {kind==='winch'&&<label className="nx-field">Supporting cable segments<input type="number" min={1} max={12} step={1} value={segments} onChange={e=>setSegments(Number(e.target.value))}/></label>}
  {(kind==='ackermann-steering'||kind==='differential-drive')&&<div className="nx-row nx-wrap">
   <label className="nx-field bm-lab-field">Wheelbase (LDU)<input type="number" min={1} max={100000} value={wheelbase} onChange={e=>setWheelbase(Number(e.target.value))}/></label>
   <label className="nx-field bm-lab-field">Track width (LDU)<input type="number" min={1} max={100000} value={trackWidth} onChange={e=>setTrackWidth(Number(e.target.value))}/></label>
  </div>}
  {kind==='screw'&&<label className="nx-field">Actuator lead (LDU per full turn)<input type="number" min={.01} max={100000} step={.01} value={lead} onChange={e=>setLead(Number(e.target.value))}/></label>}
  {kind==='universal-drive'&&<label className="nx-field">Shaft bend angle (degrees)
   <input type="number" min={0} max={88} step={1} value={bend} onChange={e=>setBend(Number(e.target.value))}/></label>}
  {kind==='cam-follower'&&<div className="nx-row nx-wrap">
   <label className="nx-field bm-lab-field">Cam lift (LDU)<input type="number" min={.1} value={lift} onChange={e=>setLift(Number(e.target.value))}/></label>
   <label className="nx-field bm-lab-field">Lobes<input type="number" min={1} max={16} value={lobes} onChange={e=>setLobes(Number(e.target.value))}/></label>
   <label className="nx-field bm-lab-field">Phase (°)<input type="number" step={1} value={phase} onChange={e=>setPhase(Number(e.target.value))}/></label>
  </div>}
  {kind==='stop'&&<div className="nx-row nx-wrap">
   <label className="nx-field bm-lab-field">Minimum (radians / LDU)<input type="number" step={.05} value={minimum} onChange={e=>setMinimum(Number(e.target.value))}/></label>
   <label className="nx-field bm-lab-field">Maximum (radians / LDU)<input type="number" step={.05} value={maximum} onChange={e=>setMaximum(Number(e.target.value))}/></label>
  </div>}
  {kind==='ratchet'&&<label className="nx-field">Permitted movement direction
   <select value={ratchetDirection} onChange={e=>setRatchetDirection(e.target.value as 'positive'|'negative')}>
    <option value="positive">Positive only</option><option value="negative">Negative only</option>
   </select></label>}
  {kind==='slider-crank'&&<div className="nx-row nx-wrap">
   <label className="nx-field bm-lab-field">Connecting rod length (LDU)<input type="number" min={.1} value={rodLength} onChange={e=>setRodLength(Number(e.target.value))}/></label>
   <label className="nx-field bm-lab-field">Guide offset (LDU)<input type="number" value={guideOffset} onChange={e=>setGuideOffset(Number(e.target.value))}/></label>
  </div>}
  {kind==='linear-coupler'&&<label className="nx-field">Signed linear ratio<input type="number" step={.1} value={linearRatio} onChange={e=>setLinearRatio(Number(e.target.value))}/></label>}
  {kind==='hydraulic-pair'&&<div className="nx-row nx-wrap">
   <label className="nx-field bm-lab-field">First piston area (relative)<input type="number" min={.001} value={areaFirst} onChange={e=>setAreaFirst(Number(e.target.value))}/></label>
   <label className="nx-field bm-lab-field">Second piston area (relative)<input type="number" min={.001} value={areaSecond} onChange={e=>setAreaSecond(Number(e.target.value))}/></label>
  </div>}
  {kind==='backlash-gear'&&<label className="nx-field">Angular backlash clearance (radians)<input type="number" min={.001} step={.01} value={backlash} onChange={e=>setBacklash(Number(e.target.value))}/></label>}
  {kind==='detent'&&<label className="nx-field">Detent pitch (radians or LDU)<input type="number" min={.001} step={.05} value={detentPitch} onChange={e=>setDetentPitch(Number(e.target.value))}/></label>}
  {kind==='cam-profile'&&<label className="nx-field">Periodic cam samples (comma-separated lifts in LDU; 4–64)<input type="text" value={camSamples} onChange={e=>setCamSamples(e.target.value)}/></label>}
  {kind==='intermittent-indexer'&&<div className="nx-row nx-wrap">
   <label className="nx-field bm-lab-field">Indexed wheel slots<input type="number" min={3} max={24} value={slotCount} onChange={e=>setSlotCount(Number(e.target.value))}/></label>
   <label className="nx-field bm-lab-field">Active turn fraction (0.1–0.9)<input type="number" min={.1} max={.9} step={.05} value={activeFraction} onChange={e=>setActiveFraction(Number(e.target.value))}/></label>
  </div>}
  {(['scotch-yoke','cam-profile','intermittent-indexer'].includes(kind))&&<label className="nx-field">Phase (degrees)<input type="number" step={5} value={phase} onChange={e=>setPhase(Number(e.target.value))}/></label>}
  {['bevel-gear','worm','cv-joint','clutch','universal-drive','rack-pinion','wheel-rolling','screw','winch','cam-follower','slider-crank','scotch-yoke','cam-profile','intermittent-indexer'].includes(kind)&&
   <label className="nx-row nx-wrap"><input type="checkbox" checked={reversed} onChange={e=>setReversed(e.target.checked)}/> Reverse output direction</label>}
  {missing&&<p className="nx-hint">This relationship needs {single?'a hinge or slider':sliderPair?'two sliders':differentialVehicle?'three hinges and one slider':three?'three hinges':requireSlide?'one hinge and one slider':'two hinges'}. Add joints in a reviewed spatial rig before connecting them.</p>}
  <button disabled={!!missing} className="nx-btn nx-sm nx-primary" onClick={()=>apply([...(preview.model.mechanics??[]),build()])}>Add to live spatial rig</button>
  {message&&<p className="nx-hint" role="status">{message}</p>}
  <p className="nx-hint">V8 adds idealized crank, cam, hydraulic, backlash, indexing and differential-drive constraints. Only ideal, position-level kinematics are solved. A cam is assumed to maintain follower contact; a winch cannot test rope tension; no load, friction, torque or slip is simulated. Ratchet pawls will deliberately refuse ordinary reverse/oscillating playback.</p>
 </details>;
}
