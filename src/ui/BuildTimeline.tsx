import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { StepSpan, Timeline } from '../anim/timeline';
import { modelSteps } from '../plan/ops';
import { usePlayback } from '../state/playback';
import { useStudio } from '../state/store';
import { Ic } from './icons';

const RULER = 30;
const LANE = 42;
const PAD = 24;

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
export function BuildTimeline({ timeline: tl }: { timeline: Timeline | null }) {
  const t = usePlayback((s) => s.t);
  const playing = usePlayback((s) => s.playing);
  const plan = useStudio((s) => s.plan);
  const mode = useStudio((s) => s.mode);
  const currentStep = useStudio((s) => s.currentStep);
  const editingModel = useStudio((s) => s.editingModel);
  const st = useStudio.getState;
  const pb = usePlayback.getState;
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(900);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 900));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dur = tl?.duration ?? 0;
  const px = (dur > 0 ? Math.max(20, (width - PAD * 2) / dur) : 60) * zoom;
  const X = (s: number) => PAD + s * px;
  const seek = (s: number) => pb().set({ t: Math.max(0, Math.min(dur, s)) });

  const editStep = (span: StepSpan) => {
    if (st().editingModel !== '') st().setEditingModel('');
    st().setCurrentStep(span.index);
    seek(span.start);
  };
  const jump = (dir: 1 | -1) => {
    if (!tl) return;
    const list = mainSteps(tl);
    const target = dir > 0 ? list.find((s) => s.start > t + 1e-3) : [...list].reverse().find((s) => s.start < t - 0.05);
    if (!target) return seek(dir > 0 ? dur : 0);
    if (st().mode === 'edit') editStep(target);
    else seek(target.start);
  };
  const togglePlay = () => {
    if (!tl) return;
    if (playing) return pb().set({ playing: false });
    if (st().mode !== 'preview') st().setMode('preview');
    pb().set({ t: t >= dur - 1e-3 ? 0 : t, playing: true });
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

  const scrubFrom = (e: RPointerEvent<HTMLDivElement>) => {
    if (!tl) return;
    const el = scrollRef.current!;
    const at = (clientX: number) => (clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD) / px;
    pb().set({ playing: false });
    if (st().mode !== 'preview') st().setMode('preview');
    seek(at(e.clientX));
    const move = (ev: PointerEvent) => seek(at(ev.clientX));
    const up = () => (window.removeEventListener('pointermove', move), window.removeEventListener('pointerup', up));
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const steps = modelSteps(plan, '');
  const step = tl ? tickStep(px) : 1;
  const ticks = tl ? Array.from({ length: Math.floor(dur / step) + 1 }, (_, i) => i * step) : [];
  const contentWidth = X(dur) + PAD;

  return (
    <div className="nx-timeline bm-timeline">
      <div className="nx-transport">
        <div className="nx-tr-left">
          <span className="nx-tc">
            <b>{timecode(t)}</b> / {timecode(dur)}
          </span>
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
          <button className="nx-icon" aria-label="Zoom out" title="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>
            <Ic name="zoomOut" />
          </button>
          <span className="nx-zoom">{Math.round(zoom * 100)}%</span>
          <button className="nx-icon" aria-label="Zoom in" title="Zoom in" disabled={zoom >= 16} onClick={() => setZoom((z) => Math.min(16, z * 1.5))}>
            <Ic name="zoomIn" />
          </button>
          <button className="nx-icon" aria-label="Fit timeline" title="Fit the whole video" onClick={() => setZoom(1)}>
            <Ic name="widen" />
          </button>
        </div>
      </div>
      <div className="nx-tracks">
        <div className="nx-heads">
          {(
            [
              ['steps', 'Steps'],
              ['box', 'Submodels'],
              ['camera', 'Camera'],
            ] as const
          ).map(([icon, label]) => (
            <div key={label} className="nx-head-row" style={{ height: LANE }}>
              <Ic name={icon} />
              <span>{label}</span>
            </div>
          ))}
        </div>
        <div className="nx-scroll" ref={scrollRef}>
          <div className="nx-content" style={{ width: contentWidth }}>
            <div
              className="nx-ruler bm-ruler"
              style={{ width: contentWidth }}
              onPointerDown={scrubFrom}
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
            {!tl ? (
              <p className="nx-hint bm-empty">Loading…</p>
            ) : (
              <div className="nx-lanes">
                <div className="nx-lane" style={{ height: LANE }}>
                  {tl.steps
                    .filter((s) => s.model === '')
                    .map((s, i) => {
                      const sel = editingModel === '' && currentStep === s.index;
                      const count = steps[s.index]?.pieces.length ?? 0;
                      return (
                        <button
                          key={i}
                          className={`nx-clip bm-step ${sel ? 'sel' : ''}`}
                          style={{ left: X(s.start), width: Math.max(6, (s.end - s.start) * px - 2) }}
                          aria-label={`Step ${s.index + 1} · ${count} piece${count === 1 ? '' : 's'}`}
                          title={`Step ${s.index + 1}: ${count} piece${count === 1 ? '' : 's'}. Click to edit it.`}
                          onClick={() => editStep(s)}
                        >
                          <span className="lbl">Step {s.index + 1}</span>
                        </button>
                      );
                    })}
                  {tl.steps.length === 0 && <span className="nx-hint bm-empty">Add pieces and the steps show up here.</span>}
                </div>
                <div className="nx-lane" style={{ height: LANE }}>
                  {tl.subBuilds.map((b) => (
                    <button
                      key={b.key}
                      className={`nx-clip bm-sub ${editingModel === b.name ? 'sel' : ''}`}
                      style={{ left: X(b.start), width: Math.max(6, (b.attachEnd - b.start) * px - 2) }}
                      aria-label={`Build ${b.name}, attach at ${b.attachStart.toFixed(1)} s`}
                      title={`${b.name}: built aside, attached at ${b.attachStart.toFixed(1)} s. Click to edit it.`}
                      onClick={() => {
                        st().setEditingModel(b.name);
                        seek(b.start);
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
                  <span className="nx-clip bm-cam dim" style={{ left: X(0), width: Math.max(4, tl.intro * px - 2) }}>
                    <span className="lbl">Intro</span>
                  </span>
                  <span className="nx-clip bm-cam" style={{ left: X(tl.intro), width: Math.max(4, (tl.buildEnd - tl.intro) * px - 2) }}>
                    <span className="lbl">Build</span>
                  </span>
                  <span className="nx-clip bm-cam bm-hero" style={{ left: X(tl.buildEnd), width: Math.max(4, (dur - tl.buildEnd) * px - 2) }}>
                    <span className="lbl">{tl.heroOrbit ? 'Hero orbit' : 'Hold'}</span>
                  </span>
                </div>
              </div>
            )}
            {tl && (
              <div className={`nx-playhead ${mode === 'preview' ? '' : 'bm-idle'}`} style={{ left: X(t) }}>
                <i onPointerDown={scrubFrom} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
