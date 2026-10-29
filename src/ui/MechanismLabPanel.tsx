import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelState } from '../state/useModel';
import { useStudio } from '../state/store';
import { usePlayback } from '../state/playback';
import { useAppSettings } from '../state/appSettings';
import { metricsOf } from '../state/partService';
import { useMechanismLab } from '../state/mechanismLab';
import { inspectMechanisms, mechanismReportDot, mechanismReportJson, previewAmplitude, type LabReport } from '../anim/motion/v4/mechanismLab';
import type { MechanismProgram } from '../anim/motion/v4/mechanismProgram';
import { saveBlob, safeFileName } from './download';
import { Ic } from './icons';
import { TransmissionDesigner } from './TransmissionDesigner';
import { sweepMechanism, type SweepResult } from '../anim/motion/v4/mechanismSweep';
import { composeTransmissionProgram } from '../anim/motion/v4/transmissionComposer';
import { MechanismSolver } from '../anim/motion/v4/mechanismSolver';
import type { GeometryCandidate } from '../anim/motion/v6/geometryScreen';
import { createSpatialLinkagePreview } from '../anim/motion/v6/spatialAdapter';
import { SpatialMechanismSolver } from '../anim/motion/v6/spatialConstraints';
import { sweepSpatialLinkage, type SpatialSweepReport } from '../anim/motion/v6/spatialSweep';
import { parseSpatialRig,serializeSpatialRig } from '../anim/motion/v6/spatialRig';
import type { SpatialModel } from '../anim/motion/v6/spatialConstraints';
import { SpatialMechanicsDesigner } from './SpatialMechanicsDesigner';
import { proposeSpatialMechanic } from '../anim/motion/v6/spatialMechanicProposal';
import { bakeSpatialClip } from '../anim/motion/v8/spatialClip';

function selectPart(key: string) {
  const store = useStudio.getState();
  // Nested leaves are selected via their containing submodel use, which is
  // what the Build viewport's selection system can actually frame and edit.
  const id = key.split('/')[0];
  store.select([id]);
  store.requestFocus([id]);
}

