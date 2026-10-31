import { useEffect, useRef, useState } from 'react';
import { resolveExportCamera, type ExportCameraSetting } from '../anim/cameraTrack/context';
import type { CameraTrack } from '../anim/cameraTrack/types';
import { animationDuration, canExportMp4, exportKeyframeVideo, exportVideo } from '../export/exportVideo';
import { animationOf } from '../anim/keyframes';
import { buildLayerAt } from '../anim/buildLayer';
import { VIDEO_FORMATS, formatAspect } from '../export/formats';
import { assemble } from '../model/assemble';
import type { Plan } from '../plan/types';
import { createStudio, perspectiveEquivalent } from '../render/studio';
import { animOptions, useAppSettings } from '../state/appSettings';
import { getColors, metricsOf } from '../state/partService';
import { planTimeline } from '../state/timelineService';
import { scopedPlan } from '../state/useModel';
import { useStudio } from '../state/store';
import { sceneSetupOf } from '../render/sceneSetup';
import type { EditorCamera } from '../anim/camera';
import { viewportApi } from './viewportApi';
import { useSceneView } from './sceneViewState';
import { instancePlacements } from './modelPlacement';
import { safeFileName, saveBlob } from './download';
import { Ic } from './icons';

/** One MP4 to render: `model` '' is the whole set, anything else a submodel on its own. */
export type ExportJob = { model: string; label: string };

type JobState =
  | { s: 'queued' }
  | { s: 'planning' }
  | { s: 'rendering'; done: number; total: number }
  | { s: 'done'; blob: Blob; seconds: number }
  | { s: 'error'; message: string };

export const jobFileName = (setName: string, model: string, mode: 'build' | 'timeline' = 'build') =>
  `${safeFileName(`${model ? `${setName} - ${model}` : setName}${mode === 'timeline' ? ' - Timeline' : ''}`)}.mp4`;

/** Renders one or more models to MP4, one after another, and saves each file as it finishes. */
/** The model's Camera track for this video, when the MP4 camera is set to use it and it has keys. */
function exportTrack(plan: Plan, model: string, mode: 'build' | 'timeline', setting: ExportCameraSetting): CameraTrack | null {
  const track = plan.cameraTracks?.[model]?.[mode === 'timeline' ? 'timeline' : 'build'];
  return resolveExportCamera(setting, !!track?.keys.length) === 'track' ? track! : null;
}

