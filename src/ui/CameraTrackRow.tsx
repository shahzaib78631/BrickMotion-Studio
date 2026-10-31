/**
 * The Camera row of a timeline: a diamond per camera key, a bar per move between keys
 * (named by its preset) and a Lens lane that marks lens changes. Plus the toolbar actions
 * for the row: Auto-direct, Key from view, Update key from view and Delete.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { selectedKeyIds, useStudio } from '../state/store';
import { useAppSettings } from '../state/appSettings';
import { cameraPoseToKey } from '../anim/cameraTrack/context';
import { addCameraKey, choosePreset, deleteCameraKey, deleteCameraKeys, moveCameraKey, moveCameraKeys, trackOf, updateCameraKey, type TrackRef } from '../anim/cameraTrack/ops';
import { usePlayback } from '../state/playback';
import { useKeyframePlayback } from '../state/keyframePlayback';
import { animationOf } from '../anim/keyframes';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { BUILT_IN_PRESETS, presetById, type TransitionPreset } from '../anim/cameraTrack/presets';
import type { CameraClock, CameraTrack, CameraTransition, DirectorStyle } from '../anim/cameraTrack/types';
import { viewportApi } from './viewportApi';
import { Ic } from './icons';
import './cameraTrack.css';

const MENU_WIDTH = 320;
/** below the button when about this much fits there; otherwise wherever there is more room */
const MENU_NEED = 380;

/** Where a menu under (or over) a button goes so it stays inside the window; it scrolls past maxHeight. */
export function placeMenu(anchor: Pick<DOMRect, 'left' | 'top' | 'bottom'>, viewH: number, viewW: number, width = MENU_WIDTH):
  { left: number; top?: number; bottom?: number; maxHeight: number } {
  const GAP = 6, MARGIN = 8;
  const left = Math.max(MARGIN, Math.min(anchor.left, viewW - width - MARGIN));
  const below = viewH - anchor.bottom - GAP - MARGIN, above = anchor.top - GAP - MARGIN;
  if (below >= MENU_NEED || below >= above) return { left, top: anchor.bottom + GAP, maxHeight: below };
  return { left, bottom: viewH - anchor.top + GAP, maxHeight: above };
}

const EMPTY_PRESETS: readonly TransitionPreset[] = [];

/** The editing model's track on a clock, read reactively. */
export function useCameraTrack(clock: CameraClock): { ref: TrackRef; track: CameraTrack | undefined } {
  const model = useStudio((s) => s.editingModel);
  const track = useStudio((s) => s.plan.cameraTracks?.[model]?.[clock]);
  return { ref: { model, clock }, track };
}

/** What a move looks like on the row: its colour family. */
function moveKind(tr: CameraTransition): 'cut' | 'quick' | 'flow' | 'hold' | 'smooth' {
  const s = tr.settings;
  if (s.cut) return 'cut';
  if (s.flowThrough) return 'flow';
  if (s.curve.kind === 'holdThenMove') return 'hold';
  if (s.curve.kind === 'snap' || s.motionBlur >= 0.8) return 'quick';
  return 'smooth';
}

const fmt = (t: number) => `${t.toFixed(2)} s`;

type LaneProps = {
  clock: CameraClock; duration: number; fps: number; laneHeight: number;
  /** seconds → x in the scrolling lane, and back from a pointer's clientX */
  toX(t: number): number; toT(clientX: number): number;
  userPresets?: readonly TransitionPreset[];
};

