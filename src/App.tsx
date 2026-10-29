import { useEffect, useMemo, useState } from 'react';
import { animOptions, useAppSettings } from './state/appSettings';
import { spotWarnings } from './plan/assemblySpots';
import { AssemblyPanel } from './ui/AssemblyPanel';
import { initPartService } from './state/partService';
import { initPersistence } from './state/persistence';
import { useStudio } from './state/store';
import { sceneSetupOf } from './render/sceneSetup';
import { useModel } from './state/useModel';
import { useTimeline } from './state/useTimeline';
import { usePlayback } from './state/playback';
import { AboutDialog } from './ui/AboutDialog';
import { AiPanel } from './ui/AiPanel';
import { BuildTimeline } from './ui/BuildTimeline';
import { KeyframeTimeline } from './ui/KeyframeTimeline';
import { instancePlacements } from './ui/modelPlacement';
import { animationOf } from './anim/keyframes';
import { linkBuildLayer } from './anim/buildLayer';
import { fillMotionKeyframes, missingMotionKeyTargets } from './anim/motion/autoBake';
import { checkEditedMotion } from './anim/motionDiagnostics';
import { CapturePanel } from './ui/CapturePanel';
import { ChecksPanel } from './ui/ChecksPanel';
import { ExportDialog, type ExportJob } from './ui/ExportDialog';
import { Ic, type IconName } from './ui/icons';
import { Inspector } from './ui/Inspector';
import { ViewportChrome } from './ui/ViewportChrome';
import { NewSubmodelDialog } from './ui/NewSubmodelDialog';
import { createSubmodel } from './plan/createSubmodel';
import { ModelsPanel } from './ui/ModelsPanel';
import { StepCallout } from './ui/StepCallout';
import { PartsPanel } from './ui/PartsPanel';
import { PreviewPlayer } from './ui/PreviewPlayer';
import { ProjectsDialog } from './ui/ProjectsDialog';
import { TemplatesDialog } from './ui/TemplatesDialog';
import { themeAttrs, useTheme, useThemeAttrs } from './state/theme';
import { SettingsPanel } from './ui/SettingsPanel';
import { StepsPanel } from './ui/StepsPanel';
import { Toolbar } from './ui/Toolbar';
import { VideoPanel } from './ui/VideoPanel';
import { MaterialsPanel } from './ui/MaterialsPanel';
import { SoundPanel } from './ui/SoundPanel';
import { StagingPanel } from './ui/StagingPanel';
import { Viewport } from './ui/Viewport';
import { ViewportBoundary } from './ui/ViewportBoundary';
import { viewportApi } from './ui/viewportApi';
import './ui/studio.css';
import './ui/app.css';
import './ui/keyframes.css';
import './ui/reference.css';
import './ui/themes.css';
import './ui/layout.css';

