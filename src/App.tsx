import { useEffect, useState } from 'react';
import { animOptions, useAppSettings } from './state/appSettings';
import { initPartService } from './state/partService';
import { initPersistence } from './state/persistence';
import { useStudio } from './state/store';
import { useModel } from './state/useModel';
import { useTimeline } from './state/useTimeline';
import { usePlayback } from './state/playback';
import { AboutDialog } from './ui/AboutDialog';
import { AiPanel } from './ui/AiPanel';
import { BuildTimeline } from './ui/BuildTimeline';
import { ChecksPanel } from './ui/ChecksPanel';
import { ExportDialog, type ExportJob } from './ui/ExportDialog';
import { Ic, type IconName } from './ui/icons';
import { Inspector } from './ui/Inspector';
import { ModelsPanel } from './ui/ModelsPanel';
import { StepCallout } from './ui/StepCallout';
import { PartsPanel } from './ui/PartsPanel';
import { PreviewPlayer } from './ui/PreviewPlayer';
import { ProjectsDialog } from './ui/ProjectsDialog';
import { SettingsPanel } from './ui/SettingsPanel';
import { StepsPanel } from './ui/StepsPanel';
import { Toolbar } from './ui/Toolbar';
import { VideoPanel } from './ui/VideoPanel';
import { Viewport } from './ui/Viewport';
import { viewportApi } from './ui/viewportApi';
import './ui/studio.css';
import './ui/app.css';

type Tab = 'models' | 'parts' | 'steps' | 'checks' | 'ai' | 'video' | 'settings';
const TABS: [Tab, IconName, string][] = [
  ['models', 'box', 'Models'],
  ['parts', 'parts', 'Parts'],
  ['steps', 'steps', 'Steps'],
  ['checks', 'checks', 'Checks'],
  ['ai', 'ai', 'AI'],
  ['video', 'video', 'Video'],
  ['settings', 'settings', 'Settings'],
];

const load = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: not remembered */
  }
};

