import { useEffect, useState } from 'react';
import type { Timeline } from '../anim/timeline';
import type { LogoCorner } from '../export/exportVideo';
import { FPS_OPTIONS, type ExportFps } from '../export/frameRates';
import { VIDEO_FORMATS, type VideoFormat } from '../export/formats';
import { useStudio } from '../state/store';
import { resetFloorShifts } from '../plan/pieceActions';
import { useAppSettings } from '../state/appSettings';
import { validateJointLimitRules, type JointLimitRule } from '../anim/motion/v4/jointLimits';
import { validateMechanismProgram, type MechanismProgram } from '../anim/motion/v4/mechanismProgram';
import { Ic } from './icons';
import { DEFAULT_CAMERA_SETTINGS } from '../anim/camera';
import { animationOf } from '../anim/keyframes';
import { buildLayerAt } from '../anim/buildLayer';
import { animationDuration } from '../export/exportVideo';

const CORNERS: [LogoCorner, string][] = [
  ['tl', 'Top left'],
  ['tr', 'Top right'],
  ['bl', 'Bottom left'],
  ['br', 'Bottom right'],
];
const MODES = [
  ['auto', 'Auto'],
  ['piece', 'One by one'],
  ['batch', 'Batches'],
  ['step', 'By step'],
] as const;

const formatLength = (sec: number) => (sec < 90 ? `${sec.toFixed(0)} s` : `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`);

