import { useEffect, useRef, useState } from 'react';
import { canExportMp4, exportVideo } from '../export/exportVideo';
import { VIDEO_FORMATS } from '../export/formats';
import { assemble } from '../model/assemble';
import type { Plan } from '../plan/types';
import { createStudio } from '../render/studio';
import { animOptions, useAppSettings } from '../state/appSettings';
import { getColors, metricsOf } from '../state/partService';
import { planTimeline } from '../state/timelineService';
import { scopedPlan } from '../state/useModel';
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

export const jobFileName = (setName: string, model: string) => `${safeFileName(model ? `${setName} - ${model}` : setName)}.mp4`;

/** Renders one or more models to MP4, one after another, and saves each file as it finishes. */
export function ExportDialog({ plan, jobs, onClose }: { plan: Plan; jobs: ExportJob[]; onClose(): void }) {
  const settings = useAppSettings.getState();
  const { fps, format } = settings;
  const { width, height } = VIDEO_FORMATS[format];
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
          const timeline = await planTimeline(plan, job.model, animOptions(settings), 'export');
          const instances = assemble(scopedPlan(plan, job.model), metricsOf, getColors()).instances;
          if (!instances.length) throw new Error('This model has no parts.');
          let last = -1;
          const blob = await exportVideo(
            {
              timeline,
              instances,
              width,
              height,
              fps,
              studioLook: settings.studioLook,
              cameraFraming: settings.cameraFraming,
              render: { edges: settings.edgeLines, linearColors: settings.linearColors },
              logo,
              snapSound: settings.snapSound,
              signal: ac.signal,
              onProgress: (done, total) => {
                // Avoid re-rendering the modal for every 60/90/120-FPS frame.
                const pct = Math.floor((done / total) * 100);
                if (alive && pct !== last) ((last = pct), update(i, { s: 'rendering', done, total }));
              },
            },
            { createStudio },
          );
          if (!alive) return;
          update(i, { s: 'done', blob, seconds: timeline.duration });
          saveBlob(jobFileName(plan.name, job.model), blob);
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

  return (
    <div className="dialog-backdrop">
      <div className="dialog bm-export" role="dialog" aria-label="Export video">
        <h2>{jobs.length > 1 ? `Export ${jobs.length} videos` : `Export ${jobs[0]?.label ?? 'video'}`}</h2>
        <p className="muted">
          {width}×{height} · {fps} fps · MP4 (H.264)
        </p>
        {phase === 'checking' && <p className="muted">Checking your browser…</p>}
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
                      {st.s === 'planning' && 'Planning animation…'}
                      {st.s === 'rendering' && `${Math.round((st.done / st.total) * 100)}% · frame ${st.done}/${st.total}`}
                      {st.s === 'done' && `${st.seconds.toFixed(1)} s · ${(st.blob.size / 1e6).toFixed(1)} MB`}
                      {st.s === 'error' && <span className="error">{st.message}</span>}
                    </span>
                    {st.s === 'done' && (
                      <button className="nx-icon" title="Download again" aria-label={`Download ${job.label} again`} onClick={() => saveBlob(jobFileName(plan.name, job.model), st.blob)}>
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