/** The Camera lane and the Lens lane, for inside a timeline's scrolling lanes. */
export function CameraTrackLanes({ clock, duration, fps, laneHeight, toX, toT, userPresets }: LaneProps) {
  const saved = useAppSettings((s) => s.cameraPresets) ?? EMPTY_PRESETS;
  const presets = userPresets ?? saved;
  const { ref, track } = useCameraTrack(clock);
  const sel = useStudio((s) => s.cameraSelection);
  const keys = track?.keys ?? [];
  /** keys being dragged, and by how many seconds (the grabbed key shows its time) */
  const [drag, setDrag] = useState<{ ids: string[]; grabbed: string; dt: number } | null>(null);
  /** the box being dragged across the empty lane, in lane x */
  const [box, setBox] = useState<{ x0: number; x1: number } | null>(null);
  const chosen = selectedKeyIds(sel, clock);
  /** a click on a key that a pointer press has already handled */
  const pressed = useRef(false);
  /** the click a browser sends after a box-select released on a move bar */
  const boxed = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number; label: string; items: ContextItem[] } | null>(null);
  const st = useStudio.getState;
  const sensorMm = useAppSettings((s) => s.camera?.sensorWidthMm ?? 36);

  /** moves this clock's playhead to t seconds */
  const seek = (t: number) => {
    if (clock === 'build') usePlayback.getState().set({ t, playing: false });
    else {
      const a = animationOf(st().plan.animation);
      useKeyframePlayback.getState().set({ frame: Math.round(a.startFrame + t * a.fps), playing: false });
    }
  };
  const addKeyAt = (t: number) => {
    const key = keyFromView(t, sensorMm);
    if (!key) return;
    const before = new Set(trackOf(st().plan, ref)?.keys.map((k) => k.id));
    st().apply((p) => addCameraKey(p, ref, key, fps, duration));
    const added = trackOf(st().plan, ref)?.keys.find((k) => !before.has(k.id));
    if (added) st().selectCamera({ kind: 'key', clock, id: added.id });
  };
  const keyMenu = (e: React.MouseEvent, k: { id: string; t: number }) => {
    e.preventDefault(); e.stopPropagation();
    if (chosen.length > 1 && chosen.includes(k.id)) {
      const ids = chosen, n = ids.length;
      return setMenu({ x: e.clientX, y: e.clientY, label: 'Camera keys menu', items: [
        { heading: `${n} camera keys` },
        { icon: 'edit', label: `Edit ${n} keys in the Inspector`, onClick: () => choose(ids, k.id) },
        { icon: 'check', label: 'Select all camera keys', hint: '⌘A', onClick: selectAll },
        'sep',
        { icon: 'trash', label: `Delete ${n} camera keys`, hint: 'Delete', danger: true, onClick: () => removeKeys(ids) },
      ] });
    }
    selectKey(k.id);
    setMenu({ x: e.clientX, y: e.clientY, label: 'Camera key menu', items: [
      { heading: `Camera key at ${fmt(k.t)}` },
      { icon: 'play', label: 'Go to this key', onClick: () => seek(k.t) },
      { icon: 'edit', label: 'Edit in the Inspector', onClick: () => selectKey(k.id) },
      { icon: 'camera', label: 'Update key from view', hint: 'uses the viewport\'s current view', onClick: () => {
        const key = keyFromView(k.t, sensorMm);
        if (key) st().apply((p) => updateCameraKey(p, ref, k.id, { ...key, t: k.t }));
      } },
      'sep',
      { icon: 'check', label: 'Select all camera keys', hint: '⌘A', onClick: selectAll },
      'sep',
      { icon: 'trash', label: 'Delete camera key', hint: 'Delete', danger: true, onClick: () => removeKeys([k.id]) },
    ] });
  };
  const moveMenu = (e: React.MouseEvent, tr: CameraTransition) => {
    e.preventDefault(); e.stopPropagation();
    st().selectCamera({ kind: 'transition', clock, id: tr.from });
    const choose = (p: TransitionPreset) => () => st().apply((plan) => choosePreset(plan, ref, tr.from, p, viewDistance()));
    const item = (p: TransitionPreset) => ({ icon: 'video' as const, label: p.label, current: p.id === tr.preset, onClick: choose(p) });
    setMenu({ x: e.clientX, y: e.clientY, label: 'Camera move menu', items: [
      { heading: presetById(tr.preset, presets).label },
      { icon: 'edit', label: 'Edit move in the Inspector', onClick: () => st().selectCamera({ kind: 'transition', clock, id: tr.from }) },
      { icon: 'wand', label: 'Change move to', items: [
        ...BUILT_IN_PRESETS.map(item),
        ...(presets.length ? [{ heading: 'Saved' }, ...presets.map(item)] : []),
      ] },
    ] });
  };
  const laneMenu = (e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    const t = Math.min(duration, Math.max(0, toT(e.clientX)));
    setMenu({ x: e.clientX, y: e.clientY, label: 'Camera lane menu', items: [
      { heading: `Camera at ${fmt(t)}` },
      { icon: 'plus', label: 'Add camera key here', hint: 'from the viewport\'s view', onClick: () => addKeyAt(t) },
      ...(keys.length ? [{ icon: 'check' as const, label: 'Select all camera keys', onClick: selectAll }] : []),
    ] });
  };

  const selectKey = (id: string) => st().selectCamera({ kind: 'key', clock, id });
  const isSel = (kind: 'key' | 'transition', id: string) => sel?.clock === clock && sel.kind === kind && sel.id === id;

  const choose = (ids: string[], last: string) =>
    st().selectCamera(ids.length ? { kind: 'key', clock, id: last, ...(ids.length > 1 ? { ids } : {}) } : null);
  /** a click on a key: Shift picks the range from the last key clicked, Cmd/Ctrl adds or drops it */
  const clickKey = (id: string, mods: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (mods.shiftKey && sel?.kind === 'key' && sel.clock === clock) {
      const ta = keys.find((k) => k.id === sel.id)?.t, tb = keys.find((k) => k.id === id)?.t;
      if (ta !== undefined && tb !== undefined) {
        const [lo, hi] = ta < tb ? [ta, tb] : [tb, ta];
        const range = keys.filter((k) => k.t >= lo - 1e-9 && k.t <= hi + 1e-9).map((k) => k.id);
        return choose([...new Set([...chosen, ...range])].sort((x, y) => keys.findIndex((k) => k.id === x) - keys.findIndex((k) => k.id === y)), id);
      }
    }
    if (mods.metaKey || mods.ctrlKey) {
      const next = chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id];
      return choose(next, next.includes(id) ? id : next[next.length - 1] ?? id);
    }
    selectKey(id);
  };
  const selectAll = () => choose(keys.map((k) => k.id), keys[keys.length - 1]?.id ?? '');

  const startDrag = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    pressed.current = true;
    if (e.shiftKey || e.metaKey || e.ctrlKey) return clickKey(id, e);
    // a key among several chosen drags them all; any other key is chosen alone
    const group = chosen.length > 1 && chosen.includes(id) ? chosen : [id];
    if (group.length === 1) selectKey(id);
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture?.(e.pointerId); } catch { /* the pointer was already released: nothing to capture */ }
    const x0 = e.clientX;
    const times = keys.filter((k) => group.includes(k.id)).map((k) => k.t);
    const lo = -Math.min(...times), hi = duration - Math.max(...times);
    const shiftAt = (cx: number) => Math.min(hi, Math.max(lo, toT(cx) - toT(x0)));
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      setDrag({ ids: group, grabbed: id, dt: shiftAt(ev.clientX) });
    };
    const onUp = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      setDrag(null);
      // a plain click on one of several chosen keys chooses it alone
      if (!moved) return group.length > 1 ? selectKey(id) : undefined;
      const dt = shiftAt(ev.clientX);
      const t = keys.find((k) => k.id === id)!.t;
      st().apply((p) => group.length > 1 ? moveCameraKeys(p, ref, group, dt, fps, duration) : moveCameraKey(p, ref, id, t + dt, fps, duration));
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  };

  /** dragging across the lane chooses the keys inside (Shift/Cmd adds to the choice) */
  const startBox = (e: React.PointerEvent<HTMLElement>) => {
    // starts on the empty lane or on a move bar (a plain click on a bar still picks the move)
    const on = e.target as HTMLElement;
    if (e.button !== 0 || (on !== e.currentTarget && !on.closest('.bm-cammove'))) return;
    const add = e.shiftKey || e.metaKey || e.ctrlKey;
    const before = add ? chosen : [];
    const t0 = toT(e.clientX);
    let moved = false;
    const pick = (cx: number) => {
      const [lo, hi] = [Math.min(t0, toT(cx)), Math.max(t0, toT(cx))];
      return keys.filter((k) => k.t >= lo && k.t <= hi).map((k) => k.id);
    };
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(toX(toT(ev.clientX)) - toX(t0)) < 3) return;
      moved = true;
      setBox({ x0: toX(t0), x1: toX(toT(ev.clientX)) });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setBox(null);
      if (!moved) { if (!add && sel?.clock === clock) st().selectCamera(null); return; }
      boxed.current = true;
      setTimeout(() => { boxed.current = false; }, 0);
      const ids = [...new Set([...before, ...pick(ev.clientX)])];
      choose(ids, ids[ids.length - 1] ?? '');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const removeKeys = (ids: string[]) => {
    st().apply((p) => (ids.length > 1 ? deleteCameraKeys(p, ref, ids) : deleteCameraKey(p, ref, ids[0])));
    st().selectCamera(null);
  };
  const onKey = (e: React.KeyboardEvent, id: string, t: number) => {
    const group = chosen.length > 1 && chosen.includes(id) ? chosen : [id];
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeKeys(group);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = ((e.shiftKey ? 10 : 1) / fps) * (e.key === 'ArrowLeft' ? -1 : 1);
      st().apply((p) => (group.length > 1 ? moveCameraKeys(p, ref, group, step, fps, duration) : moveCameraKey(p, ref, id, t + step, fps, duration)));
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll();
    }
  };

  const timeOf = (id: string, t: number) => (drag?.ids.includes(id) ? t + drag.dt : t);
  // lens marks: the first key, then wherever the lens, focus or blur changes
  const focusOf = (f: number | 'target') => (f === 'target' ? 0.5 : f);
  const lensMarks = keys.filter((k, i) => i === 0 || Math.abs(k.lensMm - keys[i - 1].lensMm) > 0.5
    || Math.abs(focusOf(k.focus) - focusOf(keys[i - 1].focus)) > 1e-3 || Math.abs(k.blur - keys[i - 1].blur) > 1e-3);

  return (
    <>
      <div className="nx-lane bm-camtrack" style={{ height: laneHeight }} onContextMenu={laneMenu} onPointerDown={startBox}>
        {(track?.transitions ?? []).map((tr) => {
          const a = keys.find((k) => k.id === tr.from), b = keys.find((k) => k.id === tr.to);
          if (!a || !b) return null;
          const x0 = toX(timeOf(a.id, a.t)), x1 = toX(timeOf(b.id, b.t));
          const label = presetById(tr.preset, presets).label;
          return (
            <button key={`${tr.from}>${tr.to}`} type="button"
              className={`bm-cammove k-${moveKind(tr)} ${tr.origin === 'auto' ? 'auto' : ''} ${isSel('transition', tr.from) ? 'sel' : ''}`}
              style={{ left: Math.min(x0, x1) + 6, width: Math.max(4, Math.abs(x1 - x0) - 12) }}
              aria-label={`${label}, ${fmt(a.t)} to ${fmt(b.t)}`}
              title={`${label} — click to change how the camera gets to the next shot`}
              onClick={(e) => { e.stopPropagation(); if (boxed.current) { boxed.current = false; return; } st().selectCamera({ kind: 'transition', clock, id: tr.from }); }}
              onContextMenu={(e) => moveMenu(e, tr)}>
              <span className="lbl">{label}</span>
            </button>
          );
        })}
        {keys.map((k) => (
          <button key={k.id} type="button"
            className={`bm-camkey ${k.origin === 'auto' ? 'auto' : ''} ${chosen.includes(k.id) ? 'sel' : ''}`}
            style={{ left: toX(timeOf(k.id, k.t)) }}
            aria-label={`Camera key at ${fmt(k.t)}`}
            title={`Camera key at ${fmt(k.t)}${k.origin === 'auto' ? ' (automatic)' : ''} — drag to move, Delete to remove, right-click for more`}
            onPointerDown={(e) => startDrag(e, k.id)}
            onClick={(e) => { e.stopPropagation(); if (pressed.current) { pressed.current = false; return; } clickKey(k.id, e); }}
            onKeyDown={(e) => onKey(e, k.id, k.t)}
            onContextMenu={(e) => keyMenu(e, k)} />
        ))}
        {drag && (() => {
          const k = keys.find((x) => x.id === drag.grabbed);
          const at = k ? k.t + drag.dt : 0;
          return <span className="bm-resize-bubble" style={{ left: toX(at) }}>{at.toFixed(2)}s{drag.ids.length > 1 ? ` · ${drag.ids.length} keys` : ''}</span>;
        })()}
        {box && <span className="bm-cam-box" style={{ left: Math.min(box.x0, box.x1), width: Math.abs(box.x1 - box.x0) }} />}
      </div>
      {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} items={menu.items} label={menu.label} onClose={() => setMenu(null)} />,
        document.querySelector('.studio') ?? document.body)}
      <div className="nx-lane bm-camlens" style={{ height: Math.round(laneHeight * 0.6) }}>
        {lensMarks.map((k) => (
          <span key={k.id} className="bm-lensmark" style={{ left: toX(timeOf(k.id, k.t)) }}
            title={`${Math.round(k.lensMm)} mm lens, focus ${k.focus === 'target' ? 'on target' : Math.round(k.focus * 100) + '%'}, background blur ${Math.round(k.blur * 100)}%`}>
            {Math.round(k.lensMm)} mm{k.blur > 0 ? ' · DoF' : ''}
          </span>
        ))}
      </div>
    </>
  );
}

