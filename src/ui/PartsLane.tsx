import { useEffect, useState, type DragEvent as RDragEvent, type PointerEvent as RPointerEvent } from 'react';
import { dropTarget, pulledAhead, type PartClip } from '../anim/partClips';
import type { Timeline } from '../anim/timeline';
import { resolveColor } from '../ldraw/colors';
import { modelSteps, moveItemTo, setRootHint } from '../plan/ops';
import type { Step } from '../plan/types';
import { addPart } from '../state/editing';
import { getColors, partName } from '../state/partService';
import { usePlayback } from '../state/playback';
import { useStudio } from '../state/store';
import { Ic } from './icons';

export const PART_ROW = 20;
/** a clip is at least this wide so its part number stays readable */
export const PART_MIN_PX = 54;
const LANE_PAD = 4;
/** what the Parts panel puts on a dragged part tile */
export const PART_DRAG_TYPE = 'application/x-brickmotion-part';
const DRAG_START_PX = 4;

export const partsLaneHeight = (rows: number) => rows * PART_ROW + LANE_PAD * 2;

type Marker = { x: number; label: string; at: number };
/** How far the clips at the insertion point slide aside while a drag hovers over them. */
const OPEN_PX = 12;

/**
 * The last clip dropped, kept until the replanned timeline arrives (the lane is not
 * shown while the build is planned again): which pieces were put after it.
 */
let pendingDrop: { model: string; id: string; later: Set<string>; tl: Timeline } | null = null;

/**
 * One clip per piece of the open model, spanning its flight. Click to select a piece
 * (and jump there), drag a clip to change when it arrives — later in its step or into
 * another step — and drop a part from the Parts panel to add it at that moment.
 */
