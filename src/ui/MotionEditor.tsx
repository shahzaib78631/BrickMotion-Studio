import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MOTION_EASES, MOTION_LIMITS } from '../anim/motionStyle';
import { modelSteps, setItemsMotion, setPlanMotion, setStepMotion, findItem } from '../plan/ops';
import type { MotionEase, MotionStyle } from '../plan/types';
import { useStudio } from '../state/store';
import { Ic } from './icons';

/** What a motion editor changes: the whole project, one step, or some pieces. */
export type MotionTarget =
  | { kind: 'project' }
  | { kind: 'step'; model: string; index: number }
  | { kind: 'pieces'; model: string; ids: string[] };

/** The style stored on the target itself (not inherited), and what it inherits. */
export function motionOf(target: MotionTarget): { own: MotionStyle; inherited: MotionStyle; title: string } {
  const { plan } = useStudio.getState();
  const project = plan.motion ?? {};
  if (target.kind === 'project') return { own: project, inherited: {}, title: 'Motion · whole build' };
  if (target.kind === 'step') {
    const step = modelSteps(plan, target.model)[target.index];
    return { own: step?.motion ?? {}, inherited: project, title: `Motion · step ${target.index + 1}` };
  }
  const first = findItem(plan, target.model, target.ids[0]);
  const step = first ? modelSteps(plan, target.model)[first.step] : undefined;
  return {
    own: first?.item.assembly?.motion ?? {},
    inherited: { ...project, ...(step?.motion ?? {}) },
    title: target.ids.length === 1 ? 'Motion · this piece' : `Motion · ${target.ids.length} pieces`,
  };
}

export function hasOwnMotion(target: MotionTarget): boolean {
  return Object.keys(motionOf(target).own).length > 0;
}

export function saveMotion(target: MotionTarget, style: MotionStyle | null): void {
  const st = useStudio.getState();
  st.apply((p) =>
    target.kind === 'project' ? setPlanMotion(p, style)
      : target.kind === 'step' ? setStepMotion(p, target.model, target.index, style)
        : setItemsMotion(p, target.model, target.ids, style));
}

/** Automatic values, as the planner leaves them. */
const AUTO = { time: 1, landing: 0.24, hover: 0 };

const PRESETS: { label: string; style: MotionStyle }[] = [
  { label: 'Default', style: {} },
  { label: 'Gentle', style: { time: 1.5, landing: 0.4, ease: 'gentle' } },
  { label: 'Careful', style: { time: 2, landing: 0.5, hover: 0.12, ease: 'soft' } },
  { label: 'Quick', style: { time: 0.7, landing: 0.2 } },
];

/**
 * A small floating panel to set how pieces fly in: flight time, how long they take to
 * seat, a pause just above the seat and the easing. Each change applies at once (one
 * undo step per change) and needs no new planning.
 */
export function MotionEditor({ x, y, target, onClose }: { x: number; y: number; target: MotionTarget; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const plan = useStudio((s) => s.plan); // re-render on undo/redo
  void plan;
  const { own, inherited, title } = motionOf(target);
  const value = { ...AUTO, ...inherited, ...own } as Required<Pick<MotionStyle, 'time' | 'landing' | 'hover'>> & MotionStyle;

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y]);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', away);
    // capture: editor shortcuts handle Escape (clear selection) before it bubbles here
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc, true); };
  }, [onClose]);

  const set = (patch: MotionStyle) => saveMotion(target, { ...own, ...patch });
  // a slider shows its value while dragging and saves once, on release (one undo step)
  const [draft, setDraft] = useState<Partial<Record<'time' | 'landing' | 'hover', number>>>({});
  const commit = (key: 'time' | 'landing' | 'hover') => {
    const v = draft[key];
    if (v === undefined) return;
    setDraft(({ [key]: _done, ...rest }) => rest);
    if (v !== value[key] || own[key] === undefined) set({ [key]: v });
  };
  const clear = (key: keyof MotionStyle) => {
    const { [key]: _gone, ...rest } = own;
    saveMotion(target, rest);
  };
  const slider = (key: 'time' | 'landing' | 'hover', label: string, help: string, format: (v: number) => string, step: number) => {
    const r = MOTION_LIMITS[key];
    const isOwn = own[key] !== undefined || draft[key] !== undefined;
    return (
      <label className={`bm-motion-row ${isOwn ? 'own' : ''}`} title={help}>
        <span className="bm-motion-label">{label}</span>
        <input type="range" min={r.min} max={r.max} step={step} value={draft[key] ?? value[key]}
          onChange={(e) => { const v = Number(e.target.value); setDraft((d) => ({ ...d, [key]: v })); }}
          onPointerUp={() => commit(key)} onKeyUp={() => commit(key)} onBlur={() => commit(key)} aria-label={label} />
        <output>{format(draft[key] ?? value[key])}</output>
        <button type="button" className="nx-icon bm-motion-reset" aria-label={`Reset ${label}`} title={isOwn ? 'Use the inherited value' : 'Inherited'}
          disabled={!isOwn} onClick={(e) => { e.preventDefault(); clear(key); }}>
          <Ic name="x" />
        </button>
      </label>
    );
  };

  return (
    <div ref={ref} className="bm-motion-pop" role="dialog" aria-label={title} style={pos}>
      <header>
        <b>{title}</b>
        <button type="button" className="nx-icon" aria-label="Close" onClick={onClose}><Ic name="x" /></button>
      </header>
      <div className="bm-motion-presets" role="group" aria-label="Presets">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="nx-btn nx-sm"
            onClick={() => saveMotion(target, Object.keys(p.style).length ? p.style : null)}>{p.label}</button>
        ))}
      </div>
      {slider('time', 'Flight time', 'How long each flight takes, relative to the automatic pacing. Slower flights make the video longer.', (v) => `${v.toFixed(2)}×`, 0.05)}
      {slider('landing', 'Landing', 'Share of the flight spent easing down into place. Higher is a slower, softer seat.', (v) => `${Math.round(v * 100)}%`, 0.01)}
      {slider('hover', 'Hover', 'Share of the flight spent pausing just above the spot before seating.', (v) => `${Math.round(v * 100)}%`, 0.01)}
      <label className={`bm-motion-row ${own.ease ? 'own' : ''}`}>
        <span className="bm-motion-label">Easing</span>
        <select value={value.ease ?? 'smooth'} onChange={(e) => set({ ease: e.target.value as MotionEase })} aria-label="Easing">
          {MOTION_EASES.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
        </select>
        <span />
        <button type="button" className="nx-icon bm-motion-reset" aria-label="Reset easing" disabled={!own.ease}
          onClick={(e) => { e.preventDefault(); clear('ease'); }}><Ic name="x" /></button>
      </label>
      <footer>
        <span className="nx-fine">{target.kind === 'project' ? 'Steps and pieces can override this.' : 'Highlighted values are set here; others are inherited.'}</span>
        <button type="button" className="nx-btn nx-sm" disabled={!Object.keys(own).length} onClick={() => saveMotion(target, null)}>Reset all</button>
      </footer>
    </div>
  );
}