type ToolsProps = {
  clock: CameraClock; time: number; duration: number; fps: number; sensorMm: number;
  /** writes an automatic track in a style; left out where there is no build to read */
  onAutoDirect?: (style: DirectorStyle) => void;
};

const STYLES: { id: DirectorStyle; label: string; hint: string }[] = [
  { id: 'reference', label: 'Speed build', hint: 'High over the base, lowering as it grows, quick swoops to the side being built, then a hard cut to a low front view for the last details' },
  { id: 'showcase', label: 'Showcase orbit', hint: 'Lowers to the front, circles slowly round the back while it is built, then cuts to a low front view' },
  { id: 'turntable', label: 'Turntable', hint: 'KenBrick style: a still frame on the whole model, turning faster as it is built, then a whip to the front and a hold. For the full look use Video → Timing → KenBrick look (12 s)' },
  { id: 'calm', label: 'Calm', hint: 'Slow glides on a long lens, no swings, an arc onto the front' },
  { id: 'energetic', label: 'Energetic', hint: 'Lots of whip pans and swoops with strong motion blur' },
  { id: 'overhead', label: 'Overhead', hint: 'Looks down from above the whole time' },
];

/** Reads the viewport's current view as a key at time t, or null when there is no viewport. */
/** Roughly how far the viewport camera is from what it looks at (for truck and pedestal slides). */
function viewDistance(): number {
  const cam = viewportApi.studio?.camera, target = viewportApi.controls?.target;
  return cam && target ? cam.position.distanceTo(target) : 100;
}

