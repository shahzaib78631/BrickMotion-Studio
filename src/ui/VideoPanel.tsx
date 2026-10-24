import { useEffect, useState } from 'react';
import type { Timeline } from '../anim/timeline';
import type { LogoCorner } from '../export/exportVideo';
import { FPS_OPTIONS, type ExportFps } from '../export/frameRates';
import { VIDEO_FORMATS, type VideoFormat } from '../export/formats';
import { useStudio } from '../state/store';
import { resetFloorShifts } from '../plan/pieceActions';
import { useAppSettings } from '../state/appSettings';
import { Ic } from './icons';
import { DEFAULT_CAMERA_SETTINGS } from '../anim/camera';

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
  useEffect(() => {
    if (!s.logo) return setLogoUrl(null);
    const u = URL.createObjectURL(s.logo);
    setLogoUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [s.logo]);
  const longer = timeline && timeline.duration > s.targetSeconds + 0.05;
  const editingModel = useStudio((st) => st.editingModel);
  /** pieces dragged to another waiting spot */
  const moved = useStudio((st) => [...st.plan.steps, ...Object.values(st.plan.submodels ?? {}).flatMap((m) => m.steps)].reduce((n, step) => n + step.pieces.filter((i) => i.assembly?.floorShift).length, 0));
  const fmt = VIDEO_FORMATS[s.format];
  const setCamera = (key: keyof typeof s.camera, value: number) => s.set({ camera: { ...s.camera, [key]: value } });

  return (
    <div className="nx-pane">
      <div className="nx-pane-head">
        <h3>
          <Ic name="video" /> Video
        </h3>
        <span className="nx-chip">{s.format} · {fmt.width}×{fmt.height} · {s.fps} fps</span>
      </div>

      <label className="nx-field">
        Assembly planner
        <select aria-label="Assembly planner" value={s.planner ?? 'legacy'} onChange={(e) => s.set({ planner: e.target.value as 'legacy' | 'construction-v2' })}>
          <option value="legacy">Existing planner</option>
          <option value="construction-v2">Construction V2 (experimental)</option>
        </select>
        <span className="nx-hint">V2 searches backward, builds subassemblies on separate work areas, and plays checked paths sequentially. It assumes held workpieces where marked. Articulation and deformation are not implemented; unresolved models stop without falling back.</span>
      </label>
      {s.planner === 'construction-v2' && <label className="nx-field">
        Workpiece support
        <select value={s.constructionSupport ?? 'fixture'} onChange={(e) => s.set({ constructionSupport: e.target.value as 'fixture' | 'table' })}>
          <option value="fixture">Allow held workpieces (virtual fixtures)</option>
          <option value="table">Require table contact or an existing connection</option>
        </select>
        <span className="nx-hint">Virtual fixtures are not rendered. Neither mode simulates gravity or proves physical stability.</span>
      </label>}
      {timeline?.construction && (
        <div className="nx-field">
          <strong>Construction V2: {timeline.construction.operations.length} operations</strong>
          <span className="nx-hint">{timeline.construction.stats.states} search states. Contact and fixture assumptions are included in the plan report.</span>
          <details><summary>Validation limits and assumptions</summary>{timeline.construction.warnings.map((w, i) => <p key={i} className="nx-hint">{w}</p>)}</details>
          <button type="button" className="nx-btn nx-sm" onClick={() => {
            const blob = new Blob([JSON.stringify(timeline.construction, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'construction-plan-v2.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}>Download construction plan</button>
        </div>
      )}

      <label className="nx-field">
        Length <b>{formatLength(s.targetSeconds)}</b>
        <input type="range" min={5} max={600} step={5} value={s.targetSeconds} onChange={(e) => s.set({ targetSeconds: Number(e.target.value) })} />
      </label>
      <div className="nx-field">
        <button className="nx-btn nx-sm" type="button" onClick={() => s.set({
          targetSeconds: 14, introSeconds: 0.6, buildSeconds: 10.4,
          outroSeconds: 3, heroOrbit: true,
        })}>
          Match reference pacing (14 s)
        </button>
        <span className="nx-hint">The reference videos are about 14 seconds long. This preset increases the pace while preserving collision-safe movement. The build may run longer if parts cannot move safely in parallel.</span>
      </div>
      {timeline && (
        <p className="nx-fine">
          This set comes out at <strong>{timeline.duration.toFixed(1)} s</strong>
          {longer ? ': step pauses and submodels that build one after another add time.' : '.'}
        </p>
      )}
      <div className="nx-field" aria-label="Timeline clip durations">
        <div className="bm-timing-actions">
          <strong>Timeline timing</strong>
          <button className="nx-link" onClick={() => s.set({ introSeconds: null, buildSeconds: null, outroSeconds: null })}>Reset to auto</button>
        </div>
        <div className="bm-duration-fields">
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
        <span className="nx-hint">Drag a camera clip's edge in the timeline, or enter exact seconds here. Empty fields follow Auto length. Extending a step clip adjusts its hold. A collision-safe build can exceed the requested time.</span>
      </div>

      <div className="nx-field">
        <div className="nx-sub">Studio appearance</div>
        <label className="nx-field">
          Environment &amp; lighting
          <select aria-label="Studio appearance" value={s.studioLook} onChange={(e) => s.set({ studioLook: e.target.value as typeof s.studioLook })}>
            <option value="soft">Reference soft studio (grey, contact shadows)</option>
            <option value="classic">Original bright studio (white)</option>
          </select>
        </label>
        <label className="nx-field">
          Camera direction &amp; framing
          <select aria-label="Camera framing" value={s.cameraFraming} onChange={(e) => s.set({ cameraFraming: e.target.value as typeof s.cameraFraming })}>
            <option value="cinematic">Cinematic — closer, more overhead assembly</option>
            <option value="wide">Wide — original camera coverage</option>
          </select>
        </label>
        <details className="bm-camera-settings" open>
          <summary>Camera settings</summary>
          <div className="bm-camera-actions">
            <button type="button" className="nx-btn nx-sm" onClick={() => s.set({ camera: { ...DEFAULT_CAMERA_SETTINGS } })}>Reference preset</button>
            <button type="button" className="nx-btn nx-sm" onClick={() => s.set({ camera: { ...s.camera, lensMm: 42, buildElevation: 54, buildMargin: 1.08, targetLock: 0.72, submodelFocus: 1 } })}>Closer</button>
            <button type="button" className="nx-btn nx-sm" onClick={() => s.set({ camera: { ...s.camera, lensMm: 60, buildElevation: 64, buildMargin: 1.18, targetLock: 0.94, submodelFocus: 0.6 } })}>Stable overhead</button>
          </div>
          <div className="bm-camera-grid">
            <label className="nx-field">Lens (mm)<input type="number" min={18} max={200} step={1} value={s.camera.lensMm} onChange={(e) => setCamera('lensMm', Number(e.target.value))} /></label>
            <label className="nx-field">Sensor width (mm)<input type="number" min={12} max={70} step={1} value={s.camera.sensorWidthMm} onChange={(e) => setCamera('sensorWidthMm', Number(e.target.value))} /></label>
            <label className="nx-field">Azimuth (°)<input type="number" min={-180} max={180} step={1} value={s.camera.buildAzimuth} onChange={(e) => setCamera('buildAzimuth', Number(e.target.value))} /></label>
            <label className="nx-field">Elevation (°)<input type="number" min={15} max={89} step={1} value={s.camera.buildElevation} onChange={(e) => setCamera('buildElevation', Number(e.target.value))} /></label>
            <label className="nx-field">Frame margin<input type="number" min={1} max={2} step={0.01} value={s.camera.buildMargin} onChange={(e) => setCamera('buildMargin', Number(e.target.value))} /></label>
            <label className="nx-field">Build drift (°)<input type="number" min={-45} max={45} step={1} value={s.camera.buildDrift} onChange={(e) => setCamera('buildDrift', Number(e.target.value))} /></label>
          </div>
          <label className="nx-field">Target lock <b>{Math.round(s.camera.targetLock * 100)}%</b><input type="range" min={0} max={1} step={0.01} value={s.camera.targetLock} onChange={(e) => setCamera('targetLock', Number(e.target.value))} /></label>
          <span className="nx-hint">Higher target lock keeps the shot centred on the finished (sub)model instead of chasing incoming pieces. The reference preset intentionally keeps this high.</span>
          <label className="nx-field">Camera damping <b>{Math.round(s.camera.damping * 100)}%</b><input type="range" min={0} max={1} step={0.01} value={s.camera.damping} onChange={(e) => setCamera('damping', Number(e.target.value))} /></label>
          <span className="nx-hint">Higher damping removes small zoom/pan corrections between placements, producing the calm tripod-like movement in the references.</span>
          <label className="nx-field">Submodel focus <b>{Math.round(s.camera.submodelFocus * 100)}%</b><input type="range" min={0} max={1} step={0.01} value={s.camera.submodelFocus} onChange={(e) => setCamera('submodelFocus', Number(e.target.value))} /></label>
          <span className="nx-hint">The camera frames the model or submodel being assembled, not the pieces waiting on the floor. At 100% a submodel fills the shot; lower values keep the main model in view too.</span>
          <div className="bm-camera-grid">
            <label className="nx-field">Hero orbit (°)<input type="number" min={-360} max={360} step={5} value={s.camera.heroOrbitDegrees} onChange={(e) => setCamera('heroOrbitDegrees', Number(e.target.value))} /></label>
            <label className="nx-field">Hero elevation (°)<input type="number" min={5} max={85} step={1} value={s.camera.heroElevation} onChange={(e) => setCamera('heroElevation', Number(e.target.value))} /></label>
            <label className="nx-field">Hero margin<input type="number" min={1} max={2} step={0.01} value={s.camera.heroMargin} onChange={(e) => setCamera('heroMargin', Number(e.target.value))} /></label>
          </div>
          <span className="nx-hint">Like Blender: lens changes perspective/compression, sensor width changes field of view, azimuth/elevation set the rig angle, and framing values control how tightly the subject fills the shot.</span>
        </details>
        <label className="nx-check">
          <input type="checkbox" checked={s.edgeLines} onChange={(e) => s.set({ edgeLines: e.target.checked })} /> Edge lines — faint brick outlines
        </label>
        <label className="nx-check">
          <input type="checkbox" checked={s.linearColors} onChange={(e) => s.set({ linearColors: e.target.checked })} /> True LEGO colours — linear tone mapping instead of filmic
        </label>
        <div className="nx-grid2">
          <label className="nx-field">
            Waiting pieces
            <select aria-label="Group waiting pieces" disabled={s.planner === 'construction-v2'} value={s.floorSort} onChange={(e) => s.set({ floorSort: e.target.value as typeof s.floorSort })}>
              <option value="step">By step</option>
              <option value="colour">By colour</option>
              <option value="part">By part</option>
              <option value="size">By size</option>
            </select>
          </label>
          <label className="nx-field">
            Wait
            <select aria-label="Where waiting pieces lie" disabled={s.planner === 'construction-v2'} value={s.floorSides} onChange={(e) => s.set({ floorSides: e.target.value as typeof s.floorSides })}>
              <option value="front-back">In front and behind</option>
              <option value="front">In front</option>
              <option value="behind">Behind</option>
              <option value="sides">Left and right</option>
            </select>
          </label>
        </div>
        <span className="nx-hint">How the pieces lie on the floor before they fly in. To move one piece, drag it while it waits on the floor in the build view.</span>
        {moved > 0 && (
          <button className="nx-btn" onClick={() => useStudio.getState().apply(resetFloorShifts)}>
            <Ic name="undo" /> Put {moved} moved piece{moved === 1 ? '' : 's'} back
          </button>
        )}
        <label className="nx-check">
          <input type="checkbox" disabled={s.planner === 'construction-v2'} checked={s.bottomUp} onChange={(e) => s.set({ bottomUp: e.target.checked })} /> Build bottom-up — within a step, each piece waits for what it rests on
        </label>
        <label className="nx-check">
          <input type="checkbox" checked={s.snapSound} onChange={(e) => s.set({ snapSound: e.target.checked })} /> Snap sound — a click each time pieces connect
        </label>
        <span className="nx-hint">These choices apply to both the live preview and exported MP4. Use Wide if a large submodel leaves the frame.</span>
      </div>

      <label className="nx-field">
        Format
        <select aria-label="Video format" value={s.format} onChange={(e) => s.set({ format: e.target.value as VideoFormat })}>
          {(Object.keys(VIDEO_FORMATS) as VideoFormat[]).map((f) => (
            <option key={f} value={f}>
              {VIDEO_FORMATS[f].label}
            </option>
          ))}
        </select>
        <span className="nx-hint">The preview frame and the camera framing follow this shape.</span>
      </label>

      <label className="nx-field">
        Export frame rate
        <select aria-label="Export frame rate" value={s.fps} onChange={(e) => s.set({ fps: Number(e.target.value) as ExportFps })}>
          {FPS_OPTIONS.map((fps) => (
            <option key={fps} value={fps}>
              {fps} fps{fps === 30 ? ' (standard)' : fps === 60 ? ' (smooth)' : fps === 120 ? ' (high FPS)' : ''}
            </option>
          ))}
        </select>
        <span className="nx-hint">Higher FPS makes movement smoother but takes longer to render and creates larger MP4s.</span>
      </label>

      <div className="nx-field">
        Pieces arrive
        <div className="nx-seg" role="radiogroup" aria-label="Pieces arrive">
          {MODES.map(([v, l]) => (
            <button key={v} role="radio" disabled={s.planner === 'construction-v2'} aria-checked={s.mode === v} className={s.mode === v ? 'on' : ''} onClick={() => s.set({ mode: v })}>
              {l}
            </button>
          ))}
        </div>
        {s.planner === 'construction-v2' && <span className="nx-hint">V2 schedules verified construction operations sequentially; attachment dependencies cannot be disabled.</span>}
        {s.mode === 'piece' && (
          <span className="nx-hint">
            Each piece lands before the next one starts, so a big set makes a long video{timeline ? ` (${formatLength(timeline.duration)} here)` : ''}. Use Batches or Auto for a shorter one.
          </span>
        )}
        {s.mode === 'auto' && timeline && (
          <span className="nx-hint">
            Picked: {timeline.pacing.mode === 'piece' ? 'one by one' : timeline.pacing.mode === 'step' ? 'step by step' : 'in batches'}
          </span>
        )}
      </div>

      <label className="nx-check">
        <input type="checkbox" checked={s.heroOrbit} onChange={(e) => s.set({ heroOrbit: e.target.checked })} /> End with a hero orbit
      </label>

      <div className="nx-sub">Logo</div>
      <div className="bm-logo-row">
        {logoUrl ? <img src={logoUrl} alt="Logo preview" className="logo-preview" /> : <div className="logo-preview nx-hint">No logo</div>}
        <div className="nx-grow" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="nx-btn nx-sm bm-file-btn">
            <Ic name="upload" /> {s.logo ? 'Replace logo' : 'Choose logo'}
            <input
              type="file"
              hidden
              accept="image/png,image/svg+xml,image/jpeg,image/webp"
              aria-label="Logo file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setError('');
                try {
                  const logoBitmap = await createImageBitmap(f);
                  s.set({ logo: f, logoBitmap, logoEnabled: true });
                } catch {
                  setError("That image couldn't be read. Try a PNG.");
                }
              }}
            />
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
        <input type="checkbox" checked={s.logoEnabled} disabled={!s.logoBitmap} onChange={(e) => s.set({ logoEnabled: e.target.checked })} /> Show the logo on
        the video
      </label>
      <label className="nx-field">
        Corner
        <select value={s.logoCorner} disabled={!s.logoBitmap} onChange={(e) => s.set({ logoCorner: e.target.value as LogoCorner })}>
          {CORNERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>

      <button className="nx-btn nx-primary" disabled={!timeline || timeline.units.length === 0} onClick={onExport}>
        <Ic name="download" /> Export {editingModel ? `“${editingModel}”` : 'main model'} as MP4
      </button>
      <p className="nx-fine">Rendered frame by frame in this browser (Chrome), so it can take a minute. To export submodels on their own (or all at once), use the Models panel.</p>
    </div>
  );
}