function Studio() {
  const model = useModel();
  const mode = useStudio((s) => s.mode);
  const gizmoEnabled = useStudio((s) => s.gizmoEnabled);
  const gizmoMode = useStudio((s) => s.gizmoMode);
  const editingModel = useStudio((s) => s.editingModel);
  const setMode = useStudio((s) => s.setMode);
  const video = useAppSettings();
  const [tab, setTab] = useState<Tab>(() => (load('bm-tab') as Tab) ?? 'parts');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (load('bm-theme') === 'dark' ? 'dark' : 'light'));
  const [tlHeight, setTlHeight] = useState(() => Number(load('bm-tl-h')) || 236);
  const [dialog, setDialog] = useState<'projects' | 'about' | null>(null);
  const [exportJobs, setExportJobs] = useState<ExportJob[] | null>(null);

  useEffect(() => store('bm-tab', tab), [tab]);
  useEffect(() => store('bm-theme', theme), [theme]);

  // The timeline follows the model on screen: open a submodel and its own build
  // animation plays, scrubs and exports on its own. '' is the whole set.
  // useTimeline compares the serialized options. Recompute this small object so
  // a new planner/support setting can never be omitted from a memo dependency list.
  const opts = animOptions(video);
  const { timeline, planning, error: planError, progress, retry } = useTimeline(model.ready && model.view.instances.length > 0, model.plan, editingModel, opts);
  // a different model has a different timeline: start it from the beginning
  useEffect(() => usePlayback.getState().set({ t: 0, playing: false, stopAt: null, loopFrom: null }), [editingModel]);
  const exportCurrent = () => setExportJobs([{ model: editingModel, label: editingModel || 'Main model' }]);
  const canPreview = model.ready && model.view.instances.length > 0 && timeline !== null && !planning && !planError;
  useEffect(() => {
    if (planning || planError || model.error) usePlayback.getState().set({ playing: false });
  }, [planning, planError, model.error]);

  const resize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const oldSelection = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const y0 = e.clientY;
    const h0 = tlHeight;
    const move = (ev: PointerEvent) => {
      ev.preventDefault();
      setTlHeight(Math.max(140, Math.min(window.innerHeight * 0.6, h0 + y0 - ev.clientY)));
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', finish);
      document.body.style.userSelect = oldSelection;
    };
    const up = () => {
      finish();
      setTlHeight((h) => (store('bm-tl-h', String(Math.round(h))), h));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', finish);
  };

  return (
    <div className="studio" data-theme={theme}>
      <div className="nx" style={{ '--tl-h': `${tlHeight}px` } as React.CSSProperties}>
        <Toolbar
          theme={theme}
          onTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          onProjects={() => setDialog('projects')}
          onAbout={() => setDialog('about')}
          onExportVideo={exportCurrent}
          canPreview={canPreview}
        />
        <div className="nx-work">
          <nav className="nx-rail" aria-label="Panels">
            {TABS.map(([id, icon, label]) => (
              <button key={id} className={`nx-tab ${tab === id ? 'active' : ''}`} aria-pressed={tab === id} onClick={() => setTab(id)}>
                <Ic name={icon} />
                {label}
                {id === 'checks' && model.warnings.length > 0 && <span className="bm-rail-badge">{model.warnings.length}</span>}
              </button>
            ))}
          </nav>
          <section className="nx-panel">
            {tab === 'models' && <ModelsPanel model={model} onExport={setExportJobs} />}
            {tab === 'parts' && <PartsPanel />}
            {tab === 'steps' && <StepsPanel timeline={timeline} />}
            {tab === 'checks' && <ChecksPanel warnings={model.warnings} />}
            {tab === 'ai' && <AiPanel warnings={model.warnings} onOpenSettings={() => setTab('settings')} />}
            {tab === 'video' && <VideoPanel timeline={timeline} onExport={exportCurrent} />}
            {tab === 'settings' && <SettingsPanel onAbout={() => setDialog('about')} />}
          </section>
          <section className="nx-viewer">
            <div className="nx-viewer-bar">
              <div className="nx-row">
                {mode === 'preview' ? (
                  <span className="nx-chip">
                    Preview · {editingModel || 'Main model'} · {video.format}
                  </span>
                ) : editingModel ? (
                  <span className="bm-crumb">
                    <button className="nx-link" onClick={() => useStudio.getState().setEditingModel('')}>
                      Main model
                    </button>
                    <Ic name="right" />
                    <strong>{editingModel}</strong>
                  </span>
                ) : (
                  <span className="bm-crumb"><strong>Main model</strong></span>
                )}
              </div>
              <div className="nx-row">
                <div className="nx-seg" role="radiogroup" aria-label="View">
                  <button role="radio" aria-checked={mode === 'edit'} className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>
                    Build
                  </button>
                  <button
                    role="radio"
                    aria-checked={mode === 'preview'}
                    className={mode === 'preview' ? 'on' : ''}
                    disabled={!canPreview}
                    onClick={() => setMode('preview')}
                  >
                    Preview
                  </button>
                </div>
                {mode === 'edit' && (
                  <div className="bm-gizmo-bar" aria-label="Transform gizmo controls">
                    <button className={`nx-btn nx-sm bm-gizmo-toggle ${gizmoEnabled ? 'on' : ''}`}
                      aria-pressed={gizmoEnabled} aria-label="Enable transform gizmo" title="Show or hide the Blender-style transform gizmo (G)"
                      onClick={() => useStudio.getState().setGizmo(!gizmoEnabled)}>
                      <Ic name="move" /> Gizmo {gizmoEnabled ? 'On' : 'Off'}
                    </button>
                    {gizmoEnabled && (
                      <div className="nx-seg bm-gizmo-modes" role="radiogroup" aria-label="Gizmo operation">
                        {([
                          ['translate', 'move', 'Move selected bricks (studs / plates)'],
                          ['rotate', 'rotate', 'Rotate selection (15° steps, Shift: free)'],
                          ['scale', 'scale', 'Scale selection (changes brick dimensions)'],
                        ] as const).map(([id, icon, label]) => (
                          <button key={id} role="radio" aria-label={label} title={label}
                            aria-checked={gizmoMode === id} className={gizmoMode === id ? 'on' : ''}
                            onClick={() => useStudio.getState().setGizmoMode(id)}>
                            <Ic name={icon} />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <button
                  className="nx-icon"
                  title="Fit the model in view (F)"
                  aria-label="Fit view"
                  disabled={mode !== 'edit'}
                  onClick={() => viewportApi.fit()}
                >
                  <Ic name="fit" />
                </button>
              </div>
            </div>
            <div className="nx-stage bm-stage">
              <Viewport model={model} timeline={timeline} />
              {mode === 'preview' && timeline && <PreviewPlayer model={model} timeline={timeline} />}
              {mode === 'preview' && !timeline && <div className="overlay-note">{planError ? `Couldn't plan the animation: ${planError}` : 'Planning the build animation…'}</div>}
            </div>
          </section>
          <Inspector timeline={timeline} checks={model.warnings.length} stepCard={mode === 'edit' ? <StepCallout model={model} timeline={timeline} /> : null} />
        </div>
        <div className="nx-resizer" onPointerDown={resize} title="Drag to resize the timeline" />
        <BuildTimeline timeline={timeline} planning={planning} error={model.error || planError}
          progress={progress} loading={!model.ready && !model.error} onRetry={model.error ? undefined : retry} />
      </div>
      {dialog === 'projects' && <ProjectsDialog onClose={() => setDialog(null)} />}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      {exportJobs && exportJobs.length > 0 && <ExportDialog plan={model.plan} jobs={exportJobs} onClose={() => setExportJobs(null)} />}
    </div>
  );
}

export function App() {
  const [state, setState] = useState<'loading' | 'ready' | string>('loading');
  useEffect(() => {
    initPartService()
      .then(() => initPersistence())
      .then(() => setState('ready'))
      .catch((e: Error) => setState(e.message));
  }, []);
  if (state === 'ready') return <Studio />;
  return (
    <div className="studio bm-splash" data-theme={load('bm-theme') === 'dark' ? 'dark' : 'light'}>
      <div className="nx-brand">
        <span className="nx-brand-mark">
          <Ic name="brick" />
        </span>
        <span>BrickMotion Studio</span>
      </div>
      {state === 'loading' ? <p className="nx-hint">Loading the parts library…</p> : <p className="error">{state}</p>}
    </div>
  );
}