/** Video settings: length, how pieces arrive, the hero orbit and the logo. */
export function VideoPanel({ timeline, onExport }: { timeline: Timeline | null; onExport(): void }) {
  const s = useAppSettings();
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [acceptUncertified, setAcceptUncertified] = useState(false);
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  const [limitError, setLimitError] = useState('');
  const [mechanismDraft, setMechanismDraft] = useState<string | null>(null);
  const [mechanismError, setMechanismError] = useState('');
  useEffect(() => {
    if (!s.logo) return setLogoUrl(null);
    const u = URL.createObjectURL(s.logo);
    setLogoUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [s.logo]);
  const longer = timeline && timeline.duration > s.targetSeconds + 0.05;
  useEffect(() => setAcceptUncertified(false), [timeline?.fallback?.code, timeline?.fallback?.message,
    timeline?.motion?.v4?.mesh.blocked, timeline?.motion?.v4?.mesh.unverified, timeline?.mechanismStage]);
  const editingModel = useStudio((st) => st.editingModel);
  const timelineEditor = useStudio((st) => st.timelineEditor);
  const animation = useStudio((st) => animationOf(st.plan.animation));
  const manual = timelineEditor === 'timeline';
  const linked = !!buildLayerAt(animation, editingModel);
  /** pieces dragged to another waiting spot */
  const moved = useStudio((st) => [...st.plan.steps, ...Object.values(st.plan.submodels ?? {}).flatMap((m) => m.steps)].reduce((n, step) => n + step.pieces.filter((i) => i.assembly?.floorShift).length, 0));
  const fmt = VIDEO_FORMATS[s.format];
  const setCamera = (key: keyof typeof s.camera, value: number) => s.set({ camera: { ...s.camera, [key]: value } });

  const loadLogo = async (f: File) => {
    setError('');
    try {
      const logoBitmap = await createImageBitmap(f);
      s.set({ logo: f, logoBitmap, logoEnabled: true });
    } catch {
      setError("That image couldn't be read. Try a PNG.");
    }
  };
  const v2 = ['construction-v2', 'construction-auto', 'construction-v3', 'construction-v3-auto', 'construction-v4'].includes(s.planner ?? '');
  const v3 = s.planner === 'construction-v3' || s.planner === 'construction-v3-auto';
  const v4 = s.planner === 'construction-v4';
  const motionV4 = s.planner === 'standard-motion-v4';
  const motion = s.planner === 'standard-motion' || motionV4;
  const artifactPlanner = s.planner === 'assembly-artifact';
  const hasArtifact = useStudio((st) => st.plan.assemblyPlan != null);
  const v4NeedsReview = ((timeline?.motion?.v4?.mesh.blocked ?? 0) +
    (timeline?.motion?.v4?.mesh.unverified ?? 0) > 0) || !!(timeline?.mechanismStage && timeline.mechanismStage.collisionStatus !== 'clear');
  const previewNeedsConsent = (!!timeline?.fallback || v4NeedsReview) && (!manual || linked);

  return (
    <div className="nx-pane bm-video">
      <div className="nx-pane-head">
        <h3>Video</h3>
        <span className="nx-chip">{s.format} · {fmt.width}×{fmt.height} · {s.fps} fps</span>
      </div>

      {manual && <p className="nx-fine"><strong>Timeline export</strong> · {animationDuration(animation).toFixed(2)} s
        · {animation.fps} authored fps · frames {animation.startFrame}–{animation.endFrame}.
        {linked ? ' Generated Build motion and your keyed offsets are both rendered.' : ' No construction planning is required.'}
        The output FPS below controls video sampling, not key timing.
      </p>}
      {!manual && <label className="nx-field">
        Length <b>{formatLength(s.targetSeconds)}</b>
        <input type="range" min={5} max={600} step={5} value={s.targetSeconds} onChange={(e) => s.set({ targetSeconds: Number(e.target.value) })} />
      </label>}
      {!manual && timeline && (
        <p className="nx-fine">
          Comes out at <strong>{timeline.duration.toFixed(1)} s</strong>
          {longer ? ': step pauses and submodels built one after another add time.' : '.'}
        </p>
      )}
      {!manual && <>
      <div className="nx-field">
        Pieces arrive
        <div className="nx-seg" role="radiogroup" aria-label="Pieces arrive">
          {MODES.map(([v, l]) => (
            <button key={v} role="radio" disabled={v2} aria-checked={s.mode === v} className={s.mode === v ? 'on' : ''} onClick={() => s.set({ mode: v })}>
              {l}
            </button>
          ))}
        </div>
        {v2 && <span className="nx-hint">V2 places verified operations one after another.</span>}
        {!v2 && s.mode === 'piece' && (
          <span className="nx-hint">
            Each piece lands before the next starts{timeline ? ` (${formatLength(timeline.duration)} here)` : ''}. Batches or Auto make it shorter.
          </span>
        )}
        {!v2 && s.mode === 'auto' && timeline && (
          <span className="nx-hint">
            Picked: {timeline.pacing.mode === 'piece' ? 'one by one' : timeline.pacing.mode === 'step' ? 'step by step' : 'in batches'}
          </span>
        )}
      </div>
      <label className="nx-check">
        <input type="checkbox" checked={s.heroOrbit} onChange={(e) => s.set({ heroOrbit: e.target.checked })} /> End with a hero orbit
      </label>

      <details className="nx-group bm-vsec">
        <summary>Timing<span className="bm-vsec-val">{s.introSeconds ?? s.buildSeconds ?? s.outroSeconds ? 'Custom' : 'Auto'}</span></summary>
        <div className="bm-timing-actions">
          <button className="nx-btn nx-sm" type="button" title="The reference videos are about 14 s. Keeps movement collision-safe, so the build may still run longer."
            onClick={() => s.set({ targetSeconds: 14, introSeconds: 0.6, buildSeconds: 10.4, outroSeconds: 3, heroOrbit: true })}>
            Match reference pacing (14 s)
          </button>
          <button className="nx-link" onClick={() => s.set({ introSeconds: null, buildSeconds: null, outroSeconds: null })}>Reset to auto</button>
        </div>
        <div className="bm-duration-fields" aria-label="Timeline clip durations">
          {([
            ['introSeconds', 'Intro', timeline?.intro ?? 1],
            ['buildSeconds', 'Build', timeline ? timeline.buildEnd - timeline.intro : Math.max(1, s.targetSeconds - 4)],
            ['outroSeconds', s.heroOrbit ? 'Hero orbit' : 'Hold', timeline ? timeline.duration - timeline.buildEnd : 3],
          ] as const).map(([key, label, actual]) => (
            <label className="nx-field" key={key}>
              {label} (s)
              <input aria-label={`${label} duration in seconds`} type="number" min={key === 'buildSeconds' ? 1 : 0.2} max={key === 'buildSeconds' ? 1800 : 120} step={0.1}
                placeholder={actual.toFixed(1)} value={s[key] ?? ''}
                onChange={(e) => {
                  const raw = e.currentTarget.value;
                  if (!raw) return s.set({ [key]: null });
                  const num = Number(raw);
                  if (Number.isFinite(num)) s.set({ [key]: Math.min(key === 'buildSeconds' ? 1800 : 120, Math.max(key === 'buildSeconds' ? 1 : 0.2, num)) });
                }} />
            </label>
          ))}
        </div>
        <span className="nx-hint">Empty fields follow Length. You can also drag a clip's edge in the timeline.</span>
      </details>

      </>}
      <details className="nx-group bm-vsec">
        <summary>Camera<span className="bm-vsec-val">{s.cameraFraming === 'wide' ? 'Wide' : 'Cinematic'} · {s.camera.lensMm} mm</span></summary>
        <label className="nx-field">
          Framing
          <select aria-label="Camera framing" value={s.cameraFraming} onChange={(e) => s.set({ cameraFraming: e.target.value as typeof s.cameraFraming })}>
            <option value="cinematic">Cinematic — closer, more overhead</option>
            <option value="wide">Wide — whole model in frame</option>
          </select>
        </label>
        {manual && <p className="nx-hint">Timeline videos generated from Build (including fully baked Standard Motion tracks) follow the Build camera, its framing and the hero orbit. Fully hand-keyed clips use a stable camera at the chosen azimuth, elevation and lens; Build drift and damping do not apply to them.</p>}
        <div className="bm-camera-actions">
          <button type="button" className="nx-btn nx-sm" onClick={() => s.set({ camera: { ...DEFAULT_CAMERA_SETTINGS } })}>Reference</button>
          <button type="button" className="nx-btn nx-sm" onClick={() => s.set({ camera: { ...s.camera, lensMm: 42, buildElevation: 54, buildMargin: 1.08, targetLock: 0.72, submodelFocus: 1 } })}>Closer</button>
          <button type="button" className="nx-btn nx-sm" onClick={() => s.set({ camera: { ...s.camera, lensMm: 60, buildElevation: 64, buildMargin: 1.18, targetLock: 0.94, submodelFocus: 0.6 } })}>Stable overhead</button>
        </div>
        <div className="bm-camera-grid">
          <label className="nx-field">Lens (mm)<input type="number" min={18} max={200} step={1} value={s.camera.lensMm} onChange={(e) => setCamera('lensMm', Number(e.target.value))} /></label>
          <label className="nx-field">Sensor (mm)<input type="number" min={12} max={70} step={1} value={s.camera.sensorWidthMm} onChange={(e) => setCamera('sensorWidthMm', Number(e.target.value))} /></label>
          <label className="nx-field">Azimuth (°)<input type="number" min={-180} max={180} step={1} value={s.camera.buildAzimuth} onChange={(e) => setCamera('buildAzimuth', Number(e.target.value))} /></label>
          <label className="nx-field">Elevation (°)<input type="number" min={15} max={89} step={1} value={s.camera.buildElevation} onChange={(e) => setCamera('buildElevation', Number(e.target.value))} /></label>
          <label className="nx-field">Margin<input type="number" min={1} max={2} step={0.01} value={s.camera.buildMargin} onChange={(e) => setCamera('buildMargin', Number(e.target.value))} /></label>
          <label className="nx-field">Drift (°)<input type="number" min={-45} max={45} step={1} value={s.camera.buildDrift} onChange={(e) => setCamera('buildDrift', Number(e.target.value))} /></label>
        </div>
        <label className="nx-field" title="Keeps the shot centred on the finished (sub)model instead of chasing incoming pieces.">Target lock <b>{Math.round(s.camera.targetLock * 100)}%</b><input type="range" min={0} max={1} step={0.01} value={s.camera.targetLock} onChange={(e) => setCamera('targetLock', Number(e.target.value))} /></label>
        <label className="nx-field" title="Removes small zoom and pan corrections between placements for a calm, tripod-like shot.">Damping <b>{Math.round(s.camera.damping * 100)}%</b><input type="range" min={0} max={1} step={0.01} value={s.camera.damping} onChange={(e) => setCamera('damping', Number(e.target.value))} /></label>
        <label className="nx-field" title="At 100% a submodel being built fills the shot; lower keeps the main model in view too.">Submodel focus <b>{Math.round(s.camera.submodelFocus * 100)}%</b><input type="range" min={0} max={1} step={0.01} value={s.camera.submodelFocus} onChange={(e) => setCamera('submodelFocus', Number(e.target.value))} /></label>
        <div className="nx-sub">Hero orbit</div>
        <div className="bm-camera-grid">
          <label className="nx-field">Orbit (°)<input type="number" min={-360} max={360} step={5} value={s.camera.heroOrbitDegrees} onChange={(e) => setCamera('heroOrbitDegrees', Number(e.target.value))} /></label>
          <label className="nx-field">Elevation (°)<input type="number" min={5} max={85} step={1} value={s.camera.heroElevation} onChange={(e) => setCamera('heroElevation', Number(e.target.value))} /></label>
          <label className="nx-field">Margin<input type="number" min={1} max={2} step={0.01} value={s.camera.heroMargin} onChange={(e) => setCamera('heroMargin', Number(e.target.value))} /></label>
        </div>
      </details>

      <details className="nx-group bm-vsec">
        <summary>Look &amp; sound<span className="bm-vsec-val">{s.studioLook === 'soft' ? 'Soft studio' : 'Bright studio'}</span></summary>
        <label className="nx-field">
          Studio
          <select aria-label="Studio appearance" value={s.studioLook} onChange={(e) => s.set({ studioLook: e.target.value as typeof s.studioLook })}>
            <option value="soft">Soft studio — grey, contact shadows</option>
            <option value="classic">Bright studio — white</option>
          </select>
        </label>
        <label className="nx-check"><input type="checkbox" checked={s.edgeLines} onChange={(e) => s.set({ edgeLines: e.target.checked })} /> Edge lines</label>
        <label className="nx-check" title="Linear tone mapping instead of filmic"><input type="checkbox" checked={s.linearColors} onChange={(e) => s.set({ linearColors: e.target.checked })} /> True LEGO colours</label>
        <label className="nx-check" title="A click each time pieces connect"><input type="checkbox" checked={s.snapSound} onChange={(e) => s.set({ snapSound: e.target.checked })} /> Snap sound</label>
      </details>

      {!manual && <>
      <details className="nx-group bm-vsec">
        <summary>Waiting pieces<span className="bm-vsec-val">{moved ? `${moved} moved` : ''}</span></summary>
        <div className="nx-grid2">
          <label className="nx-field">
            Group
            <select aria-label="Group waiting pieces" disabled={v2} value={s.floorSort} onChange={(e) => s.set({ floorSort: e.target.value as typeof s.floorSort })}>
              <option value="step">By step</option>
              <option value="colour">By colour</option>
              <option value="part">By part</option>
              <option value="size">By size</option>
            </select>
          </label>
          <label className="nx-field">
            Where
            <select aria-label="Where waiting pieces lie" disabled={v2} value={s.floorSides} onChange={(e) => s.set({ floorSides: e.target.value as typeof s.floorSides })}>
              <option value="front-back">In front and behind</option>
              <option value="front">In front</option>
              <option value="behind">Behind</option>
              <option value="sides">Left and right</option>
            </select>
          </label>
        </div>
        <span className="nx-hint">Drag a waiting piece in the Build view to move it.</span>
        {moved > 0 && (
          <button className="nx-btn nx-sm" onClick={() => useStudio.getState().apply(resetFloorShifts)}>
            <Ic name="undo" /> Put {moved} moved piece{moved === 1 ? '' : 's'} back
          </button>
        )}
        <label className="nx-check" title="Within a step, each piece waits for what it rests on">
          <input type="checkbox" disabled={v2} checked={s.bottomUp} onChange={(e) => s.set({ bottomUp: e.target.checked })} /> Build bottom-up
        </label>
      </details>

      </>}
      <details className="nx-group bm-vsec">
        <summary>Logo<span className="bm-vsec-val">{s.logoEnabled && s.logoBitmap ? 'On' : 'Off'}</span></summary>
        <div className="bm-logo-row">
          {logoUrl ? <img src={logoUrl} alt="Logo preview" className="logo-preview" /> : <div className="logo-preview nx-hint">No logo</div>}
          <div className="nx-grow" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label className="nx-btn nx-sm bm-file-btn">
              <Ic name="upload" /> {s.logo ? 'Replace logo' : 'Choose logo'}
              <input type="file" hidden accept="image/png,image/svg+xml,image/jpeg,image/webp" aria-label="Logo file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void loadLogo(f);
                }} />
            </label>
            {s.logo && (
              <button className="nx-link" style={{ alignSelf: 'flex-start' }} onClick={() => s.set({ logo: null, logoBitmap: null, logoEnabled: false })}>
                Remove logo
              </button>
            )}
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <label className="nx-check">
          <input type="checkbox" checked={s.logoEnabled} disabled={!s.logoBitmap} onChange={(e) => s.set({ logoEnabled: e.target.checked })} /> Show the logo on the video
        </label>
        <label className="nx-field">
          Corner
          <select value={s.logoCorner} disabled={!s.logoBitmap} onChange={(e) => s.set({ logoCorner: e.target.value as LogoCorner })}>
            {CORNERS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
      </details>

      {!manual && <>
      <details className="nx-group bm-vsec">
        <summary>Planner<span className="bm-vsec-val">{s.planner === 'construction-v3-auto' ? 'V3 Adaptive' : s.planner === 'construction-auto' ? 'V2 Adaptive' : artifactPlanner ? 'Assembly artifact' : v3 ? 'Construction V3' : v4 ? 'Construction V4' : v2 ? 'Construction V2' : motionV4 ? 'Standard Motion V4' : motion ? 'Standard Motion V3' : 'Standard'}</span></summary>
        <label className="nx-field">
          Assembly planner
          <select aria-label="Assembly planner" value={s.planner ?? 'legacy'} onChange={(e) => s.set({ planner: e.target.value as NonNullable<typeof s.planner> })}>
            <option value="legacy">Standard — flexible preview</option>
            <option value="standard-motion">Standard Motion v3 — mechanics + kinematics (editable preview)</option>
            <option value="standard-motion-v4">Standard Motion v4 — mechanical graph, collision checks, gears, linkages, gravity</option>
            <option value="construction-v4">Construction V4 — global scene, articulation-aware (experimental)</option>
            <option value="construction-v3">Construction V3 — guided, certified only</option>
            <option value="construction-v3-auto">Construction V3 — guided, preview fallback</option>
            <option value="construction-auto">Adaptive V2 — then uncertified preview</option>
            <option value="construction-v2">Construction V2 — certified only</option>
            <option value="assembly-artifact">Assembly artifact — Python-engine certified plan</option>
          </select>
          <span className="nx-hint">{artifactPlanner
            ? 'Requires a model-matched assembly artifact from the Python planning engine.'
            : motionV4
              ? 'Standard Motion V4 checks the connector constraint graph, certifies supported continuous triangle-mesh translations and hinge arcs, and enforces explicitly configured joint limits. It tries alternative routes when obstructed. Each move is CLEAR, BLOCKED, or UNVERIFIED; unsupported motion and connector seating are never marked clear. Existing V3 remains separate. The final brick placements and editable keyframes are preserved. Opt-in mechanism demonstrations support gear ratios, loop closures and constrained gravity. Their moving meshes are checked between playback frames; uncertain contacts remain UNVERIFIED. Gear and turntable detection produces opt-in suggestions, never invented joint stops.'
              : motion
                ? 'Standard Motion V3 is an editable connector-guided preview with sampled AABB collision advisories, exact hinge pivots and axial insertions; it is not mesh-certified.'
                : 'Construction engines apply their own planning and certification policies. No mode simulates gravity or gear-tooth dynamics.'}</span>
        </label>
        {motionV4 && timeline?.motion?.v4?.planning && <div className="nx-field" aria-live="polite">
          <strong>V4 assembly planning and collision review</strong>
          <span className="nx-hint">Generated {timeline.motion.v4.planning.retainedMoves} editable tracks · {timeline.motion.v4.mesh.certified} CLEAR · {timeline.motion.v4.mesh.blocked} BLOCKED · {timeline.motion.v4.mesh.unverified} UNVERIFIED.</span>
          {timeline.motion.v4.planning.limitedVerification && <span className="nx-hint">Large-model verification uses bounded work limits. A route that reaches a limit stays playable but is marked UNVERIFIED, never certified.</span>}
          {timeline.motion.v4.planning.warnings.map((warning,i)=><p key={i} className="nx-hint" role="status">{warning}</p>)}
        </div>}
        {motionV4 && <div className="nx-field">
          <strong>V4 joint limits (assembled position = zero)</strong>
          <span className="nx-hint">Provide a JSON array of signed radians for hinge travel or LDraw units for axial travel. Specify exact moving and host instance keys. An empty array leaves physical stops unknown — v4 never invents them.</span>
          <textarea aria-label="V4 joint limit rules JSON" rows={4}
            value={limitDraft ?? JSON.stringify(s.motionV4Limits ?? [],null,2)}
            onChange={e=>setLimitDraft(e.target.value)} spellCheck={false} />
          <button className="nx-link" type="button" onClick={()=>{
            try{
              const parsed:unknown=JSON.parse(limitDraft ?? JSON.stringify(s.motionV4Limits ?? []));
              if(!Array.isArray(parsed))throw new Error('Expected a JSON array of joint limit rules.');
              const problems=validateJointLimitRules(parsed as JointLimitRule[]);
              if(problems.length)throw new Error(problems.join('; '));
              s.set({motionV4Limits:parsed as JointLimitRule[]});setLimitDraft(null);setLimitError('');
            }catch(e){setLimitError(e instanceof Error?e.message:String(e));}
          }}>Apply joint limits</button>
          <span className="nx-hint">{(s.motionV4Limits??[]).length} active rule(s). Units: radians or LDraw units. No default limits are assumed.</span>
          {limitError && <p className="error" role="alert">{limitError}</p>}
        </div>}
        {motionV4 && <div className="nx-field">
          <strong>V4 mechanical demonstration — phases 4, 5 and 6</strong>
          {timeline?.motion?.v4?.detection && <div className="nx-field">
            <strong>Automatic LDraw mechanical detection</strong>
            <span className="nx-hint">Scanned {timeline.motion.v4.detection.scanned} instances · {timeline.motion.v4.detection.kinds.gear} gears · {timeline.motion.v4.detection.kinds.hinge} hinges · {timeline.motion.v4.detection.kinds.turntable} turntables · {timeline.motion.v4.detection.kinds.axle + timeline.motion.v4.detection.kinds.shaft} axle/shaft pieces · {timeline.motion.v4.detection.matchedJoints} matched joint interfaces ({timeline.motion.v4.detection.movableJoints} movable) · {timeline.motion.v4.detection.gearMeshes} inferred gear contacts.</span>
            {timeline.motion.v4.detection.suggestions.length > 0 ? <>
              <span className="nx-hint">Opt-in suggestions use exact instance keys. Activate one to populate a working editable mechanism program; inspect its collision status after rebuilding.</span>
              {timeline.motion.v4.detection.suggestions.map((proposal,i)=><div key={i}>
                <button className="nx-link" type="button" onClick={()=>{
                  const errors=validateMechanismProgram(proposal.program);
                  if(errors.length){setMechanismError(errors.join('; '));return;}
                  s.set({motionV4Mechanism:proposal.program});setMechanismDraft(null);setMechanismError('');
                }}>Use detected motion: {proposal.title}</button>
                <span className="nx-hint">{proposal.warnings.join(' ')}</span>
              </div>)}
            </> : <span className="nx-hint">No isolated mechanism was sufficiently constrained for an automatic animation suggestion. You can still use the editable program below.</span>}
            <details><summary>Detected mechanical interfaces and evidence</summary>
              {(timeline.motion.v4.detection.jointDetails??[]).map((joint,i)=><p key={i} className="nx-hint">
                {joint.kind} · {joint.motion} · {joint.a} ↔ {joint.b} ({joint.evidence})
              </p>)}
              {(timeline.motion.v4.detection.gearDetails??[]).map((pair,i)=><p key={`gear-${i}`} className="nx-hint">
                Inferred spur-gear pitch: {pair.teethA}:{pair.teethB} teeth · {pair.a} ↔ {pair.b} · REVIEW REQUIRED
              </p>)}
              {timeline.motion.v4.detection.matchedJoints>40 && <p className="nx-hint">Only the first 40 mechanical interfaces are shown.</p>}
            </details>
            <details><summary>Detection limitations and missing metadata</summary>
              {timeline.motion.v4.detection.warnings.map((warning,i)=><p key={i} className="nx-hint">{warning}</p>)}
            </details>
          </div>}
          <span className="nx-hint">Optional, post-assembly only. Configure exact instance keys, world-space pivots, shaft axes, gear tooth counts, optional loop-closure anchors and measured masses. Detectable gear tooth counts and compatible connections are reported from LDraw headers and LDCad connector data; inferred gear engagement is explicitly marked provisional. Real mass, joint stops and physics properties are never guessed from render meshes. The mechanism plays after Build and can be baked into ordinary editable keyframes.</span>
          <textarea aria-label="V4 mechanical program JSON" rows={7} spellCheck={false}
            placeholder={'{\n  "mode": "kinematic", "duration": 4, "sampleHz": 60,\n  "joints": [{ "id":"shaft-a", "body":"INSTANCE_KEY", "kind":"revolute", "pivot":[0,0,0], "axis":[0,1,0] }],\n  "driver":{"joint":"shaft-a","amplitude":0.7853981634,"cycles":1}\n}'}
            value={mechanismDraft ?? (s.motionV4Mechanism ? JSON.stringify(s.motionV4Mechanism,null,2) : '')}
            onChange={e=>setMechanismDraft(e.target.value)} />
          <div className="bm-timing-actions">
            <button className="nx-link" type="button" onClick={()=>{
              try{
                const text=mechanismDraft ?? (s.motionV4Mechanism?JSON.stringify(s.motionV4Mechanism):'');
                if(!text.trim()) {s.set({motionV4Mechanism:null});setMechanismDraft(null);setMechanismError('');return;}
                const parsed:unknown=JSON.parse(text);
                const problems=validateMechanismProgram(parsed);
                if(problems.length)throw new Error(problems.join('; '));
                s.set({motionV4Mechanism:parsed as MechanismProgram});setMechanismDraft(null);setMechanismError('');
              }catch(e){setMechanismError(e instanceof Error?e.message:String(e));}
            }}>Apply mechanical program</button>
            <button className="nx-link" type="button" onClick={()=>{
              s.set({motionV4Mechanism:null});setMechanismDraft(null);setMechanismError('');
            }}>Disable demonstration</button>
          </div>
          <span className="nx-hint">{s.motionV4Mechanism ? `${s.motionV4Mechanism.mode} · ${s.motionV4Mechanism.joints.length} joint(s) · ${s.motionV4Mechanism.duration}s` : 'No demo configured — v4 assembly is unchanged.'} Gravity uses constrained reduced-coordinate dynamics, NOT free rigid-body collision physics. Continuous mechanism mesh clearance is reported as CLEAR, BLOCKED or UNVERIFIED, and unresolved contacts require review.</span>
          {mechanismError && <p className="error" role="alert">{mechanismError}</p>}
        </div>}
        {artifactPlanner && !hasArtifact && (
          <div className="nx-field" role="alert">
            <strong>This model has no assembly artifact.</strong>
            <span className="nx-hint">Plan the same model with the Python engine (`brickmotion-assembly plan --model model.mpd`), then open the resulting artifact file (.assembly.json) here — it attaches to the plan automatically. Every piece of the artifact must still be at its planned position.</span>
          </div>
        )}
        {v2 && <label className="nx-field">
          Workpiece support
          <select value={s.constructionSupport ?? 'fixture'} onChange={(e) => s.set({ constructionSupport: e.target.value as 'fixture' | 'table' })}>
            <option value="fixture">Allow held workpieces (virtual fixtures)</option>
            <option value="table">Require table contact or a connection</option>
          </select>
          <span className="nx-hint">Fixtures aren't drawn. Neither mode simulates gravity.</span>
        </label>}
        {v3 && <label className="nx-field">
          <span><input type="checkbox" checked={s.constructionStepModules === true}
            onChange={e => s.set({ constructionStepModules: e.target.checked })} /> Connected build-step modules (experimental)</span>
          <span className="nx-hint">Groups only LDCad-matched pieces in the same authored STEP. Every part must still assemble individually at a work area, and the complete module must pass strict motion checks. This can help trapped connections but may cost more search time on some models. Off by default.</span>
        </label>}
        {v2 && <label className="nx-field">
          Construction search budget
          <select aria-label="Construction search budget" value={s.constructionBudget ?? 'standard'}
            onChange={(e) => s.set({ constructionBudget: e.target.value as 'standard' | 'extended' | 'diagnostic' | 'v4' })}>
            <option value="standard">Standard — 20 s · 2,000 states · 100k candidates</option>
            <option value="extended">Extended — 60 s · 10,000 states · 500k candidates</option>
            <option value="diagnostic">Diagnostic — 120 s · 50,000 states · 1m candidates</option>
            {v4 && <option value="v4">V4 extended — 300 s · 100k states</option>}
          </select>
          <span className="nx-hint">Higher budgets use more CPU and memory. They do not bypass missing connector geometry or collision checks. In large models, the result may still be a contact error or timeout.</span>
        </label>}
        {motion && timeline?.motion && (
          <div className="nx-field" role="status">
            <strong>{timeline.motion.parts.toLocaleString()} part tracks · {timeline.motion.articulated} joint-guided motions</strong>
            {motionV4 && timeline.motion.v4 ? <>
              <span className="nx-hint">Mesh review: {timeline.motion.v4.mesh.certified} certified clear · {timeline.motion.v4.mesh.blocked} blocked · {timeline.motion.v4.mesh.unverified} unverified. {timeline.motion.v4.mesh.rerouted} re-routed flight(s).</span>
              <span className="nx-hint">Graph: {timeline.motion.v4.graph.edges} joints, {timeline.motion.v4.graph.rigidClusters} rigid groups, {timeline.motion.v4.graph.unknownBodies} bodies without matched connector metadata.</span>
              <span className="nx-hint">Limits: {timeline.motion.v4.limits.rules} user/verified rules · {timeline.motion.v4.limits.adjusted} approaches adjusted · {timeline.motion.v4.limits.rejected} candidate motions rejected. Unknown limits are NOT physical certifications.</span>
              {timeline.mechanismStage && <>
                <span className="nx-hint">Mechanical demo: {timeline.mechanismStage.mode} · {timeline.mechanismStage.tracks.length} driven/follower bodies · {timeline.mechanismStage.diagnostics.gearPairs} gear pairs · {timeline.mechanismStage.diagnostics.loopClosures} link closures · {timeline.mechanismStage.frames} playback frames. Continuous triangle-surface clearance: <strong>{timeline.mechanismStage.collisionStatus.toUpperCase()}</strong>.</span>
                {timeline.mechanismStage.diagnostics.continuousCollision && <>
                  <span className="nx-hint">Moving mesh pairs: {timeline.mechanismStage.diagnostics.continuousCollision.clearPairs} continuously clear · {timeline.mechanismStage.diagnostics.continuousCollision.blockedPairs} blocked · {timeline.mechanismStage.diagnostics.continuousCollision.unverifiedPairs} unverified; {timeline.mechanismStage.diagnostics.continuousCollision.triangleNodeTests} conservative triangle-BVH tests.</span>
                  {timeline.mechanismStage.diagnostics.continuousCollision.issues.length>0 && <details><summary>Review mechanism collisions</summary>
                    {timeline.mechanismStage.diagnostics.continuousCollision.issues.slice(0,16).map((issue,i)=><p key={i} className="nx-hint"><strong>{issue.status.toUpperCase()}</strong> at {issue.time.toFixed(3)} s · {issue.a} / {issue.b}: {issue.reason}</p>)}
                  </details>}
                </>}
              </>}
            </> : <>
              {timeline.motion.kinematics && <span className="nx-hint">Kinematics: {timeline.motion.kinematics.pivotArcs} exact-pivot swings · {timeline.motion.kinematics.axialInsertions} axis-locked insertions · {timeline.motion.kinematics.overconstrained} conflicting joint hints.</span>}
              {timeline.motion.logical && <span className="nx-hint">Connection-aware ordering: {timeline.motion.logical.chains} group(s), {timeline.motion.logical.strategy}. Original project order was not changed.</span>}
              <span className="nx-hint">{timeline.motion.obstructed ?? 0} possible sampled AABB conflicts across {timeline.motion.checked ?? 0} assessed flights. These are advisory, not physically certified.</span>
            </>}
            {timeline.motion.fallback && <details><summary>Standard assembly issue (editable fallback used)</summary><p className="nx-hint">{timeline.motion.fallback}</p></details>}
          </div>
        )}
        {timeline?.construction && (
          <div className="nx-field">
            <strong>{artifactPlanner
              ? `${timeline.construction.operations.length} certified placements · ${(timeline.construction.stats.milliseconds / 1000).toFixed(1)} s planning`
              : `${timeline.construction.operations.length} operations · ${timeline.construction.stats.states} search states`}</strong>
            <span className="nx-hint">{artifactPlanner
              ? "Pre-planned by the Python engine: swept-corridor certified insertions, matched piece-by-piece to this exact model"
              : v4 ? "V4 global-scene routing with continuous-mesh, arc and annulus certification" : v3 ? "V3 guided near/far routing with continuous-mesh certification" : "V2 exhaustive routing with continuous-mesh certification"}</span>
            {v3 && <details>
              <summary>Search performance</summary>
              <p className="nx-hint">{timeline.construction.stats.candidates.toLocaleString()} candidates · {(timeline.construction.stats.cachedNearRayRejects ?? 0).toLocaleString()} witnessed blocked rays reused · {timeline.construction.stats.backtracks.toLocaleString()} backtracks</p>
              <p className="nx-hint">{(timeline.construction.stats.avoidedNearDepthChecks ?? 0).toLocaleString()} redundant withdrawal depths avoided · {(timeline.construction.stats.directSkySuccesses ?? 0).toLocaleString()} direct overhead routes</p>
              <p className="nx-hint">{(timeline.construction.stats.configurationDetourSuccesses ?? 0).toLocaleString()} certified multi-turn detours / {(timeline.construction.stats.configurationDetourAttempts ?? 0).toLocaleString()} attempts · {(timeline.construction.stats.authoredStepModules ?? 0).toLocaleString()} connected STEP modules</p>
              <p className="nx-hint">{(timeline.construction.stats.engagedDetourAttempts ?? 0).toLocaleString()} assembled-pose constrained departures tried · {(timeline.construction.stats.engagedDetourSuccesses ?? 0).toLocaleString()} accepted after full collision checks. Mechanical articulation is not simulated.</p>
              <p className="nx-hint">{(timeline.construction.stats.mechanicalJointHints ?? 0).toLocaleString()} metadata joint hints ({(timeline.construction.stats.articulatedJointHints ?? 0).toLocaleString()} potentially articulated). These are not proof of a valid motion.</p>
            </details>}
            <details><summary>Limits and assumptions</summary>{timeline.construction.warnings.map((w, i) => <p key={i} className="nx-hint">{w}</p>)}</details>
            <button type="button" className="nx-btn nx-sm" onClick={() => {
              const blob = new Blob([JSON.stringify(timeline.construction, null, 2)], { type: 'application/json' });
              const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = artifactPlanner ? 'assembly-artifact-plan.json' : v4 ? 'construction-plan-v4.json' : v3 ? 'construction-plan-v3.json' : 'construction-plan-v2.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}>Download construction plan</button>
          </div>
        )}
      </details>

      </>}
      {!manual && timeline?.fallback && (
        <div className="nx-field" role="alert" style={{ border: '1px solid var(--border, #a86b35)', borderRadius: 6, padding: 10 }}>
          <strong>Uncertified animation preview</strong>
          <p className="nx-hint">{timeline.fallback.planner === 'construction-v3' ? 'Construction V3' : 'Construction V2'} could not certify this model ({timeline.fallback.phase ?? 'planner'}: {timeline.fallback.code}). Standard produced a visual animation; collisions and attachment paths are <strong>not verified</strong>. Inspect the motion before exporting.</p>
          {timeline.fallback.peakRemovals != null && timeline.fallback.peakScopeUnits != null && <p className="nx-hint">Deepest verified disassembly: {timeline.fallback.peakRemovals}/{timeline.fallback.peakScopeUnits} units · {timeline.fallback.searchCandidates?.toLocaleString() ?? '—'} candidates · {timeline.fallback.searchBacktracks?.toLocaleString() ?? '—'} backtracks.</p>}
          <details><summary>Why {timeline.fallback.planner === 'construction-v3' ? 'V3' : 'V2'} stopped</summary><p className="nx-hint">{timeline.fallback.message}</p>{timeline.fallback.contacts?.map((c, i) => <p className="nx-hint" key={i}>{c.moving} / {c.obstacle} · {c.stage}</p>)}</details>
        </div>
      )}
      <div className="bm-video-export">
        <div className="nx-grid2">
          <label className="nx-field">
            Format
            <select aria-label="Video format" value={s.format} onChange={(e) => s.set({ format: e.target.value as VideoFormat })}>
              {(Object.keys(VIDEO_FORMATS) as VideoFormat[]).map((f) => (
                <option key={f} value={f}>{VIDEO_FORMATS[f].label}</option>
              ))}
            </select>
          </label>
          <label className="nx-field">
            Frame rate
            <select aria-label="Export frame rate" value={s.fps} onChange={(e) => s.set({ fps: Number(e.target.value) as ExportFps })}>
              {FPS_OPTIONS.map((fps) => (
                <option key={fps} value={fps}>{fps} fps{fps === 30 ? ' (standard)' : fps === 60 ? ' (smooth)' : fps === 120 ? ' (high)' : ''}</option>
              ))}
            </select>
          </label>
        </div>
        {previewNeedsConsent && <label className="nx-field" role="alert">
          <span><input type="checkbox" checked={acceptUncertified} onChange={(e) => setAcceptUncertified(e.target.checked)} /> {v4NeedsReview
            ? `I have reviewed the ${timeline?.motion?.v4?.mesh.blocked ?? 0} blocked and ${timeline?.motion?.v4?.mesh.unverified ?? 0} unverified v4 assembly route(s)${timeline!.mechanismStage?.collisionStatus !== 'clear' && timeline!.mechanismStage ? ', plus the blocked/unverified post-build mechanical demo' : ''}, and understand that exporting may show pieces passing through others.`
            : 'I understand the adaptive animation has not been collision-certified.'}</span>
        </label>}
        <button className="nx-btn nx-primary" disabled={(!manual && (!timeline || timeline.units.length === 0)) || (previewNeedsConsent && !acceptUncertified)} onClick={onExport}>
          <Ic name="download" /> Export {manual ? 'Timeline' : 'Build'} · {editingModel ? `“${editingModel}”` : 'main model'} MP4
        </button>
        <p className="nx-fine">Renders in your browser with the selected video resolution, frame rate and logo. Export submodels from the Models panel.</p>
      </div>
    </div>
  );
}
