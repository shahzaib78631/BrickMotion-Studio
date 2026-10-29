/** Explicit mechanism authoring, not automatic inference or physics certification. */
import { useMemo, useState } from 'react';
import type { Assembly } from '../model/assemble';
import type { MechanismGraph } from '../anim/motion/v4/mechanismGraph';
import type { DetectedPart, FunctionalHint } from '../anim/motion/v4/autoMechanics';
import type { MechanismProgram, TransmissionConstraint, Vec3 } from '../anim/motion/v4/mechanismProgram';
import { composeTransmissionProgram, type TransmissionDraft } from '../anim/motion/v4/transmissionComposer';
import { validateMechanismProgram } from '../anim/motion/v4/mechanismProgram';
import { MechanismSolver } from '../anim/motion/v4/mechanismSolver';
import { saveBlob, safeFileName } from './download';

type Kind = TransmissionConstraint['kind'];
const KINDS: { kind: Kind; label: string; description: string }[] = [
  { kind: 'gear', label: 'Spur gear pair', description: 'External gears rotate in opposite directions.' },
  { kind: 'belt', label: 'Belt drive', description: 'An uncrossed belt rotates both pulleys the same direction.' },
  { kind: 'chain', label: 'Chain drive', description: 'Chain sprocket rotations follow tooth-count ratios.' },
  { kind: 'worm', label: 'Worm gear', description: 'Worm starts divided by wheel teeth. No self-locking forces are simulated.' },
  { kind: 'wheel-ground', label: 'Wheel rolling · ideal no slip', description: 'Translate a chassis as its wheel turns; choose the ground travel axis. No contact dynamics.' },
  { kind: 'rack-pinion', label: 'Rack and pinion', description: 'Rotation (radians) times pitch radius (LDU) gives travel (LDU).' },
  { kind: 'linear-actuator', label: 'Screw / linear actuator', description: 'Rotational input moves a prismatic body by lead LDU per turn.' },
  { kind: 'differential', label: 'Open differential', description: 'Both outputs satisfy left + right = twice the carrier rotation.' },
  { kind: 'clutch', label: 'Engageable clutch', description: 'Couples equal-speed shafts when engaged; uncouples otherwise.' },
];
const axisOptions: { label: string; value: Vec3 }[] = [
  { label: 'X axis', value: [1, 0, 0] },
  { label: 'Y axis', value: [0, 1, 0] },
  { label: 'Z axis', value: [0, 0, 1] },
];

