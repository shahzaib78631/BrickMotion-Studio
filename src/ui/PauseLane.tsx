/**
 * The Pause lane of the Build timeline: a block freezes the build for its length (parts stop
 * where they are, even in mid-flight) while the video, and the Camera lane with it, keeps going.
 * Double-click the lane or use its menu to add one, drag a block's right edge to lengthen it.
 */
import { useState, type PointerEvent as RPointerEvent } from 'react';
import { MAX_PAUSE, MIN_PAUSE } from '../anim/pauses';
import { addPause, pausesOf, removePause, setPauseLength } from '../plan/pauseOps';
import { usePlayback } from '../state/playback';
import { useStudio } from '../state/store';
import type { ContextItem } from './ContextMenu';
import { Ic } from './icons';

const LENGTHS = [0.5, 1, 2, 3, 5, 10];
const DEFAULT_LEN = 1;
const round = (n: number) => Math.round(n * 10) / 10;
const stop = () => usePlayback.getState().set({ playing: false });

type Props = {
  duration: number; px: number; laneHeight: number;
  X(t: number): number; timeAt(clientX: number): number;
  openMenu(x: number, y: number, label: string, items: ContextItem[]): void;
};

export function PauseLane({ duration, px, laneHeight, X, timeAt, openMenu }: Props) {
  const model = useStudio((s) => s.editingModel);
  const stored = useStudio((s) => s.plan.pauses?.[model]);
  const pauses = pausesOf({ pauses: { [model]: stored ?? [] } } as never, model);
  const [draft, setDraft] = useState<{ id: string; len: number } | null>(null);
  const st = useStudio.getState;

  const add = (at: number, len = DEFAULT_LEN) => {
    stop();
    const r = addPause(st().plan, model, Math.max(0, Math.min(duration, at)), len);
    st().apply(() => r.plan);
  };
  const resize = (id: string, len: number) => { stop(); st().apply((p) => setPauseLength(p, model, id, len)); };

  const laneMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const at = timeAt(e.clientX);
    const t = usePlayback.getState().t;
    openMenu(e.clientX, e.clientY, 'Pause lane menu', [
      { heading: 'Freeze the build' },
      { icon: 'pause', label: `Pause here (${DEFAULT_LEN} s)`, onClick: () => add(at) },
      { icon: 'pause', label: 'Pause at the playhead', items: LENGTHS.map((len) => ({ icon: 'pause' as const, label: `${len} s`, onClick: () => add(t, len) })) },
    ]);
  };
  const blockMenu = (e: React.MouseEvent, id: string, len: number) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, 'Pause menu', [
      { heading: `Pause · ${len.toFixed(1)} s` },
      { icon: 'pause', label: 'Length', items: LENGTHS.map((l) => ({ icon: (l === len ? 'check' : 'pause') as 'check' | 'pause', label: `${l} s`, current: l === len, onClick: () => resize(id, l) })) },
      'sep',
      { icon: 'trash', label: 'Delete pause', danger: true, onClick: () => { stop(); st().apply((p) => removePause(p, model, id)); } },
    ]);
  };

  const beginResize = (e: RPointerEvent, id: string, start: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    stop();
    const x0 = e.clientX;
    let next = start;
    const move = (ev: PointerEvent) => {
      next = round(Math.min(MAX_PAUSE, Math.max(MIN_PAUSE, start + (ev.clientX - x0) / px)));
      setDraft({ id, len: next });
    };
    const done = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      setDraft(null);
      if (next !== start) resize(id, next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  };

  return (
    <div className="nx-lane bm-pauselane" style={{ height: laneHeight }}
      onContextMenu={laneMenu}
      onDoubleClick={(e) => { e.preventDefault(); add(timeAt(e.clientX)); }}
      title="Double-click to freeze the build here while the camera keeps moving">
      {pauses.map((p) => {
        const len = draft?.id === p.id ? draft.len : p.len;
        return (
          <div key={p.id} className="nx-clip bm-pause" role="group" tabIndex={0}
            style={{ left: X(p.at), width: Math.max(10, len * px - 2) }}
            aria-label={`Pause at ${p.at.toFixed(1)} s for ${len.toFixed(1)} s`}
            title={`The build is frozen for ${len.toFixed(1)} s. Drag the right edge to change it; right-click for more.`}
            onClick={() => usePlayback.getState().set({ t: Math.min(duration, p.at + 0.001) })}
            onDoubleClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => blockMenu(e, p.id, p.len)}
            onKeyDown={(e) => {
              if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); stop(); st().apply((pl) => removePause(pl, model, p.id)); }
              else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); resize(p.id, round(p.len + (e.key === 'ArrowRight' ? 0.1 : -0.1))); }
            }}>
            <span className="av"><Ic name="pause" /></span>
            <span className="lbl">{len.toFixed(1)} s</span>
            <span className="bm-trim" role="separator" tabIndex={-1} aria-label="Resize pause" onPointerDown={(e) => beginResize(e, p.id, p.len)} />
          </div>
        );
      })}
      {!pauses.length && <span className="nx-hint bm-empty">Double-click to pause the build here, the camera keeps moving.</span>}
    </div>
  );
}