type Tab = 'models' | 'parts' | 'assembly' | 'steps' | 'checks' | 'ai' | 'video' | 'materials' | 'sound' | 'staging' | 'capture' | 'settings';
/** The rail, in groups: building the model, how the video looks, then assets; Settings sits at the bottom. */
const TAB_GROUPS: [Tab, IconName, string][][] = [
  [['models', 'box', 'Models'], ['parts', 'parts', 'Parts'], ['assembly', 'spot', 'Assembly'], ['steps', 'steps', 'Animation']],
  [['video', 'camera', 'Render'], ['materials', 'palette', 'Materials'], ['sound', 'sound', 'Sound'], ['staging', 'layout', 'Staging'], ['capture', 'video', 'Capture']],
  [['ai', 'folder', 'Assets']],
  [['settings', 'settings', 'Settings']],
];
/** the side panel can be dragged between these widths */
const PANEL_MIN = 240;
const PANEL_MAX = 560;

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
  const sceneCameraForVideo = useStudio((s) => s.plan.sceneSetup?.useCameraForVideo === true);
  const timelineEditor = useStudio((s) => s.timelineEditor);
  const editingModel = useStudio((s) => s.editingModel);
  const selection = useStudio((s) => s.selection);
  const currentStep = useStudio((s) => s.currentStep);
  const video = useAppSettings();
  const [tab, setTab] = useState<Tab>(() => (load('bm-tab') as Tab) ?? 'models');
  const themeAttrs = useThemeAttrs();
  const theme = themeAttrs['data-theme'];
  const [tlHeight, setTlHeight] = useState(() => Number(load('bm-tl-h')) || 176);
  // null: the width each screen size picks; a number once the panel edge was dragged
  const [panelW, setPanelW] = useState<number | null>(() => Number(load('bm-panel-w')) || null);
  const [panelClosed, setPanelClosed] = useState(() => load('bm-panel-closed') === '1');
  useEffect(() => store('bm-panel-closed', panelClosed ? '1' : '0'), [panelClosed]);
  /** a rail button opens its panel; the active one folds the panel away to give the viewport room */
  const pickTab = (id: Tab) => {
    if (id === tab && !panelClosed) return setPanelClosed(true);
    setTab(id);
    setPanelClosed(false);
  };
  const startPanelResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const panel = e.currentTarget.parentElement!;
    const left = panel.getBoundingClientRect().left;
    let w = panel.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      w = Math.max(PANEL_MIN, Math.min(PANEL_MAX, ev.clientX - left));
      setPanelW(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      store('bm-panel-w', String(Math.round(w)));
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const [newSubmodelOpen, setNewSubmodelOpen] = useState(false);
  const [dialog, setDialog] = useState<'projects' | 'templates' | 'about' | null>(null);
  const [exportJobs, setExportJobs] = useState<ExportJob[] | null>(null);
  const [motionKeyError, setMotionKeyError] = useState('');
  const [motionKeyStatus, setMotionKeyStatus] = useState('');

  useEffect(() => store('bm-tab', tab), [tab]);

  // The timeline follows the model on screen: open a submodel and its own build
  // animation plays, scrubs and exports on its own. '' is the whole set.
  // useTimeline compares the serialized options. Recompute this small object so
  // a new planner/support setting can never be omitted from a memo dependency list.
  const opts = animOptions(video, model.plan.sceneSetup);
  const { timeline, planning, error: planError, progress, retry } = useTimeline(model.ready && model.view.instances.length > 0, model.plan, editingModel, opts);
  // Standard Motion creates actual editable leaf keyframes the first time the
  // user opens Timeline. Never re-bake an existing track automatically: those
  // may contain the user's hand corrections, even after model re-planning.
  useEffect(() => {
    if (video.planner !== 'standard-motion' || timelineEditor !== 'timeline' ||
      !timeline || !model.ready || planning || planError) return;
    const missing = missingMotionKeyTargets(model.plan.animation, editingModel, model.view.instances);
    if (!missing.length) return;
    const timer = window.setTimeout(() => {
      try {
        const current = useStudio.getState();
        const freshMissing = missingMotionKeyTargets(current.plan.animation, editingModel, model.view.instances);
        if (!freshMissing.length) return;
        const result = fillMotionKeyframes(current.plan.animation, editingModel, model.view.instances,
          instancePlacements(current.plan, editingModel, model.assembly), timeline);
        if (!result.count) return;
        current.apply(p => ({ ...p, animation: result.animation }));
        setMotionKeyError('');
        setMotionKeyStatus(`${result.count.toLocaleString()} individual part tracks · ${result.keys.toLocaleString()} editable keyframes` +
          (result.warnings?.length ? ` · ${result.warnings.length} affine motions need review` : ''));
      } catch (error) {
        setMotionKeyError(`Could not generate every editable part track: ${error instanceof Error ? error.message : String(error)}. The generated Build remains available; use Bake all in Timeline or shorten the scene.`);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [video.planner, timelineEditor, timeline, planning, planError, model.ready,
      model.plan.animation, model.view.instances, model.assembly, editingModel]);

  // a different model has a different timeline: start it from the beginning
  useEffect(() => usePlayback.getState().set({ t: 0, playing: false, stopAt: null, loopFrom: null }), [editingModel]);
  const exportCurrent = () => {
    // The construction planner certifies its own generated paths, not arbitrary
    // hand-edited keyframes. Give authored Timeline videos an automatic sampled
    // preflight so a likely new collision isn't silently exported.
    if (timelineEditor === 'timeline' && model.plan.animation?.tracks.some((track) =>
      track.model === editingModel && Object.values(track.channels).some((keys) => keys?.length))) {
      try {
        const report = checkEditedMotion(model.view.instances,
          instancePlacements(model.plan, editingModel, model.assembly),
          model.plan.animation, editingModel, timeline, 120);
        if (report.warnings.length || !report.complete) {
          const message = report.warnings.length
            ? `Motion preflight found ${report.warnings.length} possible swept-bounds contact(s). First: frame ${report.warnings[0].frame}, ${report.warnings[0].first} / ${report.warnings[0].second}.`
            : `Motion preflight could not check every requested sample (${report.checkedFrames} examined).`;
          if (!window.confirm(`${message}\n\nThese broad-phase results are not collision certification. Inspect the Dope Sheet's Check motion diagnostics before exporting. Export anyway?`)) return;
        }
      } catch (error) {
        alert(`Motion preflight could not run: ${error instanceof Error ? error.message : String(error)}. Review the animation before exporting.`);
        return;
      }
    }
    setExportJobs([{ model: editingModel, label: editingModel || 'Main model' }]);
  };
  const canPreview = model.ready && model.view.instances.length > 0 && timeline !== null && !planning && !planError;
  const selectedIds = selection.model === editingModel ? selection.ids : [];
  const makeSubmodel = () => { if (selectedIds.length >= 2) setNewSubmodelOpen(true); };
  const onCreateSubmodel = (name: string): boolean => {
    const current = useStudio.getState();
    const result = createSubmodel(current.plan, current.editingModel, current.selection.ids, model.view.nodes, name);
    if (!result) return false;
    current.apply(() => result.plan);
    current.select([result.referenceId]);
    return true;
  };
  // Assembly-spot overlaps are found statically on the main thread and shown in Checks.
  const spotIssues = useMemo(() => spotWarnings(model.plan, model.assembly, timeline), [model.plan, model.assembly, timeline]);
  const warnings = useMemo(() => [...model.warnings, ...spotIssues], [model.warnings, spotIssues]);
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
    <div className="studio" {...themeAttrs}>
      <div className={`nx ${selectedIds.length ? 'has-sel' : ''}`} style={{ '--tl-h': `${tlHeight}px` } as React.CSSProperties}>
        <Toolbar
          theme={theme}
          onTheme={() => useTheme.getState().set({ mode: theme === 'dark' ? 'light' : 'dark' })}
          onProjects={() => setDialog('projects')}
          onTemplates={() => setDialog('templates')}
          onAbout={() => setDialog('about')}
          onExportVideo={exportCurrent}
          canPreview={canPreview}
          onNavigate={(panel) => { setTab(panel); setPanelClosed(false); }}
        />
        <div className={`nx-work ${panelClosed ? 'panel-closed' : ''}`}
          style={panelClosed ? { '--panel-w': '0px' } as React.CSSProperties : panelW ? { '--panel-w': `${panelW}px` } as React.CSSProperties : undefined}>
          <nav className="nx-rail" aria-label="Panels">
            {TAB_GROUPS.map((group, g) => (
              <div key={g} className={`bm-rail-group ${g === TAB_GROUPS.length - 1 ? 'end' : ''}`} role="group">
                {group.map(([id, icon, label]) => (
                  <button key={id} className={`nx-tab ${tab === id && !panelClosed ? 'active' : ''}`} aria-pressed={tab === id && !panelClosed}
                    title={tab === id && !panelClosed ? `${label} — click to hide the panel` : label} onClick={() => pickTab(id)}>
                    <Ic name={icon} />
                    <span className="bm-rail-label">{label}</span>
                    {id === 'checks' && warnings.length > 0 && <span className="bm-rail-badge">{warnings.length}</span>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <section className="nx-panel" aria-hidden={panelClosed || undefined}>
            <div className="bm-panel-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the side panel"
              title="Drag to resize · double-click to reset" onPointerDown={startPanelResize}
              onDoubleClick={() => { setPanelW(null); store('bm-panel-w', ''); }} />
            {tab === 'models' && <ModelsPanel model={model} onExport={setExportJobs} onMakeSubmodel={makeSubmodel} />}
            {tab === 'parts' && <PartsPanel />}
            {tab === 'assembly' && <AssemblyPanel model={model} timeline={timeline} />}
            {tab === 'steps' && <StepsPanel timeline={timeline} />}
            {tab === 'checks' && <ChecksPanel warnings={warnings} />}
            {tab === 'ai' && <AiPanel warnings={warnings} onOpenSettings={() => setTab('settings')} />}
            {tab === 'video' && <VideoPanel timeline={timeline} onExport={exportCurrent} />}
            {tab === 'materials' && <MaterialsPanel />}
            {tab === 'sound' && <SoundPanel />}
            {tab === 'staging' && <StagingPanel timeline={timeline} planning={planning} planError={planError} onRetry={retry} />}
            {tab === 'capture' && <CapturePanel model={model} />}
            {tab === 'settings' && <SettingsPanel onAbout={() => setDialog('about')} />}
          </section>
          <section className="nx-viewer">
            <div className="nx-viewer-bar">
              <div className="bm-crumb" aria-label="Current model">
                {editingModel ? <>
                  <button className="bm-crumb-parent" onClick={() => useStudio.getState().setEditingModel('')}>Main model</button>
                  <Ic name="right" />
                  <strong>{editingModel}</strong>
                </> : <><span>Main model</span><Ic name="right" /><strong>{mode === 'preview' ? 'Preview' : 'Workspace'}</strong></>}
              </div>
              <div className="bm-workspace-top-help">
                {warnings.length > 0 && <button title="View model warnings" onClick={() => { setTab('checks'); setPanelClosed(false); }}><Ic name="checks" /> {warnings.length} warnings</button>}
                {mode === 'preview' && <button
                  aria-pressed={sceneCameraForVideo}
                  title={sceneCameraForVideo
                    ? 'The video uses the saved scene camera — click to use the automatic video camera'
                    : 'The video uses the automatic camera — click to use the saved scene camera'}
                  onClick={() => useStudio.getState().apply((p) => ({
                    ...p,
                    sceneSetup: { ...sceneSetupOf(p.sceneSetup), useCameraForVideo: !sceneCameraForVideo },
                  }))}>
                  <Ic name="camera" /> Scene camera {sceneCameraForVideo ? 'on' : 'off'}
                </button>}
                <button onClick={() => viewportApi.fit()} title="Fit viewport"><Ic name="fit" /> Fit</button>
              </div>
            </div>
            <div className="nx-stage bm-stage">
              <ViewportBoundary><Viewport model={model} timeline={timeline} showSpots={tab === 'assembly'} /></ViewportBoundary>
              <ViewportChrome model={model} onMakeSubmodel={makeSubmodel} />
              {mode === 'preview' && timeline && <PreviewPlayer model={model} timeline={timeline} />}
              {mode === 'preview' && !timeline && <div className="overlay-note">{planError ? `Couldn't plan the animation: ${planError}` : 'Planning the build animation…'}</div>}
            </div>
          </section>
          <Inspector model={model} onMakeSubmodel={makeSubmodel} timeline={timeline} checks={warnings.length} stepCard={mode === 'edit' ? <StepCallout model={model} timeline={timeline} /> : null} />
        </div>
        <div className="nx-resizer" onPointerDown={resize} title="Drag to resize the timeline" />
        <div className="bm-timeline-shell">
          <div className="bm-timeline-modebar">
            <span className="bm-timeline-mode-label"><Ic name="video" /> Animation Editor</span>
            <div className="bm-timeline-mode-switch" role="tablist" aria-label="Timeline workspace">
              <button role="tab" aria-selected={timelineEditor === 'build'} className={timelineEditor === 'build' ? 'active' : ''}
                onClick={() => useStudio.getState().setTimelineEditor('build')}><Ic name="brick" /> Build</button>
              <button role="tab" aria-selected={timelineEditor === 'timeline'} className={timelineEditor === 'timeline' ? 'active' : ''}
                onClick={() => { useStudio.getState().setTimelineEditor('timeline'); setTlHeight((h) => Math.max(340, h)); }}><Ic name="key" /> Timeline</button>
              <button role="tab" aria-selected={false} title="Open motion keyframes" className="bm-motion-tab" onClick={() => { useStudio.getState().setTimelineEditor('timeline'); setTlHeight((h) => Math.max(320, h)); }}>Motion</button>
            </div>
          <span className="bm-timeline-step-name"><strong>Step {Math.min((currentStep ?? 0) + 1, Math.max(1, timeline?.steps.length ?? 1))} of {timeline?.steps.length ?? '—'}</strong><span>·</span><span>{timelineEditor === 'build' ? 'Building ' + (editingModel || 'main model') : 'Editing motion keyframes'}</span><Ic name="edit" /></span>
          {video.planner === 'standard-motion' && timelineEditor === 'timeline' && (motionKeyError || motionKeyStatus) &&
            <span role="status" title={motionKeyError || motionKeyStatus} className="bm-timeline-mode-hint">{motionKeyError || motionKeyStatus}</span>}
          {timelineEditor === 'build' && timeline && !planning && !planError && <button className="bm-link-build"
            title={video.planner === 'standard-motion' ? 'Generate all independent per-brick motion and visibility keyframes; existing corrected keys are preserved' : 'Keep the generated Build as a procedural base and keyframe offsets on top of its motion'}
            onClick={() => {
              try {
                const s = useStudio.getState();
                if (video.planner !== 'standard-motion')
                  s.apply((p) => ({ ...p, animation: linkBuildLayer(animationOf(p.animation), s.editingModel, timeline.duration) }));
                setMotionKeyError(''); setMotionKeyStatus('');
                s.setTimelineEditor('timeline');
                setTlHeight((h) => Math.max(340, h));
              } catch (error) { alert(error instanceof Error ? error.message : String(error)); }
            }}><Ic name="key" /> {video.planner === 'standard-motion' ? 'Edit all part keyframes' : 'Edit Build in Timeline'}</button>}
          </div>
          {timelineEditor === 'build'
            ? <BuildTimeline timeline={timeline} planning={planning} error={model.error || planError}
                progress={progress} loading={!model.ready && !model.error} onRetry={model.error ? undefined : retry}
                onUseStandard={!model.error && !!planError && (video.planner === 'construction-v2' || video.planner === 'construction-v3') ? () => {
                  if (window.confirm('Standard planning may include paths that are NOT collision-certified. Unsafe or blocked routes will be flagged. Switch to Standard planner?')) {
                    useAppSettings.getState().set({ planner: 'legacy' });
                  }
                } : undefined} />
            : <KeyframeTimeline timeline={timeline} planning={planning} buildError={planError}
                instances={model.view.instances} placements={instancePlacements(model.plan, editingModel, model.assembly)} />}
        </div>
      </div>
      {newSubmodelOpen && <NewSubmodelDialog plan={model.plan} count={selectedIds.length} onCreate={onCreateSubmodel} onClose={() => setNewSubmodelOpen(false)} />}
      {dialog === 'projects' && <ProjectsDialog onClose={() => setDialog(null)} />}
      {dialog === 'templates' && <TemplatesDialog onClose={() => setDialog(null)} />}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      {exportJobs && exportJobs.length > 0 && <ExportDialog plan={model.plan} jobs={exportJobs} mode={timelineEditor} onClose={() => setExportJobs(null)} />}
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
    <div className="studio bm-splash" {...themeAttrs()}>
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