export function TransmissionDesigner({ assembly, parts, graph, hints, modelName, onPreview, onSave }: {
  assembly: Assembly; parts: readonly DetectedPart[]; graph: MechanismGraph; hints: readonly FunctionalHint[]; modelName: string;
  onPreview(program: MechanismProgram): void; onSave(program: MechanismProgram): void;
}) {
  const [kind,setKind]=useState<Kind>('gear');
  const [aKey,setAKey]=useState('');
  const [bKey,setBKey]=useState('');
  const [cKey,setCKey]=useState('');
  const [axisIndex,setAxisIndex]=useState(2);
  const [teethA,setTeethA]=useState(12);
  const [teethB,setTeethB]=useState(24);
  const [starts,setStarts]=useState(1);
  const [pitchRadius,setPitchRadius]=useState(20);
  const [wheelRadius,setWheelRadius]=useState(20);
  const [travelAxisIndex,setTravelAxisIndex]=useState(0);
  const [lead,setLead]=useState(8);
  const [crossed,setCrossed]=useState(false);
  const [reversed,setReversed]=useState(false);
  const [engaged,setEngaged]=useState(true);
  const [message,setMessage]=useState('');
  const [queued,setQueued]=useState<TransmissionDraft[]>([]);
  const candidates=useMemo(()=>assembly.instances.filter(i=>!i.placeholder),[assembly]);
  const detected=useMemo(()=>new Map(parts.map(p=>[p.key,p])),[parts]);
  const a=aKey||candidates[0]?.key||'';
  const b=bKey||candidates.find(p=>p.key!==a)?.key||'';
  const c=cKey||candidates.find(p=>p.key!==a&&p.key!==b)?.key||'';
  const options=candidates.map(p=><option key={p.key} value={p.key}>{p.key} · {p.part}</option>);
  const isSlide=kind==='rack-pinion'||kind==='linear-actuator'||kind==='wheel-ground';
  const info=KINDS.find(x=>x.kind===kind)!;
  const makeDraft=():TransmissionDraft=>({kind,a,b,
    ...(kind==='differential'?{c}:{}),axis:axisOptions[axisIndex].value,
    teethA,teethB,starts,pitchRadiusLdu:pitchRadius,radiusLdu:wheelRadius,travelAxis:axisOptions[travelAxisIndex].value,leadLduPerTurn:lead,
    crossed,reversed,engaged,
  });
  const makeProgram=():MechanismProgram=>composeTransmissionProgram(assembly,graph,parts,
    queued.length?queued:[makeDraft()]);
  const queueCoupling=()=>{
    try{
      const draft=makeDraft();
      const network=[...queued,draft];
      const program=composeTransmissionProgram(assembly,graph,parts,network);
      const solver=new MechanismSolver(assembly,program);
      solver.solve(program.driver.amplitude);
      setQueued(network);
      setMessage(`Added coupling ${network.length}: ${info.label}. The network can now reuse selected shafts across couplings.`);
    }catch(error){setMessage(error instanceof Error?error.message:String(error));}
  };
  const perform=(action:'preview'|'save'|'download')=>{
    try{
      const program=makeProgram();
      const errors=validateMechanismProgram(program);
      if(errors.length)throw Error(errors.join(' · '));
      const solver=new MechanismSolver(assembly,program);
      const solved=solver.solve(.18);
      if(solved.maxClosureErrorLdu>0.1)throw Error('Mechanism closure has excessive error');
      if(action==='preview')onPreview(program);
      if(action==='save')onSave(program);
      if(action==='download')saveBlob(`${safeFileName(modelName)}-transmission.json`,
        new Blob([JSON.stringify(program,null,2)],{type:'application/json'}));
      setMessage(action==='preview'?`Previewing ${program.transmissions?.length??0} connected couplings. Joints: ${[...solved.joints].map(([name,val])=>`${name} ${val.toFixed(3)}`).join(' · ')}`:
        action==='save'?'Saved as the current V4 mechanism demonstration.':
          'Exported authored mechanical program.');
    }catch(error){setMessage(error instanceof Error?error.message:String(error));}
  };
  if(candidates.length<2)return <p className="nx-hint">Load at least two separate parts to create a coupled transmission.</p>;
  return <details className="nx-group" aria-label="Transmission workshop">
    <summary>Transmission workshop · V5 authoring</summary>
    <p className="nx-hint">Build a transmission network by sharing shafts across multiple authored couplings, or preview a single coupling. Available constraints: gears, belts, chains, worm gears, rack and pinion, ideal wheel rolling, screw actuators, open differential, and clutch. Geometry and collision engagement remain <strong>unverified</strong>.</p>
    {hints.length>0&&<details className="nx-group">
      <summary>Possible functional pairs · {hints.length} to review</summary>
      <p className="nx-hint">Suggested using nearby part descriptions only. They are <strong>not</strong> verified gear or linkage engagements.</p>
      {hints.slice(0,16).map(h=><button key={h.id} className="bm-lab-relation"
        onClick={()=>{setKind(h.kind);setAKey(h.a);setBKey(h.b);
          const wheel=detected.get(h.b);
          if(wheel?.teeth)setTeethB(wheel.teeth);
          setMessage(`Review ${h.kind}: ${h.a} and ${h.b} (${h.distanceLdu.toFixed(1)} LDU apart). Configure the actual ratio and axis before preview.`);}}>
        <strong>{h.kind} · {h.distanceLdu.toFixed(1)} LDU</strong>
        <span>{h.a} ↔ {h.b}</span><small>Part-description proximity · review required</small>
      </button>)}
      {hints.length>16&&<p className="nx-hint">Showing 16 of {hints.length} hints. Export the mechanism JSON report for all.</p>}
    </details>}
    <label className="nx-field">Transmission type
      <select value={kind} onChange={e=>{setKind(e.target.value as Kind);setMessage('');}}>
        {KINDS.map(k=><option key={k.kind} value={k.kind}>{k.label}</option>)}
      </select>
    </label>
    <p className="nx-hint">{info.description}</p>
    <label className="nx-field">{kind==='differential'?'Carrier':kind==='wheel-ground'?'Wheel (rotates around chassis)':'Input rotor / shaft'}
      <select value={a} onChange={e=>setAKey(e.target.value)}>{options}</select>
    </label>
    <label className="nx-field">{kind==='differential'?'Left output':kind==='wheel-ground'?'Translating chassis':isSlide?'Sliding rack / actuator':'Output rotor / shaft'}
      <select value={b} onChange={e=>setBKey(e.target.value)}>{options}</select>
    </label>
    {kind==='differential'&&<label className="nx-field">Right output
      <select value={c} onChange={e=>setCKey(e.target.value)}>{options}</select>
    </label>}
    <label className="nx-field">Fallback world axis (when no gear connector axis is known)
      <select value={axisIndex} onChange={e=>setAxisIndex(Number(e.target.value))}>
        {axisOptions.map((opt,i)=><option key={i} value={i}>{opt.label}</option>)}
      </select>
    </label>
    {(kind==='gear'||kind==='belt'||kind==='chain'||kind==='worm')&&<div className="nx-row nx-wrap">
      {kind!=='worm'&&<label className="nx-field bm-lab-field">Input teeth
        <input type="number" min={1} max={500} value={teethA} onChange={e=>setTeethA(Number(e.target.value))}/>
      </label>}
      {kind==='worm'&&<label className="nx-field bm-lab-field">Worm starts
        <input type="number" min={1} max={8} value={starts} onChange={e=>setStarts(Number(e.target.value))}/>
      </label>}
      <label className="nx-field bm-lab-field">{kind==='worm'?'Wheel teeth':'Output teeth'}
        <input type="number" min={1} max={500} value={teethB} onChange={e=>setTeethB(Number(e.target.value))}/>
      </label>
    </div>}
    {kind==='rack-pinion'&&<label className="nx-field">Pinion pitch radius (LDU)
      <input type="number" min={0.01} max={100000} step={0.5} value={pitchRadius} onChange={e=>setPitchRadius(Number(e.target.value))}/>
    </label>}
    {kind==='wheel-ground'&&<div className="nx-row nx-wrap">
      <label className="nx-field bm-lab-field">Effective rolling radius (LDU)
        <input type="number" min={0.01} max={100000} step={0.5} value={wheelRadius} onChange={e=>setWheelRadius(Number(e.target.value))}/>
      </label>
      <label className="nx-field bm-lab-field">Chassis travel direction
        <select value={travelAxisIndex} onChange={e=>setTravelAxisIndex(Number(e.target.value))}>
          {axisOptions.map((opt,i)=><option key={i} value={i}>{opt.label}</option>)}
        </select>
      </label>
    </div>}
    {kind==='linear-actuator'&&<label className="nx-field">Linear advance per turn (LDU)
      <input type="number" min={0.01} max={100000} step={0.5} value={lead} onChange={e=>setLead(Number(e.target.value))}/>
    </label>}
    {kind==='belt'&&<label className="nx-row nx-wrap"><input type="checkbox" checked={crossed} onChange={e=>setCrossed(e.target.checked)}/> Crossed belt (reverse direction)</label>}
    {(kind==='worm'||isSlide||kind==='clutch')&&<label className="nx-row nx-wrap"><input type="checkbox" checked={reversed} onChange={e=>setReversed(e.target.checked)}/> Reverse output direction</label>}
    {kind==='clutch'&&<label className="nx-row nx-wrap"><input type="checkbox" checked={engaged} onChange={e=>setEngaged(e.target.checked)}/> Clutch engaged</label>}
    {queued.length>0&&<section className="nx-card">
      <div className="nx-card-title">Network builder · {queued.length} coupled relation{queued.length!==1?'s':''}</div>
      <p className="nx-hint">The first coupling's input is the primary motor. A shaft selected again in another coupling shares the same joint coordinate. The editable fields above are for the next relation; they are not included until you add it.</p>
      {queued.map((d,i)=><div className="nx-row nx-wrap" key={i}>
        <span>{i+1}. {d.kind}: {d.a} → {d.b}{d.c?` / ${d.c}`:''}</span>
        <button className="nx-btn nx-sm" aria-label={`Remove coupling ${i+1}`}
          onClick={()=>{setQueued(old=>old.filter((_,j)=>j!==i));setMessage(`Removed coupling ${i+1}.`);}}>Remove</button>
      </div>)}
      <button className="nx-btn nx-sm" onClick={()=>{setQueued([]);setMessage('Cleared draft network.');}}>Clear network</button>
    </section>}
    <div className="nx-row nx-wrap">
      <button className="nx-btn nx-sm" onClick={queueCoupling}>Add coupling to network</button>
      <button className="nx-btn nx-sm nx-primary" onClick={()=>perform('preview')}>{queued.length?'Preview network':'Preview coupling'}</button>
      <button className="nx-btn nx-sm" onClick={()=>perform('save')}>Save V4 demo</button>
      <button className="nx-btn nx-sm" onClick={()=>perform('download')}>Export program JSON</button>
    </div>
    {message&&<p className="nx-hint" role="status">{message}</p>}
    <p className="nx-hint">Selected rotating and sliding parts are treated as independent rigid bodies with ideal, user-authored transmission ratios. Shared shafts are validated against fixed connector clusters. Rack motion is estimated tangentially from the pinion axis and part centres; wheel rolling requires an explicitly chosen ground travel direction and assumes perfect no-slip contact. Specify actual pivots, mounting and collision clearance before using the results to represent a real model. Use the existing V4 render verifier for a separate clearance assessment.</p>
  </details>;
}