function keyFromView(t: number, sensorMm: number) {
  const cam = viewportApi.studio?.camera as THREE.PerspectiveCamera | undefined;
  const target = viewportApi.controls?.target;
  if (!cam || !target) return null;
  return cameraPoseToKey(cam.position.clone(), target.clone(), cam.fov, sensorMm, t);
}

/** Toolbar actions for the Camera row. */
export function CameraTrackTools({ clock, time, duration, fps, sensorMm, onAutoDirect }: ToolsProps) {
  const { ref, track } = useCameraTrack(clock);
  const sel = useStudio((s) => s.cameraSelection);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  /** fixed to the window beside the button, so the timeline panel cannot clip it */
  const menuStyle = (): CSSProperties => {
    const b = menuRef.current?.getBoundingClientRect();
    if (!b) return { position: 'fixed' };
    const p = placeMenu(b, window.innerHeight, window.innerWidth, MENU_WIDTH);
    return { position: 'fixed', left: p.left, top: p.top ?? 'auto', bottom: p.bottom ?? 'auto', maxHeight: p.maxHeight, width: MENU_WIDTH };
  };
  const st = useStudio.getState;
  const selKey = sel?.clock === clock && sel.kind === 'key' ? track?.keys.find((k) => k.id === sel.id) : undefined;

  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      const at = e.target as Node;
      if (!menuRef.current?.contains(at) && !popRef.current?.contains(at)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [menu]);

  const addFromView = () => {
    const key = keyFromView(time, sensorMm);
    if (!key) return;
    const before = new Set(trackOf(st().plan, ref)?.keys.map((k) => k.id));
    st().apply((p) => addCameraKey(p, ref, key, fps, duration));
    const added = trackOf(st().plan, ref)?.keys.find((k) => !before.has(k.id));
    if (added) st().selectCamera({ kind: 'key', clock, id: added.id });
  };
  const updateFromView = () => {
    if (!selKey) return;
    const key = keyFromView(selKey.t, sensorMm);
    if (key) st().apply((p) => updateCameraKey(p, ref, selKey.id, { ...key, t: selKey.t }));
  };
  const remove = () => {
    if (!selKey) return;
    st().apply((p) => deleteCameraKey(p, ref, selKey.id));
    st().selectCamera(null);
  };

  return (
    <span className="bm-camtools">
      {onAutoDirect && (
        <span className="bm-tl-note-wrap" ref={menuRef}>
          <button type="button" className="nx-btn nx-sm" aria-haspopup="menu" aria-expanded={menu}
            title="Write a camera track from the build: keys and moves you can then change" aria-label="Auto-direct"
            onClick={() => setMenu(!menu)}>
            <Ic name="wand" /><span className="bm-camtool-label"> Auto-direct</span>
          </button>
          {menu && createPortal(
            <span ref={popRef} className="bm-tl-pop open bm-styles bm-styles-float" role="menu" style={menuStyle()}>
              {STYLES.map((s) => (
                <button key={s.id} type="button" role="menuitem" className={track?.style === s.id ? 'on' : ''}
                  onClick={() => { setMenu(false); onAutoDirect(s.id); }}>
                  <b>{s.label}</b><small>{s.hint}</small>
                </button>
              ))}
            </span>,
            // inside the app root, which holds the theme colours, but outside the clipping timeline panel
            menuRef.current?.closest('.studio') ?? document.body,
          )}
        </span>
      )}
      <button type="button" className="nx-btn nx-sm" title="Add a camera key at the playhead with the viewport's current view" aria-label="Key from view" onClick={addFromView}>
        <Ic name="plus" /><span className="bm-camtool-label"> Key from view</span>
      </button>
      <button type="button" className="nx-icon" aria-label="Update key from view" title="Set the selected key to the viewport's current view" disabled={!selKey} onClick={updateFromView}>
        <Ic name="camera" />
      </button>
      <button type="button" className="nx-icon" aria-label="Delete camera key" title="Delete the selected camera key" disabled={!selKey} onClick={remove}>
        <Ic name="trash" />
      </button>
    </span>
  );
}