export function PartsLane({
  tl,
  steps,
  clips,
  rows,
  px,
  X,
  timeAt,
}: {
  tl: Timeline;
  steps: Step[];
  clips: PartClip[];
  rows: number;
  px: number;
  X: (s: number) => number;
  /** seconds under a viewport x (clientX) */
  timeAt: (clientX: number) => number;
}) {
  const selection = useStudio((s) => s.selection);
  const editingModel = useStudio((s) => s.editingModel);
  const selected = new Set(selection.model === editingModel ? selection.ids : []);
  const [drag, setDrag] = useState<{ ids: string[]; dx: number } | null>(null);
  const [marker, setMarker] = useState<Marker | null>(null);
  const [note, setNote] = useState<{ text: string; at: number; id: string } | null>(null);
  const colors = getColors();
  const st = useStudio.getState;
  const label = (c: PartClip) => c.submodel ?? c.part ?? 'piece';

  // A dropped clip can't always go where it was dropped: what it rests on, or needs
  // room from, is still built first. Say so instead of silently reshuffling.
  useEffect(() => {
    const drop = pendingDrop;
    if (!drop || drop.tl === tl || drop.model !== editingModel || !clips.some((c) => c.id === drop.id)) return;
    pendingDrop = null;
    const moved = clips.find((c) => c.id === drop.id)!;
    const ahead = pulledAhead(clips, drop.id, drop.later);
    if (!ahead.length) return setNote(null);
    const names = [...new Set(ahead.map(label))];
    const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    setNote({ text: `${label(moved)} can only go on after ${list}, so ${ahead.length === 1 ? 'that piece still comes' : 'those pieces still come'} first.`, at: moved.start, id: drop.id });
  }, [clips, editingModel, tl]);

  const markerAt = (t: number, skip?: string): { target: { step: number; index: number }; marker: Marker } | null => {
    const target = dropTarget(tl, steps, clips, t, skip);
    if (!target) return null;
    return { target, marker: { x: X(Math.max(0, t)), label: `Step ${target.step + 1} · #${target.index + 1}`, at: t } };
  };

  const select = (c: PartClip, additive: boolean) => {
    st().select([c.id], additive);
    // in the Build view, show the build at that moment rather than the step's layout
    if (st().mode === 'edit') useStudio.setState({ currentStep: c.step });
    else st().setCurrentStep(c.step);
    usePlayback.getState().set({ playing: false, t: c.start, follow: st().mode === 'edit' || usePlayback.getState().follow });
  };

  const onPointerDown = (e: RPointerEvent, c: PartClip) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    // Dragging a clip that is part of a multi-selection takes the whole selection, in the
    // order the step already has, so a shift-drag moves a group without shuffling it.
    const ids = selected.has(c.id) && selected.size > 1
      ? clips.filter((clip) => selected.has(clip.id)).map((clip) => clip.id)
      : [c.id];
    let moved = false;
    let last: ReturnType<typeof markerAt> = null;
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < DRAG_START_PX) return;
      moved = true;
      setDrag({ ids, dx: ev.clientX - x0 });
      last = markerAt(timeAt(ev.clientX), c.id);
      setMarker(last?.marker ?? null);
    };
    const up = (ev: PointerEvent) => {
      cleanup();
      if (!moved) return select(c, ev.shiftKey || ev.metaKey);
      if (!last) return;
      const { step, index } = last.target;
      usePlayback.getState().set({ playing: false });
      const model = st().editingModel;
      const before = st().plan;
      // a block keeps its own order: each piece goes in after the one before it
      st().apply((p) => {
        let next = p;
        ids.forEach((id, k) => { next = moveItemTo(next, model, id, step, index + k); });
        return next;
      });
      const after = st().plan;
      setNote(null);
      if (after !== before) {
        const pieces = modelSteps(after, model)[step]?.pieces ?? [];
        const k = pieces.findIndex((i) => i.id === c.id);
        if (k >= 0) {
          pendingDrop = { model, id: c.id, later: new Set(pieces.slice(k + 1).map((i) => i.id).filter((id): id is string => !!id)), tl };
        }
      }
      st().select(ids);
      st().setCurrentStep(step);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cleanup);
      document.body.style.userSelect = prevSelect;
      setDrag(null);
      setMarker(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cleanup);
  };

  // parts dragged in from the Parts panel
  const isPartDrag = (e: RDragEvent) => e.dataTransfer.types.includes(PART_DRAG_TYPE);
  const onDragOver = (e: RDragEvent) => {
    if (!isPartDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setMarker(markerAt(timeAt(e.clientX))?.marker ?? null);
  };
  const onDrop = (e: RDragEvent) => {
    if (!isPartDrag(e)) return;
    e.preventDefault();
    const part = e.dataTransfer.getData(PART_DRAG_TYPE);
    const at = markerAt(timeAt(e.clientX));
    setMarker(null);
    if (!part || !at) return;
    usePlayback.getState().set({ playing: false });
    st().setCurrentStep(at.target.step);
    void addPart(part, at.target);
  };

  return (
    <div
      className="nx-lane bm-parts-lane"
      style={{ height: partsLaneHeight(rows) }}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMarker(null);
      }}
      onDrop={onDrop}
      aria-label="Parts: when each piece arrives"
    >
      {clips.map((c) => {
        const code = c.color === undefined ? undefined : resolveColor(colors, c.color);
        const hex = code === undefined ? undefined : colors.get(code)?.hex;
        const name = c.submodel ? c.submodel : partName(c.part!);
        const dragging = drag?.ids.includes(c.id) ?? false;
        // the clips the drop would push back slide aside, so the gap it opens is visible
        const opens = !!marker && !dragging && c.start >= marker.at - 1e-6;
        return (
          <button
            key={c.id}
            className={`bm-part-clip ${selected.has(c.id) ? 'sel' : ''} ${c.submodel ? 'sub' : ''} ${dragging ? 'dragging' : ''}`}
            style={{
              left: X(c.start) + (dragging ? drag!.dx : opens ? OPEN_PX : 0),
              top: LANE_PAD + c.row * PART_ROW,
              width: Math.max(PART_MIN_PX - 2, (c.end - c.start) * px - 1),
            }}
            title={`${name}${c.part ? ` (${c.part})` : ''} — step ${c.step + 1}, #${c.index + 1}, ${c.start.toFixed(1)}–${c.end.toFixed(1)} s. Click to select, drag to change when it arrives.`}
            aria-label={`${name}, step ${c.step + 1}, piece ${c.index + 1}`}
            aria-pressed={selected.has(c.id)}
            onPointerDown={(e) => onPointerDown(e, c)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                select(c, e.shiftKey);
              }
            }}
          >
            {c.submodel ? <Ic name="box" /> : <i className="bm-part-dot" style={{ background: hex ?? 'var(--line2)' }} />}
            <span className="lbl">{c.submodel ?? c.part}</span>
          </button>
        );
      })}
      {clips.length === 0 && <span className="nx-hint bm-empty">Drop parts here from the Parts panel.</span>}
      {note && !marker && (
        <span className="bm-part-note" role="status" style={{ left: X(note.at) }}>
          {note.text}
          <button
            type="button"
            className="bm-part-note-force"
            title="Take the placement as correct: this piece is marked as its own foundation, so the planner stops requiring what it thinks has to be built first — the animation then keeps your order."
            onClick={() => {
              const model = st().editingModel;
              st().apply((p) => setRootHint(p, model, [note.id], true));
              setNote(null);
            }}
          >
            Force order
          </button>
          <button type="button" aria-label="Dismiss" onClick={() => setNote(null)}><Ic name="x" /></button>
        </span>
      )}
      {marker && (
        <>
          <span className="bm-part-drop" style={{ left: marker.x }} aria-hidden="true" />
          <span className="bm-part-marker" style={{ left: marker.x }}>
            <b>{drag && drag.ids.length > 1 ? `${drag.ids.length} pieces → ` : ''}{marker.label}</b>
          </span>
        </>
      )}
    </div>
  );
}
