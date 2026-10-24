import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from 'react';
import type { StepSpan, Timeline } from '../anim/timeline';
import { modelSteps, updateStep } from '../plan/ops';
import { useAppSettings } from '../state/appSettings';
import { usePlayback } from '../state/playback';
import { useStudio } from '../state/store';
import { Ic } from './icons';
import { packRows, partClips } from '../anim/partClips';
import { PART_MIN_PX, PartsLane, partsLaneHeight } from './PartsLane';
import { planningLabel, type PlanningProgress } from '../anim/planning';

const MAX_PART_ROWS = 6;

const RULER = 30;
const LANE = 42;
const PAD = 24;
type TrimKind = 'intro' | 'build' | 'outro' | 'step';
type TrimPreview = { kind: TrimKind; index?: number; seconds: number };
const rounded = (v: number) => Math.round(v * 10) / 10;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** During a drag, block browser text highlighting; always restore the old style. */
function stopSelection() {
  const prev = document.body.style.userSelect;
  document.body.style.userSelect = 'none';
  return () => { document.body.style.userSelect = prev; };
}

/** 00:01.5 */
export const timecode = (s: number) => {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

const tickStep = (px: number) => [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * px >= 56) ?? 120;

/** Main-model steps in play order, one entry per step (a step split by a submodel build counts once, at its first part). */
const mainSteps = (tl: Timeline) => {
  const seen = new Set<number>();
  return tl.steps.filter((s) => s.model === '' && !seen.has(s.index) && seen.add(s.index));
};

/**
 * The build animation as lanes (Rewind studio-kit timeline): main steps, submodel builds and the camera.
 * Clicking a step edits it; the ruler, play and step buttons drive the preview.
 */
export function BuildTimeline({ timeline: tl, planning = false, error = '', progress = null, loading = false, onRetry }: {
  timeline: Timeline | null; planning?: boolean; error?: string;
  progress?: PlanningProgress | null; loading?: boolean; onRetry?: () => void;
}) {
  const t = usePlayback((s) => s.t);
  const playing = usePlayback((s) => s.playing);
  const plan = useStudio((s) => s.plan);
  const mode = useStudio((s) => s.mode);
  const follow = usePlayback((s) => s.follow);
  const currentStep = useStudio((s) => s.currentStep);
  const editingModel = useStudio((s) => s.editingModel);
  const st = useStudio.getState;
  const pb = usePlayback.getState;
  const [zoom, setZoom] = useState(1);
  const [note, setNote] = useState<string | null>(null);
  const [dragStep, setDragStep] = useState<number | null>(null);
  const [overStep, setOverStep] = useState<number | null>(null);
  const [width, setWidth] = useState(900);
  const [trimPreview, setTrimPreview] = useState<TrimPreview | null>(null);
  const video = useAppSettings();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 900));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hardwareCount = tl?.units.filter((u) => u.preassembled).length ?? 0;
  const windowCount = tl?.units.filter((u) => u.preassembled === 'window + glass').length ?? 0;
  const wheelCount = hardwareCount - windowCount;
  // pieces with no collision-free route found: they take the least-obstructed one
  const uncertified = tl?.units.filter((u) => u.uncertified).flatMap((u) => u.keys) ?? [];
  const dur = tl?.duration ?? 0;
  const px = (dur > 0 ? Math.max(20, (width - PAD * 2) / dur) : 60) * zoom;
  const X = (s: number) => PAD + s * px;
  /** Draw only a trim preview during pointer movement; rebuilding hundreds of flight paths each pixel causes lag. */
  const introEnd = trimPreview?.kind === 'intro' ? trimPreview.seconds : (tl?.intro ?? 0);
  const buildLength = trimPreview?.kind === 'build' ? trimPreview.seconds : (tl ? tl.buildEnd - tl.intro : 0);
  const buildEnd = introEnd + buildLength;
  const outroLength = trimPreview?.kind === 'outro' ? trimPreview.seconds : (tl ? tl.duration - tl.buildEnd : 0);
  const previewDuration = buildEnd + outroLength;
  const seek = (s: number) => pb().set({ t: Math.max(0, Math.min(dur, s)) });

  // Ctrl/⌘ + wheel (or a trackpad pinch), Alt + wheel, or any wheel over the ruler zooms
  // the timeline around the pointer, like a video editor
  const zoomAnchor = useRef<{ t: number; offset: number } | null>(null);
  const wheelState = useRef({ px, zoom });
  wheelState.current = { px, zoom };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const overRuler = (e.target as Element | null)?.closest?.('.nx-ruler');
      if (!(e.ctrlKey || e.metaKey || e.altKey || overRuler)) return;
      e.preventDefault();
      const { px: curPx, zoom: z } = wheelState.current;
      const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      const next = Math.min(16, Math.max(1, z * Math.exp(-delta * (e.ctrlKey && !e.metaKey ? 0.01 : 0.0025))));
      if (next === z) return;
      const offset = e.clientX - el.getBoundingClientRect().left;
      zoomAnchor.current = { t: (offset + el.scrollLeft - PAD) / curPx, offset };
      setZoom(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const el = scrollRef.current;
    zoomAnchor.current = null;
    if (a && el) el.scrollLeft = Math.max(0, PAD + a.t * px - a.offset);
  }, [px]);

  // The timeline always shows the model on screen, so a step clip is a step of THAT model.
  // In the Build view the timeline drives the canvas: playing, scrubbing or jumping shows the
  // build at the playhead there (follow), and stopping leaves it at that moment, ready to edit.
  const inBuild = () => st().mode === 'edit';
  const editStep = (span: StepSpan) => {
    if (inBuild()) {
      useStudio.setState({ currentStep: span.index });
      pb().set({ playing: false, follow: true });
    } else st().setCurrentStep(span.index);
    seek(span.start);
  };
  const jump = (dir: 1 | -1) => {
    if (!tl) return;
    const list = mainSteps(tl);
    const target = dir > 0 ? list.find((s) => s.start > t + 1e-3) : [...list].reverse().find((s) => s.start < t - 0.05);
    if (!target) return seek(dir > 0 ? dur : 0);
    editStep(target);
  };
  const togglePlay = () => {
    if (!tl) return;
    if (playing) return pb().set({ playing: false });
    pb().set({ t: t >= dur - 1e-3 ? 0 : t, playing: true, stopAt: null, loopFrom: null, follow: inBuild() || pb().follow });
  };

  const playRef = useRef(togglePlay);
  playRef.current = togglePlay;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== ' ' || e.metaKey || e.ctrlKey || (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName)))) return;
      e.preventDefault();
      playRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const beginTrim = (e: RPointerEvent, kind: TrimKind, start: number, min: number, max: number, commit: (value: number) => void, index?: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const releaseSelection = stopSelection();
    const x0 = e.clientX;
    let next = start;
    const move = (ev: PointerEvent) => {
      next = rounded(clamp(start + (ev.clientX - x0) / px, min, max));
      setTrimPreview({ kind, index, seconds: next });
    };
    const done = (ev: PointerEvent) => {
      move(ev);
      cleanup();
      pb().set({ playing: false });
      commit(next);
    };
    const cancel = () => cleanup();
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', cancel);
      releaseSelection();
      setTrimPreview(null);
    };
    setTrimPreview({ kind, index, seconds: start });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', cancel);
  };

  const trimCamera = (e: RPointerEvent, kind: 'intro' | 'build' | 'outro') => {
    if (!tl) return;
    const seconds = kind === 'intro' ? tl.intro : kind === 'build' ? tl.buildEnd - tl.intro : tl.duration - tl.buildEnd;
    const key = kind === 'intro' ? 'introSeconds' : kind === 'build' ? 'buildSeconds' : 'outroSeconds';
    beginTrim(e, kind, seconds, kind === 'build' ? 1 : 0.2, 120, (value) => useAppSettings.getState().set({ [key]: value }));
  };
  const keyTrim = (e: RKeyboardEvent, kind: 'intro' | 'build' | 'outro', value: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); e.stopPropagation();
    const key = kind === 'intro' ? 'introSeconds' : kind === 'build' ? 'buildSeconds' : 'outroSeconds';
    useAppSettings.getState().set({ [key]: rounded(clamp(value + (e.key === 'ArrowLeft' ? -0.1 : 0.1), kind === 'build' ? 1 : 0.2, 120)) });
  };
  const trimStep = (e: RPointerEvent, span: StepSpan) => {
    const data = steps[span.index];
    if (!data) return;
    const pause = data.pauseAfter ?? 0;
    beginTrim(e, 'step', pause, 0, 10, (value) => {
      st().apply((p) => updateStep(p, st().editingModel, span.index, { title: data.title, notes: data.notes, pauseAfter: value }));
    }, span.index);
  };

  const scrubFrom = (e: RPointerEvent<HTMLElement>) => {
    if (!tl || e.button !== 0) return;
    e.preventDefault();
    const releaseSelection = stopSelection();
    const el = scrollRef.current!;
    const at = (clientX: number) => (clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD) / px;
    pb().set({ playing: false, stopAt: null, loopFrom: null, follow: inBuild() || pb().follow });
    seek(at(e.clientX));
    const move = (ev: PointerEvent) => seek(at(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      releaseSelection();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const steps = modelSteps(plan, editingModel);
  // one clip per piece; rows depend on the zoom (short flights get a readable minimum width)
  const parts = useMemo(() => {
    if (!tl) return { clips: [], rows: 1 };
    const clips = partClips(tl, steps);
    return { clips, rows: packRows(clips, PART_MIN_PX / px, MAX_PART_ROWS) };
  }, [tl, steps, px]);
  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    return (clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD) / px;
  };
  const step = tl ? tickStep(px) : 1;
  const ticks = tl ? Array.from({ length: Math.floor(dur / step) + 1 }, (_, i) => i * step) : [];
  const contentWidth = Math.max(width, X(Math.max(dur, previewDuration)) + PAD);

  return (
    <div className="nx-timeline bm-timeline">
      <div className="nx-transport">
        <div className="nx-tr-left">
          <span className="nx-tc">
            <b>{timecode(t)}</b> / {timecode(dur)}
          </span>
          <span className="nx-chip bm-scope" title="The timeline, preview and MP4 export follow the model you have open">
            <Ic name={editingModel ? 'box' : 'brick'} /> {editingModel || 'Main model'}
          </span>
          {uncertified.length > 0 && (
            <TimelineNote id="route" open={note} onOpen={setNote} tone="warn" label={`${uncertified.length} rough route${uncertified.length === 1 ? '' : 's'}`} title={uncertified.join('\n')}>
              {uncertified.length === 1 ? '1 piece has' : `${uncertified.length} pieces have`} no collision-free route, so {uncertified.length === 1 ? 'it takes' : 'they take'} the least-blocked one and may clip a neighbour. Check {uncertified.length === 1 ? 'it' : 'them'} in the preview.
            </TimelineNote>
          )}
          {hardwareCount > 0 && (
            <TimelineNote id="hardware" open={note} onOpen={setNote} label={`${hardwareCount} preassembled`}>
              {[
                wheelCount ? `${wheelCount} wheel assemblies start with tyre and rim connected on the staging table. Tyre fitting is not animated.` : '',
                windowCount ? `${windowCount} window assemblies start with the glass already in the frame. Glass fitting is not animated.` : '',
              ].filter(Boolean).join(' ')}
            </TimelineNote>
          )}
          {planning && (
            <span className="bm-planning" role="status" aria-live="polite">
              <i /> {planningLabel(progress)}
            </span>
          )}
        </div>
        <div className="nx-tr-center">
          <button className="nx-icon" aria-label="Previous step" title="Previous step" disabled={!tl} onClick={() => jump(-1)}>
            <Ic name="prev" />
          </button>
          <button
            className="nx-play"
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause (Space)' : 'Play the build (Space)'}
            disabled={!tl}
            onClick={togglePlay}
          >
            <Ic name={playing ? 'pause' : 'play'} />
          </button>
          <button className="nx-icon" aria-label="Next step" title="Next step" disabled={!tl} onClick={() => jump(1)}>
            <Ic name="next" />
          </button>
        </div>
        <div className="nx-tr-right">
          <button className="nx-icon" aria-label="Zoom out" title="Zoom out (Ctrl/⌘ + scroll)" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>
            <Ic name="zoomOut" />
          </button>
          <span className="nx-zoom">{Math.round(zoom * 100)}%</span>
          <button className="nx-icon" aria-label="Zoom in" title="Zoom in (Ctrl/⌘ + scroll)" disabled={zoom >= 16} onClick={() => setZoom((z) => Math.min(16, z * 1.5))}>
            <Ic name="zoomIn" />
          </button>
          <button className="nx-icon" aria-label="Fit timeline" title="Fit the whole video" onClick={() => setZoom(1)}>
            <Ic name="widen" />
          </button>
        </div>
      </div>
      <div className="nx-tracks">
        <div className="nx-heads" ref={headsRef}>
          {(
            [
              ['steps', 'Steps', LANE],
              ['brick', 'Parts', partsLaneHeight(parts.rows)],
              ['box', 'Submodels', LANE],
              ['camera', 'Camera', LANE],
            ] as const
          ).map(([icon, label, height]) => (
            <div key={label} className="nx-head-row" style={{ height }}>
              <Ic name={icon} />
              <span>{label}</span>
            </div>
          ))}
        </div>
        <div
          className="nx-scroll"
          ref={scrollRef}
          // the lane names follow the lanes when the Parts lane makes them taller than the panel
          onScroll={(e) => {
            if (headsRef.current) headsRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
        >
          <div className="nx-content" style={{ width: contentWidth }}>
            <div
              className="nx-ruler bm-ruler"
              style={{ width: contentWidth }}
              onPointerDown={scrubFrom}
              onKeyDown={(e) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                  e.preventDefault();
                  seek(e.key === 'Home' ? 0 : e.key === 'End' ? dur : t + (e.key === 'ArrowLeft' ? -0.1 : 0.1));
                }
              }}
              tabIndex={0}
              aria-label="Scrub the build"
              role="slider"
              aria-valuenow={t}
              aria-valuemin={0}
              aria-valuemax={dur}
            >
              {ticks.map((s) => (
                <span key={s} className="bm-tick" style={{ left: X(s) }}>
                  {s % 1 === 0 ? `${s}s` : ''}
                </span>
              ))}
            </div>
            {error ? (
              <div className="bm-planner-error" role="alert">
                <strong>Animation could not be planned</strong>
                <p>{error}</p>
                <p>The model is still editable. No blocked pieces were hidden or teleported.</p>
                {onRetry && <button className="nx-btn nx-sm" onClick={onRetry}>Retry planning</button>}
              </div>
            ) : !tl ? (
              <p className="nx-hint bm-empty" role="status">
                {loading ? 'Loading model parts...' : planning ? planningLabel(progress) : 'Add or open a model to build its animation.'}
              </p>
            ) : (
              <div className="nx-lanes">
                <div className="nx-lane" style={{ height: LANE }}>
                  {tl.steps
                    .filter((s) => s.model === '')
                    .map((s, i) => {
                      const sel = currentStep === s.index;
                      const data = steps[s.index];
                      const count = data?.pieces.length ?? 0;
                      const label = data?.title ? `Step ${s.index + 1} · ${data.title}` : `Step ${s.index + 1}`;
                      return (
                        <button
                          key={i}
                          draggable
                          onDragStart={(e) => {
                            setDragStep(s.index);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', `brickmotion-step:${s.index}`);
                          }}
                          onDragOver={(e) => {
                            if (dragStep === null) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            setOverStep(s.index);
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            const text = e.dataTransfer.getData('text/plain');
                            const from = dragStep ?? (text.startsWith('brickmotion-step:') ? Number(text.slice(17)) : NaN);
                            setDragStep(null);
                            setOverStep(null);
                            if (!Number.isInteger(from) || from === s.index) return;
                            pb().set({ playing: false, t: 0 });
                            st().reorderBuildStep(st().editingModel, from, s.index);
                            st().setMode('edit');
                            st().setCurrentStep(s.index);
                          }}
                          onDragEnd={() => { setDragStep(null); setOverStep(null); }}
                          className={`nx-clip bm-step ${sel ? 'sel' : ''} ${dragStep !== null && overStep === s.index ? 'bm-step-over' : ''}`}
                          style={{ left: X(s.start), width: Math.max(6, ((s.end - s.start) + (trimPreview?.kind === 'step' && trimPreview.index === s.index ? trimPreview.seconds : data?.pauseAfter ?? 0)) * px - 2) }}
                          aria-label={`${label} · ${count} piece${count === 1 ? '' : 's'}`}
                          title={`${label}: ${count} piece${count === 1 ? '' : 's'}. Click to edit, drag onto another step to reorder.`}
                          onClick={() => editStep(s)}
                        >
                          <span className="lbl">{label}</span>
                          <span
                            className="bm-trim bm-step-trim"
                            role="separator" tabIndex={0} aria-orientation="vertical"
                            aria-label={`Change pause after step ${s.index + 1}`}
                            title={`Extend this step's hold (${(data?.pauseAfter ?? 0).toFixed(1)} s)`}
                            onPointerDown={(e) => trimStep(e, s)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                              e.preventDefault(); e.stopPropagation();
                              const value = rounded(clamp((data?.pauseAfter ?? 0) + (e.key === 'ArrowRight' ? 0.1 : -0.1), 0, 10));
                              st().apply((p) => updateStep(p, st().editingModel, s.index, { title: data?.title, notes: data?.notes, pauseAfter: value }));
                            }}
                          />
                          {trimPreview?.kind === 'step' && trimPreview.index === s.index && <span className="bm-trim-value">+{trimPreview.seconds.toFixed(1)}s</span>}
                        </button>
                      );
                    })}
                  {tl.steps.length === 0 && <span className="nx-hint bm-empty">Add pieces and the steps show up here.</span>}
                </div>
                <PartsLane tl={tl} steps={steps} clips={parts.clips} rows={parts.rows} px={px} X={X} timeAt={timeAt} />
                <div className="nx-lane" style={{ height: LANE }}>
                  {tl.subBuilds.map((b) => (
                    <button
                      key={b.key}
                      // a submodel built inside another one (a minifig in a train) sits under its parent's clip
                      className={`nx-clip bm-sub ${b.key.includes('/') ? 'bm-sub-nested' : ''} ${editingModel === b.name ? 'sel' : ''}`}
                      style={{ left: X(b.start), width: Math.max(6, (b.attachEnd - b.start) * px - 2) }}
                      aria-label={`Build ${b.name}, attach at ${b.attachStart.toFixed(1)} s`}
                      title={`${b.name}: built aside, attached at ${b.attachStart.toFixed(1)} s. Click to open it with its own timeline.`}
                      onClick={() => {
                        pb().set({ playing: false, t: 0, stopAt: null, loopFrom: null });
                        st().setEditingModel(b.name);
                      }}
                    >
                      <span className="av">
                        <Ic name="box" />
                      </span>
                      <span className="lbl">{b.name}</span>
                      <i className="bm-attach" style={{ width: Math.max(2, (b.attachEnd - b.attachStart) * px) }} />
                    </button>
                  ))}
                </div>
                <div className="nx-lane" style={{ height: LANE }}>
                  <div className="nx-clip bm-cam dim" style={{ left: X(0), width: Math.max(8, introEnd * px - 2) }} title="Drag the right edge to change the intro duration">
                    <span className="lbl">Intro</span>
                    <span className="bm-trim" role="separator" tabIndex={0} aria-label="Resize Intro" onPointerDown={(e) => trimCamera(e, 'intro')} onKeyDown={(e) => keyTrim(e, 'intro', tl.intro)} />
                  </div>
                  <div className="nx-clip bm-cam" style={{ left: X(introEnd), width: Math.max(8, buildLength * px - 2) }} title="Drag either edge to adjust intro or build length">
                    <span className="bm-trim bm-trim-left" role="separator" tabIndex={0} aria-label="Resize Intro at Build start" onPointerDown={(e) => trimCamera(e, 'intro')} onKeyDown={(e) => keyTrim(e, 'intro', tl.intro)} />
                    <span className="lbl">Build</span>
                    <span className="bm-trim" role="separator" tabIndex={0} aria-label="Resize Build" onPointerDown={(e) => trimCamera(e, 'build')} onKeyDown={(e) => keyTrim(e, 'build', tl.buildEnd - tl.intro)} />
                  </div>
                  <div className="nx-clip bm-cam bm-hero" style={{ left: X(buildEnd), width: Math.max(8, outroLength * px - 2) }} title="Drag either edge to adjust the build or ending duration">
                    <span className="bm-trim bm-trim-left" role="separator" tabIndex={0} aria-label="Resize Build at Hero start" onPointerDown={(e) => trimCamera(e, 'build')} onKeyDown={(e) => keyTrim(e, 'build', tl.buildEnd - tl.intro)} />
                    <span className="lbl">{tl.heroOrbit ? 'Hero orbit' : 'Hold'}</span>
                    <span className="bm-trim" role="separator" tabIndex={0} aria-label="Resize Hero/ending" onPointerDown={(e) => trimCamera(e, 'outro')} onKeyDown={(e) => keyTrim(e, 'outro', tl.duration - tl.buildEnd)} />
                  </div>
                  {trimPreview && trimPreview.kind !== 'step' && <span className="bm-resize-bubble" style={{ left: X(trimPreview.kind === 'intro' ? introEnd : trimPreview.kind === 'build' ? buildEnd : previewDuration) }}>{trimPreview.seconds.toFixed(1)}s</span>}
                </div>
              </div>
            )}
            {tl && (
              <div className={`nx-playhead ${mode === 'preview' || follow ? '' : 'bm-idle'}`} style={{ left: X(t) }}>
                <i onPointerDown={scrubFrom} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A small chip in the transport bar; its explanation opens under it on click. */
function TimelineNote({ id, open, onOpen, label, title, tone, children }: { id: string; open: string | null; onOpen(id: string | null): void; label: string; title?: string; tone?: 'warn'; children: React.ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const isOpen = open === id;
  useEffect(() => {
    if (!isOpen) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpen(null); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [isOpen, onOpen]);
  return (
    <span className="bm-tl-note-wrap" ref={ref}>
      <button className={`bm-tl-chip ${tone ?? ''} ${isOpen ? 'on' : ''}`} aria-expanded={isOpen} onClick={() => onOpen(isOpen ? null : id)}>
        <Ic name="info" /> {label}
      </button>
      <span className={`bm-tl-pop ${isOpen ? 'open' : ''}`} role="note" title={title}>{children}</span>
    </span>
  );
}