export function MechanismLabPanel({ model, onRender }: { model: ModelState; onRender(): void }) {
  const editingModel = useStudio(s => s.editingModel);
  const lab = useMechanismLab();
  const settings = useAppSettings();
  const [report, setReport] = useState<LabReport | null>(null);
  const [failure, setFailure] = useState('');
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [manualKey, setManualKey] = useState('');
  const [geometryError,setGeometryError]=useState('');
  const [spatialEdge,setSpatialEdge]=useState('');
  const [spatialGround,setSpatialGround]=useState('');
  const [spatialError,setSpatialError]=useState('');
  const [spatialSweep,setSpatialSweep]=useState<SpatialSweepReport|null>(null);
  const [customSpatialError,setCustomSpatialError]=useState('');
  const [manualKind, setManualKind] = useState<'revolute' | 'prismatic'>('revolute');
  const [manualAxis, setManualAxis] = useState<'x' | 'y' | 'z'>('y');
  const [manualPivotMode, setManualPivotMode] = useState<'centre' | 'custom'>('centre');
  const [manualPivot, setManualPivot] = useState<[string,string,string]>(['0','0','0']);
  const count = model.view.instances.length;
  const lastAssembly = useRef(model.view);
  useEffect(() => {
    if (lastAssembly.current !== model.view) {
      useMechanismLab.getState().stop();
      lastAssembly.current = model.view;
    }
  }, [model.view]);
  // Closing the Mechanisms tab must not keep a hidden RAF driving the model.
  useEffect(() => () => useMechanismLab.getState().stop(), []);
  const manualOptions = model.view.instances.filter(i => !i.placeholder);
  const manualPart = manualOptions.find(i => i.key === manualKey) ?? manualOptions[0];
  const bodyCentre = manualPart && [0,1,2].map(i => (manualPart.worldBox.min[i] + manualPart.worldBox.max[i]) / 2) as [number,number,number];

  useEffect(() => {
    let cancelled = false;
    setReport(null); setFailure('');setSweep(null);setSpatialSweep(null);setSpatialError('');
    if (!model.ready || !count) return;
    setBusy(true);
    // Allow the panel to show its loading state before the on-demand scan.
    const timer = window.setTimeout(() => {
      try {
        const found = inspectMechanisms(model.view, metricsOf);
        if (!cancelled) setReport(found);
      } catch (e) {
        if (!cancelled) setFailure(e instanceof Error ? e.message : String(e));
      } finally { if (!cancelled) setBusy(false); }
    }, 20);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [model.ready, model.view, count]);

  useEffect(() => {
    // A different edited model cannot share exact instance keys/pivots with the old one.
    if (lab.active && lab.model !== editingModel) useMechanismLab.getState().stop();
  }, [editingModel, lab.active, lab.model]);

  const candidates = report?.detection.suggestions ?? [];
  const joints = useMemo(() => (report?.detection.joints ?? []).filter(j =>
    `${j.a} ${j.b} ${j.kind} ${j.motion}`.toLowerCase().includes(query.toLowerCase())), [report, query]);
  const ratios = report?.detection.gearMeshes ?? [];
  const geometryReady = (report?.geometryCandidates??[]).filter(c=>c.status==='plausible');
  const geometryRejected = (report?.geometryCandidates??[]).filter(c=>c.status==='rejected');
  const spatialEdges = (report?.graph.edges??[]).filter(e=>e.motion==='revolute'||e.motion==='sliding');
  const selectedSpatialEdge = spatialEdges.find(e=>e.id===spatialEdge)??spatialEdges[0];
  const selectedGround = spatialGround===selectedSpatialEdge?.a||spatialGround===selectedSpatialEdge?.b
    ?spatialGround:selectedSpatialEdge?.a;
  const spatialMotorControls=lab.spatial?.model.constraints.filter(c=>
    (c.kind==='hinge'||c.kind==='slider')&&c.id!==lab.spatial?.driver)
    .map(c=>({id:c.id,kind:c.kind==='slider'?'prismatic' as const:'revolute' as const}))??[];
  const otherMotorControls=lab.program?.joints.filter(j=>j.id!==lab.program?.driver.joint)
    .map(j=>({id:j.id,kind:j.kind}))??spatialMotorControls;
  const engagedRatchet=!!lab.spatial?.model.mechanics?.some(m=>m.kind==='ratchet'&&m.engaged!==false);
  const driveKind = lab.spatial ? (lab.spatial.kind==='slider'?'prismatic':'revolute') :
    (lab.program?.joints.find(j => j.id === lab.program?.driver.joint)?.kind ?? 'revolute');
  const max = Math.max(0.001, lab.amplitude);
  const units = driveKind === 'revolute' ? '°' : 'LDU';
  const displayPosition = (n: number) => driveKind === 'revolute' ? n * 180 / Math.PI : n;
  const parsePosition = (n: number) => driveKind === 'revolute' ? n * Math.PI / 180 : n;
  const formatPosition = (n: number) => `${displayPosition(n).toFixed(1)}${units}`;

  const start = (program: MechanismProgram) => {
    setSweep(null);setSpatialSweep(null);
    const st = useStudio.getState();
    // The mechanism preview is a separate, finished-model viewport mode.
    // It never runs on top of a construction/keyframe playback.
    st.setTimelineEditor('build');
    st.setMode('edit');
    st.setCurrentStep(null);
    st.setLaidOut(false);
    // Never move a piece while a transform gizmo is attached to the old pose.
    st.select([]);
    usePlayback.getState().set({ follow: false, playing: false });
    useMechanismLab.getState().start(editingModel, program, previewAmplitude(program));
  };
  const previewSpatial = () => {
    if(!report||!selectedSpatialEdge||!selectedGround)return;
    try{
      const preview=createSpatialLinkagePreview(model.view,report.graph,selectedSpatialEdge.id,selectedGround);
      const solved=new SpatialMechanismSolver(preview.model).solve({[preview.driver]:0.04});
      if(solved.status!=='converged')throw Error(solved.warning??'Detected spatial mechanism is locked');
      setSpatialError('');setSpatialSweep(null);
      const st=useStudio.getState();
      st.setTimelineEditor('build');st.setMode('edit');st.setCurrentStep(null);st.setLaidOut(false);st.select([]);
      usePlayback.getState().set({follow:false,playing:false});
      useMechanismLab.getState().startSpatial(editingModel,preview,preview.kind==='slider'?6:.12);
    }catch(error){setSpatialError(error instanceof Error?error.message:String(error));}
  };
  const diagnoseSpatial = () => {
    if(!report||!selectedSpatialEdge||!selectedGround)return;
    setSpatialSweep(null);
    try{
      const review=createSpatialLinkagePreview(model.view,report.graph,selectedSpatialEdge.id,selectedGround);
      const amplitude=review.kind==='slider'?6:.15;
      const result=sweepSpatialLinkage(review.model,review.driver,amplitude,8);
      setSpatialSweep(result);setSpatialError('');
    }catch(error){setSpatialError(error instanceof Error?error.message:String(error));}
  };
  const loadSpatialFile = async (file:File|undefined) => {
    if(!file)return;
    try {
      // File.text() is non-destructive: the source model never changes.
      const text=await file.text();
      const spatial=parseSpatialRig(text,model.view);
      setCustomSpatialError('');setSpatialSweep(null);setSweep(null);
      const st=useStudio.getState();
      st.setTimelineEditor('build');st.setMode('edit');st.setCurrentStep(null);st.setLaidOut(false);st.select([]);
      usePlayback.getState().set({follow:false,playing:false});
      useMechanismLab.getState().startSpatial(editingModel,spatial,spatial.kind==='slider'?6:.12);
    }catch(error){setCustomSpatialError(error instanceof Error?error.message:String(error));}
  };
  const exportSpatialTemplate = () => {
    if(!report||!selectedSpatialEdge||!selectedGround)return;
    try {
      const spatial=createSpatialLinkagePreview(model.view,report.graph,selectedSpatialEdge.id,selectedGround);
      saveBlob(`${safeFileName(model.viewPlan.name)}-spatial-rig.json`,
        new Blob([serializeSpatialRig(spatial)],{type:'application/json'}));
      setCustomSpatialError('');
    }catch(error){setCustomSpatialError(error instanceof Error?error.message:String(error));}
  };
  const applySpatialMechanics = (next:SpatialModel) => {
    if(!lab.spatial)return;
    const upgraded={...lab.spatial,model:next,
      source:'user-authored-json' as const,
      warning:'V7 authored mechanical network. Contact, gear ratios and real limits require independent review.'};
    useMechanismLab.getState().startSpatial(editingModel,upgraded,lab.amplitude);
    setSpatialError('');setSpatialSweep(null);
  };
  const attachGeometryToSpatial = (candidate:GeometryCandidate) => {
    if(!lab.spatial)return;
    try{
      const proposal=proposeSpatialMechanic(candidate,lab.spatial);
      const next={...lab.spatial.model,mechanics:[...(lab.spatial.model.mechanics??[]),proposal.mechanic]};
      const solver=new SpatialMechanismSolver(next);
      const rest=solver.solve({});
      if(rest.status!=='converged')throw Error(rest.warning??'Mechanical relationship contradicts spatial assembly');
      applySpatialMechanics(next);
      setGeometryError(proposal.rationale);
    }catch(e){setGeometryError(e instanceof Error?e.message:String(e));}
  };
  const exportActiveSpatial = () => {
    if(!lab.spatial)return;
    saveBlob(`${safeFileName(model.viewPlan.name)}-v8-mechanics-rig.json`,
      new Blob([serializeSpatialRig(lab.spatial)],{type:'application/json'}));
  };
  const exportSpatialClip = () => {
    if(!lab.spatial)return;
    try {
      const mode=lab.spatial.model.mechanics?.some(m=>m.kind==='ratchet'&&m.engaged!==false)
        ?'forward' as const:'oscillate' as const;
      const clip=bakeSpatialClip(lab.spatial,{
        driver:lab.spatial.driver,amplitude:lab.amplitude,mode,
        durationSeconds:2,sampleHz:12,additionalMotors:lab.additionalInputs,
      });
      saveBlob(`${safeFileName(model.viewPlan.name)}-v8-spatial-motion-clip.json`,
        new Blob([JSON.stringify(clip,null,2)],{type:'application/json'}));
      setSpatialError('');
    }catch(error){setSpatialError(error instanceof Error?error.message:String(error));}
  };
  const sweepActiveSpatial = (mode:'round-trip'|'forward') => {
    if(!lab.spatial)return;
    try{
      const result=sweepSpatialLinkage(lab.spatial.model,lab.spatial.driver,lab.amplitude,8,
        {mode,additionalMotors:lab.additionalInputs});
      setSpatialSweep(result);setSpatialError('');
    }catch(e){setSpatialError(e instanceof Error?e.message:String(e));}
  };
  const previewGeometry = (candidate:GeometryCandidate) => {
    if(!report||!candidate.draft)return;
    try{
      if ((candidate.kind==='belt'||candidate.kind==='chain') &&
        (!candidate.draft.teethA||!candidate.draft.teethB))
        throw Error('Pulley or sprocket pitch ratio is not known. Author both effective pitch counts in the Transmission Workshop before preview. No ratio was invented.');
      const program=composeTransmissionProgram(model.view,report.graph,report.detection.parts,[{
        kind:candidate.kind,a:candidate.a,b:candidate.b,
        ...candidate.draft,origin:'inferred',
      }]);
      new MechanismSolver(model.view,program).solve(.1);
      setGeometryError('');start(program);
    }catch(error){
      setGeometryError(error instanceof Error?error.message:String(error));
    }
  };
  const startManual = () => {
    if (!manualPart) return;
    const axis: [number,number,number] = manualAxis === 'x' ? [1,0,0]
      : manualAxis === 'y' ? [0,1,0] : [0,0,1];
    const pivot = manualPivotMode === 'centre' ? bodyCentre! : manualPivot.map(Number) as [number,number,number];
    if (!pivot.every(Number.isFinite) || pivot.some(v => Math.abs(v) > 1e7)) {
      alert('Enter a valid LDraw-world pivot (finite coordinates within ±10,000,000 LDU).');
      return;
    }
    const program: MechanismProgram = {
      mode: 'kinematic', duration: 3, sampleHz: 60,
      joints: [{ id: 'manual-driver', body: manualPart.key, kind: manualKind, axis, pivot }],
      driver: { joint: 'manual-driver', amplitude: manualKind === 'prismatic' ? 8 : Math.PI / 12, cycles: 1 },
    };
    start(program);
  };
  const exportReport = (kind: 'json' | 'dot') => {
    if (!report) return;
    const text = kind === 'json'
      ? mechanismReportJson(report, model.viewPlan.name)
      : mechanismReportDot(report);
    saveBlob(`${safeFileName(model.viewPlan.name)}.mechanisms.${kind}`,
      new Blob([text], { type: kind === 'json' ? 'application/json' : 'text/vnd.graphviz' }));
  };
  const applyToVideo = () => {
    if (!lab.program) return;
    const secondaryMotors=Object.entries(lab.additionalInputs).filter(([,value])=>value!==0)
      .map(([joint,amplitude])=>({joint,amplitude,cycles:1}));
    const program:MechanismProgram={...lab.program,
      driver:{...lab.program.driver,amplitude:lab.amplitude},
      transmissions:lab.program.transmissions?.map(t=>
      t.kind==='clutch' && lab.engagements[t.id]!==undefined
        ? {...t,engaged:lab.engagements[t.id]} : t),
      ...(secondaryMotors.length?{secondaryMotors}:{})};
    settings.set({ planner: 'standard-motion-v4', motionV4Mechanism: program });
    useMechanismLab.getState().stop();
    onRender();
  };

  return <div className="nx-pane bm-mechanism-lab">
    <div className="nx-pane-head"><h3><Ic name="rotate" /> Mechanism Lab</h3><span className="nx-chip">Kinematics</span></div>
    <p className="nx-fine">Explore connected parts, inferred gears and moving joints in the completed 3D model. V7 couples gears, universal/CV drives, racks, differentials, actuators, cams, winches, joint stops and ratchets into the 3D linkage solver. V6 geometry screening and V5 transmissions remain available. Source placements and keyframes are never edited.</p>
    {!model.ready ? <p className="nx-hint">Loading part geometry and connectors…</p>
      : !count ? <p className="nx-hint">Import an LDraw or Studio model to inspect its mechanisms.</p>
      : busy ? <p className="nx-hint" role="status">Matching placed connectors and finding mechanisms…</p>
      : failure ? <p className="error" role="alert">{failure}</p>
      : report && <>
        <div className="nx-stat bm-lab-stats">
          <div><b>{report.detection.scanned}</b><small>Parts scanned</small></div>
          <div><b>{report.connectorPairs}</b><small>Connector pairs</small></div>
          <div><b>{ratios.length}</b><small>Possible gear meshes</small></div>
          <div><b>{report.detection.movableJoints}</b><small>Moving interfaces</small></div>
        </div>
        <div className="nx-row nx-wrap">
          <button className="nx-btn nx-sm" onClick={() => exportReport('json')}><Ic name="download" /> JSON</button>
          <button className="nx-btn nx-sm" onClick={() => exportReport('dot')}><Ic name="download" /> Graphviz DOT</button>
        </div>
        <section className="nx-card">
          <div className="nx-card-title">Live motion driver</div>
          {candidates.length ? <>
            <p className="nx-hint">Choose a detected mechanism to drive. Suggestions are limited to assemblies the current V4 solver can move. No physical stops or collision clearance are assumed.</p>
            {candidates.map((s, i) => <button key={i}
              className={`bm-lab-option ${lab.active && lab.program === s.program ? 'on' : ''}`}
              onClick={() => start(s.program)}>
              <strong>{s.title}</strong><span>{s.evidence === 'inferred-gear-mesh' ? 'Gear pair · inferred pitch' : 'Joint · LDCad connectors'}</span>
            </button>)}
          </> : <p className="nx-hint">No isolated, safely constrained demonstration was found. Missing connectors or rigid links can prevent inference. V4 manual programs remain available in Render.</p>}
          {settings.motionV4Mechanism && <button className="nx-link" onClick={() => start(settings.motionV4Mechanism!)}>Preview configured V4 program</button>}
          {lab.active && (lab.program||lab.spatial) && lab.model === editingModel && <div className="bm-lab-drive">
            <div className="nx-row nx-wrap">
              <button className="nx-btn nx-sm nx-primary" disabled={engagedRatchet}
                title={engagedRatchet?'One-way ratchets cannot use reversing sine playback; scrub forward or run a forward sweep.':''}
                aria-label={lab.playing ? 'Pause mechanism' : 'Play mechanism'} onClick={() => lab.setPlaying(!lab.playing)}><Ic name={lab.playing ? 'pause' : 'play'} /> {lab.playing ? 'Pause' : 'Play'}</button>
              <button className="nx-btn nx-sm" onClick={() => {
                if(engagedRatchet&&lab.spatial)lab.startSpatial(editingModel,{...lab.spatial},lab.amplitude);
                else lab.setPosition(0);
              }}>{engagedRatchet?'Reset pawl + centre':'Centre'}</button>
              <button className="nx-btn nx-sm" onClick={lab.stop}>Exit preview</button>
            </div>
            <label className="nx-field">Driver position <b>{formatPosition(lab.position)}</b>
              <input aria-label="Mechanism driver position" type="range"
                min={-displayPosition(max)} max={displayPosition(max)}
                step={driveKind === 'revolute' ? 0.1 : 0.05}
                value={displayPosition(lab.position)}
                onChange={e => lab.setPosition(parsePosition(Number(e.target.value)))} />
            </label>
            <label className="nx-field">Motion range <b>±{formatPosition(lab.amplitude)}</b>
              <input aria-label="Motion range" type="range" min={driveKind === 'revolute' ? 1 : 0.5}
                max={driveKind === 'revolute' ? 90 : 50} step={driveKind === 'revolute' ? 1 : 0.5}
                value={displayPosition(lab.amplitude)}
                onChange={e => lab.setAmplitude(parsePosition(Number(e.target.value)))} />
            </label>
            <label className="nx-field">Cycles per minute <b>{lab.rpm}</b>
              <input aria-label="Mechanism cycles per minute" type="range" min={1} max={120} step={1} value={lab.rpm}
                onChange={e => lab.setRpm(Number(e.target.value))} />
            </label>
            {lab.program?.transmissions?.filter(t=>t.kind==='clutch').map(t=>t.kind==='clutch'&&
              <label className="nx-row nx-wrap" key={t.id}>
                <input type="checkbox" checked={lab.engagements[t.id]??t.engaged}
                  onChange={e=>lab.setEngagement(t.id,e.target.checked)}/>
                Clutch {t.id} {lab.engagements[t.id]??t.engaged?'engaged':'disengaged'}
              </label>)}
            {(lab.program?.transmissions?.length||lab.spatial) ? <details className="nx-group">
              <summary>Independent motor controls · {otherMotorControls.length} optional</summary>
              <p className="nx-hint">Lock an extra motor coordinate to explore independent differential inputs. Conflicting motors are rejected, never silently slipped. Unlocked outputs follow the least-change kinematic solution.</p>
              {otherMotorControls.map(j=>{
                const locked=Object.prototype.hasOwnProperty.call(lab.additionalInputs,j.id);
                const linear=j.kind==='prismatic';
                const value=lab.additionalInputs[j.id]??0;
                const scale=linear?1:180/Math.PI;
                return <div className="nx-field" key={j.id}>
                  <label className="nx-row nx-wrap"><input type="checkbox" checked={locked}
                    onChange={e=>lab.setAdditionalInput(j.id,e.target.checked?0:null)}/>
                    Lock {j.id}</label>
                  {locked&&<label className="nx-field">Position: {(value*scale).toFixed(2)}{linear?' LDU':'°'}
                    <input type="range" min={linear?-50:-90} max={linear?50:90} step={linear ? .5 : 1}
                      value={value*scale} onChange={e=>lab.setAdditionalInput(j.id,Number(e.target.value)/scale)}/>
                  </label>}
                </div>;
              })}
            </details> : null}
            {engagedRatchet&&<p className="nx-hint">One-way pawl engaged: scrub forward, or use the forward-only sweep. Reverse and sine playback are blocked; Reset pawl clears the cached engagement position.</p>}
            {lab.error && <p role="alert" className="error">{lab.error}</p>}
            {lab.program ? <button className="nx-btn nx-sm" onClick={applyToVideo}><Ic name="video" /> Use as V4 render demo</button>
              : <p className="nx-hint">V8 spatial mechanics supports sampled JSON pose-clip export, but direct V4 render-stage baking remains unverified and is not supported.</p>}
            {Object.keys(lab.additionalInputs).length>0&&<p className="nx-hint">For V4 renders, secondary motor values become sinusoidal amplitudes. In V7 spatial preview they are absolute motor positions, and inconsistent motor commands fail.</p>}
            <p className="nx-hint">Live poses are a kinematic inspection preview, not a force simulation or collision certification. The V4 render planner performs a separate clearance review.</p>
          </div>}
        </section>
        {(lab.active && lab.program && lab.model===editingModel || settings.motionV4Mechanism) && <section className="nx-card">
          <div className="nx-card-title">Kinematic sweep diagnostics · V5</div>
          <p className="nx-hint">Test 49 round-trip positions for limits, algebraic constraints, and sampled loop closure. This is not a continuous collision or contact certificate.</p>
          <div className="nx-row nx-wrap">
            <button className="nx-btn nx-sm" onClick={()=>setSweep(sweepMechanism(model.view,
              lab.active && lab.program && lab.model===editingModel ? lab.program : settings.motionV4Mechanism!, report.graph))}>Run 49-sample sweep</button>
            {sweep&&<button className="nx-btn nx-sm" onClick={()=>saveBlob(`${safeFileName(model.viewPlan.name)}-kinematic-sweep.json`,
              new Blob([JSON.stringify(sweep,null,2)],{type:'application/json'}))}>Export sweep JSON</button>}
          </div>
          {sweep&&<div role="status" className="nx-hint">
            <strong>{sweep.status==='sampled-pass'?'Sampled kinematics pass':'Sampled kinematics failed'}</strong>
            {' '}· {sweep.checkedSamples}/{sweep.attemptedSamples} frames · {sweep.independentCoordinates} independent gear groups
            · maximum loop gap {sweep.maxLoopGapLdu.toFixed(4)} LDU.
            {sweep.error&&<p className="error">{sweep.error}{sweep.failedAt!==undefined?` at driver ${sweep.failedAt.toFixed(4)}`:''}</p>}
            <p>Collision/contact remains UNVERIFIED. Use the V4 render planner for clearance review.</p>
          </div>}
        </section>}
        <section className="nx-card">
          <div className="nx-card-title">V8 spatial mechanics workbench</div>
          <p className="nx-hint">Solve multi-body hinges, gear trains, differentials, actuator linkages, cams and stops simultaneously. Choose an <strong>explicit ground</strong> and motor joint. All connected moving rigid clusters are included or the solver rejects the model; no component is quietly omitted. Connector-defined axes are hypotheses, not collision certificates.</p>
          {selectedSpatialEdge ? <>
            <label className="nx-field">Driven detected joint
              <select value={selectedSpatialEdge.id} onChange={e=>{setSpatialEdge(e.target.value);setSpatialGround('');setSpatialError('');}}>
                {spatialEdges.slice(0,100).map(e=><option value={e.id} key={e.id}>{e.motion} · {e.a} ↔ {e.b}</option>)}
              </select>
            </label>
            <label className="nx-field">Explicitly grounded part / fixed cluster
              <select value={selectedGround} onChange={e=>{setSpatialGround(e.target.value);setSpatialError('');}}>
                <option value={selectedSpatialEdge.a}>{selectedSpatialEdge.a}</option>
                <option value={selectedSpatialEdge.b}>{selectedSpatialEdge.b}</option>
              </select>
            </label>
            <div className="nx-row nx-wrap">
              <button className="nx-btn nx-sm" onClick={previewSpatial}>Solve and preview spatial linkage</button>
              <button className="nx-btn nx-sm" onClick={diagnoseSpatial}>Run 33-position detected-linkage sweep</button>
              <button className="nx-btn nx-sm" onClick={exportSpatialTemplate}>Export editable spatial rig</button>

            </div>
            {spatialError&&<p className="error" role="alert">{spatialError}</p>}
            <p className="nx-hint">Up to 13 connected rigid bodies and 180 parts per preview. Locked, inconsistent or unsupported assemblies are reported as errors; spatial previews cannot yet be sent to the saved animation stage.</p>
          </> : <p className="nx-hint">No detected moving LDCad joints with axes. Manual hinge previews and transmission authoring remain available.</p>}
            {spatialSweep&&<div className="nx-hint" role="status">
              <strong>{spatialSweep.status==='sampled-pass'?'Sampled linkage pass':'Linkage failed at sampled position'}</strong>
              {' '}· {spatialSweep.checkedSamples}/{spatialSweep.attemptedSamples} positions
              · maximum residual {spatialSweep.maxResidualLdu.toFixed(4)} scaled LDU
              · estimated remaining DoF {spatialSweep.minimumFreeDof}.
              {spatialSweep.failures.map((f,i)=><p className="error" key={i}>{f.reason} at {f.at.toFixed(3)} {(lab.spatial?.kind==='slider'||selectedSpatialEdge?.motion==='sliding')?'LDU':'radians'}</p>)}
              <p>Sampled ideal kinematics only. No continuous clearance, load, contact or real-set certification.</p>
            </div>}

          <div className="nx-field">
            <label htmlFor="bm-v6-rig-import">Import reviewed V8/V7 mechanics or legacy V6 spatial rig (optional)</label>
            <input id="bm-v6-rig-import" aria-label="Import spatial rig JSON" type="file" accept=".json,application/json"
              onChange={event=>{const file=event.currentTarget.files?.[0];
                if(file)void loadSpatialFile(file);
                event.currentTarget.value='';}} />
            <p className="nx-hint">Author hinges, sliders, cylindrical/planar/universal joints, ball joints, welds, fixed links and coupled mechanisms when LDCad snaps are missing. JSON needs an explicit ground, motor and a unique mapping to placed part keys. Imported rigs are never auto-certified.</p>
            {customSpatialError&&<p className="error" role="alert">{customSpatialError}</p>}
          </div>
          {lab.active&&lab.spatial&&lab.model===editingModel&&<>
            <SpatialMechanicsDesigner preview={lab.spatial} onApply={applySpatialMechanics}/>
            {spatialSweep&&<button className="nx-btn nx-sm" onClick={()=>saveBlob(
              `${safeFileName(model.viewPlan.name)}-v8-mechanics-sweep.json`,
              new Blob([JSON.stringify(spatialSweep,null,2)],{type:'application/json'}))}>Export sweep evidence JSON</button>}
            <div className="nx-row nx-wrap">
              <button className="nx-btn nx-sm" onClick={exportActiveSpatial}>Export active V8/V7 mechanics rig</button>
              <button className="nx-btn nx-sm" onClick={exportSpatialClip}>Bake sampled V8 pose clip JSON</button>
              <button className="nx-btn nx-sm" onClick={()=>sweepActiveSpatial('round-trip')}>Sweep active network · 33 samples</button>
              {lab.spatial.model.mechanics?.some(m=>m.kind==='ratchet'&&m.engaged!==false)&&
               <button className="nx-btn nx-sm" onClick={()=>sweepActiveSpatial('forward')}>Sweep ratchet · forward only</button>}
            </div>
          </>}
        </section>
        <TransmissionDesigner assembly={model.view} parts={report.detection.parts} graph={report.graph} hints={report.detection.functionalHints}
          modelName={model.viewPlan.name} onPreview={start}
          onSave={program=>settings.set({planner:'standard-motion-v4',motionV4Mechanism:program})}/>
        <section className="nx-card">
          <div className="nx-card-title">V6 geometry-screened mechanisms <span className="nx-count">{geometryReady.length}</span></div>
          <p className="nx-hint">Candidates must pass shaft alignment, pitch-distance / planar checks and rigid-cluster screening before preview. This is stronger evidence than name proximity but <strong>NOT</strong> a physical engagement or collision certificate. Previewing requires explicit approval.</p>
          {geometryReady.slice(0,16).map(c=><div key={c.id} className="bm-lab-relation">
            <strong>{c.kind} · geometry consistent (review required)</strong>
            <span>{c.a} ↔ {c.b} · centre separation {c.metrics.separationLdu.toFixed(1)} LDU</span>
            <small>{c.reasons[0]} {c.metrics.pitchErrorLdu!==undefined?`Pitch mismatch: ${c.metrics.pitchErrorLdu.toFixed(2)} LDU.`:''}</small>
            <div className="nx-row nx-wrap"><button className="nx-btn nx-sm" onClick={()=>previewGeometry(c)}>Preview unverified pair</button>
            <button className="nx-btn nx-sm" onClick={()=>selectPart(c.a)}>Select input</button>
            {lab.active&&lab.spatial&&lab.model===editingModel&&
             <button className="nx-btn nx-sm" onClick={()=>attachGeometryToSpatial(c)}>Add screened relation to V8 rig</button>}
            </div>
          </div>)}
          {!geometryReady.length&&<p className="nx-hint">No candidate passed the geometry screen. Check LDraw tooth descriptions and LDCad shaft metadata; we do not invent missing axes.</p>}
          {geometryReady.length>16&&<p className="nx-hint">Showing 16 of {geometryReady.length}; export JSON for all screened pairs.</p>}
          {geometryError&&<p className="error" role="alert">{geometryError}</p>}
          {geometryRejected.length>0&&<details className="nx-group"><summary>Rejected nearby pairs · {geometryRejected.length}</summary>
            <p className="nx-hint">Each exclusion has an evidence trail. Rejected models can still be authored manually.</p>
            {geometryRejected.slice(0,24).map(c=><button className="bm-lab-relation" key={c.id} onClick={()=>selectPart(c.a)}>
              <strong>{c.kind} · excluded</strong><span>{c.a} ↔ {c.b}</span>
              <small>{c.reasons.join(' · ')}</small>
            </button>)}
          </details>}
        </section>
        <section className="nx-card">
          <div className="nx-card-title">Part classifications</div>
          <p className="nx-hint">Categories from part descriptions and connector hints, not a guarantee of mechanically movable parts.</p>
          <div className="bm-lab-categories">
            {(Object.entries(report.detection.kinds) as [string,number][]).filter(([,v]) => v > 0).sort((a,b) => b[1]-a[1]).map(([kind, number]) =>
              <div key={kind} className="bm-lab-category"><span>{kind}</span>
                <div role="presentation"><span style={{ width: `${Math.max(2, 100 * number / count)}%` }} /></div>
                <b>{number}</b></div>)}
          </div>
        </section>
        <section className="nx-card">
          <div className="nx-card-title">Detected gear engagements <span className="nx-count">{ratios.length}</span></div>
          {ratios.length ? ratios.map((g, i) => <button key={i} className="bm-lab-relation" title="Select the first gear and frame it" onClick={() => selectPart(g.a)}>
            <strong>{g.a} ↔ {g.b}</strong><span>{g.teethA}:{g.teethB} teeth · 1 input turn → {(-g.teethA / g.teethB).toFixed(3)} output turns</span>
            <small>Pitch-matched, not verified tooth contact</small>
          </button>) : <p className="nx-hint">No compatible spur-gear pitch pairs; gears need readable tooth-count headers and LDCad axle-hole axes.</p>}
        </section>
        <details className="nx-group" open={showAll} onToggle={e => setShowAll(e.currentTarget.open)}>
          <summary>Connection explorer · {report.graph.edges.length} interfaces</summary>
          <div className="nx-field"><input aria-label="Filter mechanisms" placeholder="Filter by part, joint type or motion…" value={query} onChange={e => setQuery(e.target.value)} /></div>
          {joints.slice(0, 80).map((j, i) => <button key={`${j.a}-${j.b}-${i}`} className="bm-lab-relation" onClick={() => selectPart(j.a)}>
            <strong>{j.kind} · {j.motion}</strong><span>{j.a} ↔ {j.b}</span><small>{j.evidence}</small>
          </button>)}
          {joints.length > 80 && <p className="nx-hint">Showing the first 80 of {joints.length} filtered moving connections. Export JSON for the full report.</p>}
          {!joints.length && <p className="nx-hint">No matching moving joints.</p>}
        </details>
        <details className="nx-group">
          <summary>Unconnected / uncertain parts · {report.graph.uncertainBodies.length}</summary>
          <p className="nx-hint">These parts have no matched LDCad connector pair. This does not prove they are physically loose.</p>
          {report.graph.uncertainBodies.slice(0, 40).map(key => <button key={key} className="bm-lab-relation" onClick={() => selectPart(key)}>{key}</button>)}
          {report.graph.uncertainBodies.length > 40 && <p className="nx-hint">Export JSON for all uncertain parts.</p>}
        </details>
        <details className="nx-group"><summary>Evidence & limitations</summary>
          <p className="nx-hint">{report.missingMetadata} of {count} parts lack LDCad snaps. {report.pairsExamined} nearby part pairs examined; {report.graph.rigidClusters.length} fixed-connectivity clusters.</p>
          {report.detection.warnings.map((w,i) => <p className="nx-hint" key={i}>{w}</p>)}
        </details>
      </>}
    {manualPart && <details className="nx-group bm-lab-manual">
      <summary>Manual motion sandbox · any part</summary>
      <p className="nx-hint">Parts without connector metadata can still be posed manually. Select the body, motion axis and pivot. This illustrates motion but does <strong>not</strong> establish a real physical joint or collision clearance.</p>
      <label className="nx-field">Moving part
        <select value={manualPart.key} onChange={e => { setManualKey(e.target.value); setManualPivotMode('centre'); }}>
          {manualOptions.map(i => <option key={i.key} value={i.key}>{i.key} · {i.part}</option>)}
        </select>
      </label>
      <div className="nx-row nx-wrap">
        <label className="nx-field bm-lab-field">Movement
          <select value={manualKind} onChange={e => setManualKind(e.target.value as 'revolute'|'prismatic')}>
            <option value="revolute">Rotate</option><option value="prismatic">Slide</option>
          </select>
        </label>
        <label className="nx-field bm-lab-field">World axis
          <select value={manualAxis} onChange={e => setManualAxis(e.target.value as 'x'|'y'|'z')}>
            <option value="x">X</option><option value="y">Y</option><option value="z">Z</option>
          </select>
        </label>
      </div>
      <label className="nx-field">Pivot location
        <select value={manualPivotMode} onChange={e => {
          setManualPivotMode(e.target.value as 'centre'|'custom');
          if (e.target.value === 'custom') setManualPivot(bodyCentre!.map(String) as [string,string,string]);
        }}>
          <option value="centre">Centre of part bounds</option><option value="custom">Custom world-space X / Y / Z (LDU)</option>
        </select>
      </label>
      {manualPivotMode === 'custom' && <div className="nx-row">
        {(['X','Y','Z'] as const).map((axis,i) => <label key={axis} className="nx-field bm-lab-field">{axis}
          <input type="number" step="0.5" value={manualPivot[i]}
            onChange={e => setManualPivot(prev => prev.map((n,ix) => ix === i ? e.target.value : n) as [string,string,string])} />
        </label>)}
      </div>}
      <button className="nx-btn nx-sm" onClick={startManual}><Ic name="rotate" /> Preview illustrative joint</button>
    </details>}
  </div>;
}
