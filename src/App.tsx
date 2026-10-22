import { useEffect, useMemo, useState } from 'react';
import { buildTimeline, type Timeline } from './anim/timeline';
import { useAppSettings } from './state/appSettings';
import { initPartService, metricsOf } from './state/partService';
import { initPersistence } from './state/persistence';
import { useStudio } from './state/store';
import { useModel } from './state/useModel';
import { AboutDialog } from './ui/AboutDialog';
import { AiPanel } from './ui/AiPanel';
import { BuildTimeline } from './ui/BuildTimeline';
import { ChecksPanel } from './ui/ChecksPanel';
import { ExportDialog } from './ui/ExportDialog';
import { Ic, type IconName } from './ui/icons';
import { Inspector } from './ui/Inspector';
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

type Tab = 'parts' | 'steps' | 'checks' | 'ai' | 'video' | 'settings';
const TABS: [Tab, IconName, string][] = [
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
  const editingModel = useStudio((s) => s.editingModel);
  const setMode = useStudio((s) => s.setMode);
  const video = useAppSettings();
  const [tab, setTab] = useState<Tab>(() => (load('bm-tab') as Tab) ?? 'parts');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (load('bm-theme') === 'dark' ? 'dark' : 'light'));
  const [tlHeight, setTlHeight] = useState(() => Number(load('bm-tl-h')) || 236);
  const [dialog, setDialog] = useState<'projects' | 'about' | 'export' | null>(null);

  useEffect(() => store('bm-tab', tab), [tab]);
  useEffect(() => store('bm-theme', theme), [theme]);

  const timeline: Timeline | null = useMemo(
    () =>
      model.ready
        ? buildTimeline(model.assembly, metricsOf, {
            targetSeconds: video.targetSeconds,
            heroOrbit: video.heroOrbit,
            mode: video.mode === 'auto' ? undefined : video.mode,
          })
        : null,
    [model.ready, model.assembly, video.targetSeconds, video.heroOrbit, video.mode],
  );
  const canPreview = model.ready && model.assembly.instances.length > 0;

  const resize = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = tlHeight;
    const move = (ev: PointerEvent) => setTlHeight(Math.max(140, Math.min(window.innerHeight * 0.6, h0 + y0 - ev.clientY)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setTlHeight((h) => (store('bm-tl-h', String(Math.round(h))), h));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="studio" data-theme={theme}>
      <div className="nx" style={{ '--tl-h': `${tlHeight}px` } as React.CSSProperties}>
        <Toolbar
          theme={theme}
          onTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          onProjects={() => setDialog('projects')}
          onAbout={() => setDialog('about')}
          onExportVideo={() => setDialog('export')}
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
            {tab === 'parts' && <PartsPanel />}
            {tab === 'steps' && <StepsPanel />}
            {tab === 'checks' && <ChecksPanel warnings={model.warnings} />}
            {tab === 'ai' && <AiPanel warnings={model.warnings} onOpenSettings={() => setTab('settings')} />}
            {tab === 'video' && <VideoPanel timeline={timeline} onExport={() => setDialog('export')} />}
            {tab === 'settings' && <SettingsPanel onAbout={() => setDialog('about')} />}
          </section>
          <section className="nx-viewer">
            <div className="nx-viewer-bar">
              <div className="nx-row">
                {mode === 'preview' ? (
                  <span className="nx-chip">Preview · 9:16</span>
                ) : editingModel ? (
                  <span className="bm-crumb">
                    <button className="nx-link" onClick={() => useStudio.getState().setEditingModel('')}>
                      Main model
                    </button>
                    <Ic name="right" />
                    <strong>{editingModel}</strong>
                  </span>
                ) : (
                  <span className="nx-chip">Build view</span>
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
              <Viewport model={model} />
              {mode === 'preview' && timeline && <PreviewPlayer model={model} timeline={timeline} />}
            </div>
          </section>
          <Inspector timeline={timeline} checks={model.warnings.length} />
        </div>
        <div className="nx-resizer" onPointerDown={resize} title="Drag to resize the timeline" />
        <BuildTimeline timeline={timeline} />
      </div>
      {dialog === 'projects' && <ProjectsDialog onClose={() => setDialog(null)} />}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      {dialog === 'export' && timeline && (
        <ExportDialog
          name={useStudio.getState().plan.name}
          timeline={timeline}
          instances={model.assembly.instances}
          logo={video.logoEnabled && video.logoBitmap ? { image: video.logoBitmap, corner: video.logoCorner } : null}
          onClose={() => setDialog(null)}
        />
      )}
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