export function ExportDialog({ plan, jobs, mode = 'build', onClose }: { plan: Plan; jobs: ExportJob[]; mode?: 'build' | 'timeline'; onClose(): void }) {
  const settings = useAppSettings.getState();
  const { fps, format } = settings;
  // The MP4 is always the chosen format's size. "My viewport" keeps your angle and zoom,
  // re-fitted to that frame shape (see buildViewCamera), instead of changing the video's shape.
  const { width, height } = VIDEO_FORMATS[format];
  const viewportMode = settings.exportCamera === 'buildView';
  const [phase, setPhase] = useState<'checking' | 'unsupported' | 'running' | 'finished' | 'cancelled'>('checking');
  const [states, setStates] = useState<JobState[]>(() => jobs.map(() => ({ s: 'queued' })));
  const abort = useRef<AbortController | null>(null);
  const update = (i: number, st: JobState) => setStates((list) => list.map((old, k) => (k === i ? st : old)));

  useEffect(() => {
    let alive = true;
    const ac = new AbortController();
    abort.current = ac;
    (async () => {
      if (!(await canExportMp4(width, height, fps).catch(() => false))) return alive && setPhase('unsupported');
      if (!alive) return;
      setPhase('running');
      const logo = settings.logoEnabled && settings.logoBitmap ? { image: settings.logoBitmap, corner: settings.logoCorner } : null;
      for (let i = 0; i < jobs.length && alive && !ac.signal.aborted; i++) {
        const job = jobs[i];
        try {
          update(i, { s: 'planning' });
          const animation = animationOf(plan.animation);
          const linkedBuild = !!buildLayerAt(animation, job.model);
          // Fully baked Standard Motion tracks no longer have a Build layer, but
          // their camera should still follow the assembly and its hero orbit.
          const bakedBuild = animation.tracks.some((track) => track.model === job.model && track.source === 'baked-flight');
          let timeline: Awaited<ReturnType<typeof planTimeline>> | null = null;
          if (mode === 'build' || linkedBuild || bakedBuild) {
            try { timeline = await planTimeline(plan, job.model, animOptions(settings, plan.sceneSetup), 'export'); }
            catch (error) {
              // A camera-only plan must never block an already-baked Timeline.
              if (mode === 'build' || linkedBuild) throw error;
            }
          }
          const asm = assemble(scopedPlan(plan, job.model), metricsOf, getColors());
          const instances = asm.instances;
          if (!instances.length) throw new Error('This model has no parts.');
          let last = -1;
          const options = {
              instances,
              width,
              height,
              fps,
              studioLook: settings.studioLook,
              cameraFraming: settings.cameraFraming,
              camera: settings.camera,
              buildView: viewportMode ? editorCamera() : undefined,
              cameraTrack: exportTrack(plan, job.model, mode, settings.exportCamera),
              sceneSetup: plan.sceneSetup,
              stageCameraFixed: settings.floorStyle === 'camera-frame',
              render: { edges: settings.edgeLines, linearColors: settings.linearColors },
        materials: settings.materials,
              logo,
              pathTrace: settings.videoEngine === 'path' ? { samples: settings.pathSamples } : null,
              snapSound: settings.snapSound,
              sound: settings.sound,
              signal: ac.signal,
              onProgress: (done: number, total: number) => {
                // Avoid re-rendering the modal for every 60/90/120-FPS frame.
                const pct = Math.floor((done / total) * 1000);
                if (alive && pct !== last) ((last = pct), update(i, { s: 'rendering', done, total }));
              },
          };
          const blob = mode === 'timeline'
            ? await exportKeyframeVideo({ ...options, animation, editingModel: job.model,
                placements: instancePlacements(plan, job.model, asm), buildTimeline: timeline }, { createStudio })
            : await exportVideo({ ...options, timeline: timeline! }, { createStudio });
          if (!alive) return;
          update(i, { s: 'done', blob, seconds: mode === 'timeline' ? animationDuration(animation) : timeline!.duration });
          saveBlob(jobFileName(plan.name, job.model, mode), blob);
        } catch (e) {
          if (!alive || (e as Error).name === 'AbortError') return;
          update(i, { s: 'error', message: (e as Error).message });
        }
      }
      if (alive) setPhase(ac.signal.aborted ? 'cancelled' : 'finished');
    })();
    return () => {
      alive = false;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doneCount = states.filter((s) => s.s === 'done' || s.s === 'error').length;
  const current = states.find((s) => s.s === 'rendering') as Extract<JobState, { s: 'rendering' }> | undefined;
  const overall = (doneCount + (current ? current.done / current.total : 0)) / Math.max(1, jobs.length);
  // A saved scene camera takes over after the intro: the MP4 holds its shot, and the hero
  // orbit swings around it. Say so before the export starts, with the way out.
  const scene = useStudio((s) => s.plan.sceneSetup);
  const sceneCameraInCharge = scene?.useCameraForVideo === true && !!scene.activeCameraId;
  const sceneCameraName = scene?.cameras.find((c) => c.id === scene.activeCameraId)?.name ?? 'Camera';

  return (
    <div className="dialog-backdrop">
      <div className="dialog bm-export" role="dialog" aria-label="Export video">
        <h2>{jobs.length > 1 ? `Export ${jobs.length} ${mode === 'timeline' ? 'Timeline' : 'Build'} videos` : `Export ${jobs[0]?.label ?? 'video'} · ${mode === 'timeline' ? 'Timeline' : 'Build'}`}</h2>
        <p className="muted">
          {width}×{height} · {fps} fps · MP4 (H.264) · {mode === 'timeline' ? 'keyframed motion' : 'automatic construction'}
          {viewportMode ? ' · from your viewport camera' : ' · from the automatic camera'}
          {settings.videoEngine === 'path' ? ` · path traced, ${settings.pathSamples} samples per frame` : ''}
        </p>
        {phase === 'checking' && <p className="muted">Checking your browser…</p>}
        {sceneCameraInCharge && (
          <div className="bm-banner" role="note">
            <span>
              This project&rsquo;s video uses the saved scene camera <b>{sceneCameraName}</b>: the intro moves into its
              shot{viewportMode || settings.heroOrbit ? ', the build holds it and the outro orbits around it' : ' and the MP4 holds that shot'}.
            </span>
            {phase !== 'checking' && phase !== 'running' && (
              <button className="nx-btn nx-sm" onClick={() => useStudio.getState().apply((p) => ({
                ...p,
                sceneSetup: { ...sceneSetupOf(p.sceneSetup), useCameraForVideo: false },
              }))}>
                <Ic name="camera" /> Use the automatic camera
              </button>
            )}
          </div>
        )}
        {phase === 'unsupported' && (
          <p className="error">
            Your browser can't encode {width}×{height} MP4 at {fps} fps. Try a lower frame rate or another format in the Video panel, or use a recent Chrome.
          </p>
        )}
        {phase !== 'checking' && phase !== 'unsupported' && (
          <>
            <div className="progress" aria-label="Overall progress">
              <div style={{ width: `${Math.round(overall * 100)}%` }} />
            </div>
            <ul className="bm-export-jobs">
              {jobs.map((job, i) => {
                const st = states[i];
                return (
                  <li key={job.model || '(main)'} className={`bm-export-job ${st.s}`}>
                    <Ic name={job.model ? 'box' : 'brick'} />
                    <span className="bm-export-name">{job.label}</span>
                    <span className="bm-export-state">
                      {st.s === 'queued' && 'Waiting'}
                      {st.s === 'planning' && (mode === 'timeline' ? 'Preparing animation…' : 'Planning animation…')}
                      {st.s === 'rendering' && `${Math.floor((st.done / st.total) * 100)}% · frame ${Math.min(st.total, Math.floor(st.done) + 1)}/${st.total}`}
                      {st.s === 'done' && `${st.seconds.toFixed(1)} s · ${(st.blob.size / 1e6).toFixed(1)} MB`}
                      {st.s === 'error' && <span className="error">{st.message}</span>}
                    </span>
                    {st.s === 'done' && (
                      <button className="nx-icon" title="Download again" aria-label={`Download ${job.label} again`} onClick={() => saveBlob(jobFileName(plan.name, job.model, mode), st.blob)}>
                        <Ic name="download" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {jobs.length > 1 && <p className="nx-fine">Each MP4 downloads when it finishes. If your browser asks, allow multiple downloads.</p>}
          </>
        )}
        <div className="actions">
          {phase === 'running' || phase === 'checking' ? (
            <button
              onClick={() => {
                abort.current?.abort();
                onClose();
              }}
            >
              Cancel
            </button>
          ) : (
            <button className="primary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The camera the viewport is showing: the scene camera when it is in charge, else the editor's. */
function editorCamera(): EditorCamera | undefined {
  const setup = useStudio.getState().plan.sceneSetup;
  if (setup?.useCameraForVideo) {
    // a scene camera is already framed for the output shape (its camera view): use it as is
    const active = setup.cameras.find((camera) => camera.id === setup.activeCameraId);
    if (active) return { position: [...active.position], target: [...active.target], fov: active.fov };
  }
  const studio = viewportApi.studio;
  const target = viewportApi.controls?.target;
  if (!studio || !target) return undefined;
  // an ortho view's zoom is not a camera move: turn it into the matching distance
  const view = perspectiveEquivalent(studio, target);
  const { cameraView, width, height } = useSceneView.getState();
  const aspect = cameraView ? formatAspect(useAppSettings.getState().format) : Math.max(1, width) / Math.max(1, height);
  return { position: [view.position.x, view.position.y, view.position.z], target: [target.x, target.y, target.z], fov: view.fov, aspect };
}
