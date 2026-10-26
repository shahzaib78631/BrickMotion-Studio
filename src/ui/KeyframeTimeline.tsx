import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  allKeyRefs, animationOf, boundedFrame, CHANNELS, TRANSFORM_CHANNELS, copyKeys, deleteKeys, insertKeys,
  moveKeys, pasteKeys, refId, selectedKeys, setInterpolation, trackOf, valuesAt,
  type KeyClipboard, type KeyRef,
} from '../anim/keyframes';
import { buildLayerAt, linkBuildLayer, unlinkBuildLayer, updateBuildLayer } from '../anim/buildLayer';
import { bakeBuildFlights } from '../anim/bakeBuild';
import { checkEditedMotion, type MotionReport } from '../anim/motionDiagnostics';
import type { Instance } from '../model/assemble';
import * as THREE from 'three';
import type { Timeline } from '../anim/timeline';
import { modelSteps } from '../plan/ops';
import { isSub, type AnimationChannel, type KeyframeAnimation, type KeyInterpolation } from '../plan/types';
import { useKeyframePlayback } from '../state/keyframePlayback';
import { useStudio } from '../state/store';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { Ic } from './icons';

const PAD = 26;
/** One row height for the object outliner and its lanes. Sized to match the rest of
 * the editor (the Build lanes are 42) instead of the cramped 25 that made the
 * assembly items look shrunken the moment you switched to the Timeline view. */
const ROW = 36;
const MAX_WIDTH = 140000;
const FRAME_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
const channelLabel = (c: AnimationChannel) => c === 'visibility' ? 'Visible / Hidden' : `${c.split('.')[1].toUpperCase()} ${c.split('.')[0] === 'location' ? 'Location' : c.split('.')[0] === 'rotation' ? 'Euler Rotation' : 'Scale'}`;
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
const numValue = (value: number) => Number.isInteger(value) ? String(value) : Number(value.toFixed(3)).toString();
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

type Row = { id: string; kind: 'summary' | 'build' | 'object' | 'section' | 'channel'; target?: string; channel?: AnimationChannel; label: string; depth: number };
type KeyDrag = { delta: number; moved: boolean };
type FrameMenu = { x: number; y: number; refs: KeyRef[] };

/** Editable value commits on Blur/Enter, so intermediate `-` or blank input isn't lost. */
function ValueField({ value, unit, keyed, onCommit, onKey }: {
  value: number; unit?: string; keyed: boolean; onCommit(value: number): void; onKey(): void;
}) {
  const [draft, setDraft] = useState(numValue(value));
  useEffect(() => setDraft(numValue(value)), [value]);
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(parsed) && Math.abs(parsed) <= 100000) onCommit(parsed);
    else setDraft(numValue(value));
  };
  return (
    <div className="bm-anim-field">
      <button className={`bm-anim-keyflag ${keyed ? 'keyed' : ''}`} aria-label={keyed ? 'Replace this keyframe' : 'Insert keyframe on this channel'} title="Insert keyframe on this channel" onClick={onKey}>
        <i />
      </button>
      <input type="text" inputMode="decimal" value={draft} aria-label={unit ? `${unit} value` : 'Channel value'}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(numValue(value)); e.currentTarget.blur(); } }} />
      {unit && <span className="bm-anim-unit">{unit}</span>}
    </div>
  );
}

/** Typed layer parameters commit as a single undoable edit, not on every digit. */
function LayerNumberField({ value, label, min, max, step, onCommit }: {
  value: number; label: string; min: number; max: number; step: number; onCommit(v: number): void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() && Number.isFinite(n) && n >= min && n <= max && (step !== 1 || Number.isInteger(n))) onCommit(n);
    setDraft(String(value));
  };
  return <input type="number" aria-label={label} min={min} max={max} step={step} value={draft}
    onChange={(e) => setDraft(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(String(value)); e.currentTarget.blur(); } }} />;
}

/** Dope Sheet: procedural construction layer and non-destructive object motion. */
export function KeyframeTimeline({ timeline, planning, buildError, instances, placements }: { timeline: Timeline | null; planning: boolean; buildError: string; instances: readonly Instance[]; placements: ReadonlyMap<string, THREE.Matrix4> }) {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const selection = useStudio((s) => s.selection);
  const animation = animationOf(plan.animation);
  const buildLayer = buildLayerAt(animation, editingModel);
  const [layerError, setLayerError] = useState('');
  const [bakeMessage, setBakeMessage] = useState('');
  const [motionReport, setMotionReport] = useState<MotionReport | null>(null);
  const [scrollState, setScrollState] = useState({ left: 0, width: 700 });
  const fps = animation.fps;
  const frame = useKeyframePlayback((s) => Math.round(s.frame));
  const playing = useKeyframePlayback((s) => s.playing);
  const loop = useKeyframePlayback((s) => s.loop);
  const autoKey = useKeyframePlayback((s) => s.autoKey);
  const [selected, setSelected] = useState<KeyRef[]>([]);
  const [focused, setFocused] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState<'animated' | 'all'>('all');
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(700);
  const [drag, setDrag] = useState<KeyDrag | null>(null);
  const [menu, setMenu] = useState<FrameMenu | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; x1: number; y0: number; y1: number } | null>(null);
  const [clipboard, setClipboard] = useState<KeyClipboard>([]);
  const editorRef = useRef<HTMLDivElement>(null);
  const headsRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const zoomAnchor = useRef<{ frame: number; offset: number } | null>(null);
  const keysSelected = new Set(selected.map(refId));
  const frameRounded = boundedFrame(frame, animation);

  const objects = useMemo(() => {
    const top = modelSteps(plan, editingModel).flatMap((step) => step.pieces.map((item) => ({
      id: item.id ?? '', label: isSub(item) ? item.submodel : item.part,
      isSubmodel: isSub(item), nested: false,
    }))).filter((item) => item.id);
    const known = new Set(top.map((obj) => obj.id));
    // Baked flights inside a placed submodel have their OWN selectable channels.
    // Keep the unbaked hierarchy folded to avoid flooding the sheet with leaves.
    const nested = instances.filter((inst) => !known.has(inst.key) &&
      plan.animation?.tracks.some((t) => t.model === editingModel && t.target === inst.key))
      .map((inst) => ({ id: inst.key, label: `${inst.key.split('/').slice(0, -1).join(' › ')} › ${inst.part}`,
        isSubmodel: false, nested: true }));
    return [...top, ...nested];
  }, [plan, editingModel, instances]);
  const selectedObjects = selection.model === editingModel ? selection.ids : [];
  const activeObject = focused && (selectedObjects.includes(focused) || (focused.includes('/') && selectedObjects.includes(focused.split('/')[0])))
    ? focused : selectedObjects[0] ?? focused;
  const available = useMemo(() => new Set(objects.map((o) => o.id)), [objects]);

  useEffect(() => {
    setMotionReport(null); setBakeMessage('');
    setSelected([]); setFocused(null); setExpanded(new Set()); setMarquee(null); setClipboard([]);
    useKeyframePlayback.getState().set({ playing: false, frame: animation.startFrame });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingModel]);
  useEffect(() => {
    if (frame < animation.startFrame || frame > animation.endFrame)
      useKeyframePlayback.getState().set({ frame: boundedFrame(frame, animation), playing: false });
  }, [frame, animation.startFrame, animation.endFrame]);
  useEffect(() => {
    const observer = new ResizeObserver(() => setWidth(editorRef.current?.clientWidth || 700));
    if (editorRef.current) observer.observe(editorRef.current);
    return () => observer.disconnect();
  }, []);

  const tracks = animation.tracks.filter((t) => t.model === editingModel && available.has(t.target));
  const keyedObjects = new Set(tracks.filter((t) => CHANNELS.some((ch) => !!t.channels[ch]?.length)).map((t) => t.target));
  const shownObjects = objects.filter((o) => {
    if (query && !`${o.label} ${o.id}`.toLowerCase().includes(query.toLowerCase())) return false;
    return filter === 'all' || keyedObjects.has(o.id) || selectedObjects.includes(o.id) || focused === o.id;
  });
  const rows: Row[] = [{ id: 'summary', kind: 'summary', label: 'Summary', depth: 0 }];
  if (buildLayer) rows.push({ id: 'build', kind: 'build', label: 'Generated Build', depth: 0 });
  for (const item of shownObjects) {
    rows.push({ id: `object:${item.id}`, kind: 'object', target: item.id, label: item.label, depth: item.nested ? 1 : 0 });
    if (expanded.has(item.id)) {
      rows.push({ id: `section:${item.id}`, kind: 'section', target: item.id, label: 'Object Transforms', depth: 1 });
      for (const channel of CHANNELS) rows.push({ id: `channel:${item.id}:${channel}`, kind: 'channel', target: item.id, channel, label: channelLabel(channel), depth: 2 });
    }
  }
  const allRefs = useMemo(() => allKeyRefs(animation, editingModel).filter((ref) => available.has(ref.target)), [animation, editingModel, objects]);
  const allCount = allRefs.length;
  const refsByTarget = new Map<string, KeyRef[]>();
  const refsByChannel = new Map<string, KeyRef[]>();
  for (const ref of allRefs) {
    const byObject = refsByTarget.get(ref.target) ?? [];
    byObject.push(ref); refsByTarget.set(ref.target, byObject);
    const id = JSON.stringify([ref.target, ref.channel]);
    const byChannel = refsByChannel.get(id) ?? [];
    byChannel.push(ref); refsByChannel.set(id, byChannel);
  }
  // Frame ranges may never orphan keys already authored in another submodel.
  const sceneKeys = animation.tracks.flatMap((track) => CHANNELS.flatMap((ch) => track.channels[ch] ?? []));
  let firstKey = animation.endFrame, lastKey = animation.startFrame;
  for (const key of sceneKeys) { firstKey = Math.min(firstKey, key.frame); lastKey = Math.max(lastKey, key.frame); }
  // Scene start must never move past a linked procedural source in ANY model.
  // Otherwise a project could become invalid despite the current model's keys
  // remaining within their playback range.
  const sourceStarts = Object.values(animation.buildLayers ?? {}).map((layer) => layer.startFrame);
  const latestStart = Math.min(animation.endFrame - 1, firstKey, ...sourceStarts);
  const linkedFinish = buildLayer && timeline
    ? Math.min(20000, buildLayer.startFrame + Math.ceil(timeline.duration / buildLayer.speed * animation.fps))
    : animation.startFrame + 1;
  const earliestEnd = Math.max(animation.startFrame + 1, lastKey, linkedFinish);

  const base = Math.max(2.4, Math.min(28, (width - PAD * 2) / Math.max(20, animation.endFrame - animation.startFrame)));
  const px = base * zoom;
  const X = (f: number) => PAD + (f - animation.startFrame) * px;
  const widthPx = Math.min(MAX_WIDTH, Math.max(width, X(animation.endFrame) + PAD));
  const visibleFirst = animation.startFrame + Math.floor((scrollState.left - PAD - 28) / px);
  const visibleLast = animation.startFrame + Math.ceil((scrollState.left + scrollState.width - PAD + 28) / px);
  useEffect(() => {
    const el = editorRef.current;
    if (!el || !playing) return;
    const at = PAD + (frame - animation.startFrame) * px;
    if (at < el.scrollLeft + 30 || at > el.scrollLeft + el.clientWidth - 30)
      el.scrollLeft = Math.max(0, at - el.clientWidth * .68);
  }, [frame, playing, animation.startFrame, px]);
  const tickStep = FRAME_STEPS.find((step) => step * px >= 55) ?? 2000;
  const ticks: number[] = [];
  for (let f = Math.ceil(animation.startFrame / tickStep) * tickStep; f <= animation.endFrame && ticks.length < 2000; f += tickStep) ticks.push(f);
  const seek = (n: number) => useKeyframePlayback.getState().set({ playing: false, frame: boundedFrame(n, animation) });
  const timeAt = (clientX: number) => {
    const el = editorRef.current;
    return el ? animation.startFrame + (clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD) / px : frameRounded;
  };
  const keyFor = (row: Row): KeyRef[] => row.kind === 'build' ? [] : row.kind === 'summary' ? allRefs : row.kind === 'object' || row.kind === 'section'
    ? refsByTarget.get(row.target ?? '') ?? []
    : refsByChannel.get(JSON.stringify([row.target, row.channel])) ?? [];

  const applyAnimation = (fn: (animation: KeyframeAnimation) => KeyframeAnimation) => {
    setMotionReport(null);
    useStudio.getState().apply((p) => {
      const next = fn(animationOf(p.animation));
      return next === p.animation ? p : { ...p, animation: next };
    });
  };
  const changeLayer = (fn: (a: KeyframeAnimation) => KeyframeAnimation) => {
    setLayerError('');
    try { applyAnimation(fn); }
    catch (error) { setLayerError(error instanceof Error ? error.message : String(error)); }
  };
  const insert = (channels?: readonly AnimationChannel[], targets?: readonly string[], atFrame = frameRounded) => {
    const ids = [...new Set(targets ?? (activeObject ? [activeObject] : selectedObjects))].filter((id) => available.has(id));
    if (!ids.length) return;
    const fields = channels ?? TRANSFORM_CHANNELS;
    const updates = ids.flatMap((id) => {
      const values = valuesAt(animation, editingModel, id, atFrame);
      return fields.map((channel) => ({ model: editingModel, target: id, channel, value: values[channel] }));
    });
    applyAnimation((clip) => insertKeys(clip, atFrame, updates));
    setSelected(ids.flatMap((id) => fields.map((channel) => ({ model: editingModel, target: id, channel, frame: atFrame }))));
    setExpanded((old) => new Set([...old, ...ids]));
  };
  const updateChannel = (id: string, channel: AnimationChannel, value: number) => {
    applyAnimation((clip) => insertKeys(clip, frameRounded, [{ model: editingModel, target: id, channel, value }]));
    setSelected([{ model: editingModel, target: id, channel, frame: frameRounded }]);
    setExpanded((old) => new Set([...old, id]));
  };
  const remove = (refs: readonly KeyRef[]) => { applyAnimation((a) => deleteKeys(a, refs)); setSelected([]); };
  const duplicate = () => {
    if (!selected.length) return;
    const copy = copyKeys(animation, selected);
    const at = Math.min(animation.endFrame, Math.max(animation.startFrame, frameRounded + 1));
    applyAnimation((a) => pasteKeys(a, copy, at));
    setSelected(copy.map((key) => ({ model: key.model, target: key.target, channel: key.channel, frame: boundedFrame(at + key.offset, animation) })));
    seek(at);
  };
  const copy = () => { setClipboard(copyKeys(animation, selected)); };
  const paste = () => {
    if (!clipboard.length) return;
    applyAnimation((a) => pasteKeys(a, clipboard, frameRounded));
    setSelected(clipboard.map((key) => ({ model: key.model, target: key.target, channel: key.channel, frame: boundedFrame(frameRounded + key.offset, animation) })));
  };
  const neighboringKey = (dir: -1 | 1) => {
    const frames = [...new Set(allRefs.map((ref) => ref.frame))].sort((a, b) => a - b);
    const next = dir === 1 ? frames.find((f) => f > frame + .001) : frames.reverse().find((f) => f < frame - .001);
    seek(next ?? (dir === 1 ? animation.endFrame : animation.startFrame));
  };
  const togglePlay = () => useKeyframePlayback.getState().set({ playing: !playing,
    frame: frame >= animation.endFrame ? animation.startFrame : frame });

  const shortcuts = useRef<((e: KeyboardEvent) => void) | null>(null);
  shortcuts.current = (e) => {
    if (e.defaultPrevented || isTyping(e.target) || e.altKey || (e.target instanceof Element && e.target.closest('[role="menu"]'))) return;
    const command = e.metaKey || e.ctrlKey;
    if (command && e.key.toLowerCase() === 'z') {
      e.preventDefault(); e.shiftKey ? useStudio.getState().redo() : useStudio.getState().undo(); return;
    }
    if (command && e.key.toLowerCase() === 'c') { e.preventDefault(); copy(); return; }
    if (command && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); return; }
    if (command && e.key.toLowerCase() === 'a') { e.preventDefault(); setSelected(allRefs); return; }
    if (command) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key.toLowerCase() === 'i') { e.preventDefault(); insert(); }
    else if (e.key === 'Delete' || e.key === 'Backspace' || e.key.toLowerCase() === 'x') { if (selected.length) { e.preventDefault(); remove(selected); } }
    else if (e.key.toLowerCase() === 'd' && e.shiftKey) { e.preventDefault(); duplicate(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(frameRounded - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(frameRounded + 1); }
    else if (e.key === 'Home') { e.preventDefault(); seek(animation.startFrame); }
    else if (e.key === 'End') { e.preventDefault(); seek(animation.endFrame); }
    else if (e.key === 'Escape') { setSelected([]); setMenu(null); }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => shortcuts.current?.(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const startScrub = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    seek(Math.round(timeAt(e.clientX)));
    const move = (ev: PointerEvent) => seek(Math.round(timeAt(ev.clientX)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const pressKey = (e: RPointerEvent, refs: KeyRef[]) => {
    if (e.button !== 0 || !refs.length) return;
    e.preventDefault(); e.stopPropagation();
    const wasSelected = refs.every((ref) => keysSelected.has(refId(ref)));
    const picked = e.shiftKey
      ? (wasSelected ? selected.filter((ref) => !refs.some((other) => refId(ref) === refId(other))) : [...selected, ...refs.filter((ref) => !keysSelected.has(refId(ref)))])
      : wasSelected ? selected : refs;
    setSelected(picked);
    if (refs[0].target) {
      setFocused(refs[0].target);
      useStudio.getState().select([refs[0].target.split('/')[0]]);
    }
    seek(refs[0].frame);
    const x0 = e.clientX;
    let preview = 0;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const delta = Math.round((ev.clientX - x0) / px);
      if (delta === preview) return;
      preview = delta;
      moved = true;
      setDrag({ moved: true, delta: preview });
    };
    const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); setDrag(null); };
    const up = () => {
      cleanup();
      if (!moved || !preview) return;
      const bounded = selectedKeys(animation, picked).map((entry) => boundedFrame(entry.ref.frame + preview, animation) - entry.ref.frame);
      // Keep the relative key spacing; don't allow partial clipping at either edge.
      const actual = preview > 0 ? Math.min(preview, ...bounded) : Math.max(preview, ...bounded);
      if (!actual) return;
      applyAnimation((a) => moveKeys(a, picked, actual));
      setSelected(picked.map((ref) => ({ ...ref, frame: ref.frame + actual })));
      seek(refs[0].frame + actual);
    };
    const cancel = () => cleanup();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };
  const startMarquee = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    const el = editorRef.current;
    const body = bodyRef.current;
    if (!el || !body) return;
    if (!e.shiftKey) { seek(Math.round(timeAt(e.clientX))); return; }
    e.preventDefault();
    const rect = body.getBoundingClientRect();
    const x0 = e.clientX - rect.left, y0 = e.clientY - rect.top;
    const old = selected;
    let last = { x0, x1: x0, y0, y1: y0 };
    setMarquee(last);
    const move = (ev: PointerEvent) => {
      last = { x0, x1: ev.clientX - rect.left, y0, y1: ev.clientY - rect.top };
      setMarquee(last);
    };
    const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); setMarquee(null); };
    const up = () => {
      const left = Math.min(last.x0, last.x1), right = Math.max(last.x0, last.x1);
      const top = Math.min(last.y0, last.y1), bottom = Math.max(last.y0, last.y1);
      const found = rows.flatMap((row, i) => {
        if (i * ROW + ROW < top || i * ROW > bottom || row.kind === 'summary' || row.kind === 'section') return [];
        return keyFor(row).filter((ref) => X(ref.frame) >= left && X(ref.frame) <= right);
      });
      const unique = new Map([...old, ...found].map((ref) => [refId(ref), ref]));
      setSelected([...unique.values()]); cleanup();
    };
    const cancel = () => cleanup();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  const zoomTo = (next: number) => setZoom(clamp(next, .5, 24));
  const fit = () => {
    zoomTo(1);
    if (editorRef.current) editorRef.current.scrollLeft = 0;
  };
  const wheelInfo = useRef({ px, zoom });
  wheelInfo.current = { px, zoom };
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
      event.preventDefault();
      const cur = wheelInfo.current;
      const next = clamp(cur.zoom * Math.exp(-event.deltaY * .0025), .5, 24);
      if (next === cur.zoom) return;
      const offset = event.clientX - el.getBoundingClientRect().left;
      zoomAnchor.current = { frame: animation.startFrame + (offset + el.scrollLeft - PAD) / cur.px, offset };
      setZoom(next);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [animation.startFrame]);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    if (!anchor || !editorRef.current) return;
    editorRef.current.scrollLeft = Math.max(0, X(anchor.frame) - anchor.offset);
    zoomAnchor.current = null;
  }, [px]);

  const menuItems = (refs: KeyRef[]): ContextItem[] => [
    { heading: `${refs.length} selected keyframe${refs.length === 1 ? '' : 's'}` },
    { icon: 'file', label: 'Copy keyframes', hint: 'Ctrl+C', onClick: () => { setClipboard(copyKeys(animation, refs)); } },
    { icon: 'trash', label: 'Delete keyframes', hint: 'X', onClick: () => remove(refs) },
    'sep',
    { heading: 'Interpolation' },
    ...(['bezier', 'linear', 'constant'] as const).map((kind) => ({ icon: 'key', label: kind === 'bezier' ? 'Bezier / Ease' : kind === 'linear' ? 'Linear' : 'Constant / Hold', onClick: () => applyAnimation((a) => setInterpolation(a, refs, kind)) } as const)),
  ];
  const checkMotion = () => {
    try {
      const report = checkEditedMotion(instances, placements, animation, editingModel, timeline);
      setMotionReport(report);
      setLayerError('');
    } catch (error) { setLayerError(error instanceof Error ? error.message : String(error)); }
  };
  const jumpToConflict = (key: string, time: number) => {
    setFilter('all'); setQuery(key); setFocused(key);
    setExpanded((old) => new Set([...old, key]));
    useStudio.getState().select([key.split('/')[0]]);
    const source = buildLayerAt(animation, editingModel);
    const frameAt = (source?.startFrame ?? animation.startFrame) + time / (source?.speed ?? 1) * animation.fps;
    seek(frameAt);
  };
  const gotoFirstConflict = () => {
    const issue = timeline?.motion?.issues?.[0];
    if (issue) jumpToConflict(issue.key, issue.time);
  };
  const gotoFirstContact = () => {
    const first = motionReport?.warnings[0];
    if (first) seek(first.frame);
  };
  const doBake = (entire: boolean) => {
    setMotionReport(null);
    if (!timeline || !canBake) { setLayerError('Generate a valid Build route before baking flights.'); return; }
    const targets = entire ? undefined : [activeObject ?? ''].filter(Boolean);
    if (!entire && !targets?.length) { setLayerError('Select a piece or submodel to bake its flight.'); return; }
    const hit = instances.filter((inst) => !targets || targets.some((id) => inst.key === id || inst.key.startsWith(`${id}/`)));
    const overwritten = hit.filter((inst) => animation.tracks.some((t) => t.model === editingModel && t.target === inst.key &&
      Object.values(t.channels).some((keys) => !!keys?.length)));
    if (overwritten.length && !window.confirm(`Baking replaces existing keys on ${overwritten.length} selected piece(s), including manual changes to previously baked flights. You can undo the operation. Continue?`)) return;
    try {
      const result = bakeBuildFlights(animation, editingModel, instances, placements, timeline,
        { targets, detach: entire });
      useStudio.getState().apply((p) => ({ ...p, animation: result.animation }));
      setLayerError('');
      setBakeMessage(`${result.count} flight${result.count === 1 ? '' : 's'} baked into ${result.keys.toLocaleString()} editable keys.${entire ? ' Procedural Build detached.' : ' Other flights remain linked.'}`);
      setFilter('animated');
      const ids = hit.map((inst) => inst.key);
      setExpanded((old) => new Set([...old, ...ids.slice(0, 8)]));
      if (!entire && ids.length === 1) setFocused(ids[0]);
    } catch (error) { setLayerError(error instanceof Error ? error.message : String(error)); }
  };
  const propertyId = activeObject && available.has(activeObject) ? activeObject : null;
  const propertyObject = objects.find((obj) => obj.id === propertyId);
  const propertyValues = propertyId ? valuesAt(animation, editingModel, propertyId, frameRounded) : null;
  const propertyTrack = propertyId ? trackOf(animation, editingModel, propertyId) : undefined;
  const bakedCount = instances.filter((inst) => animation.tracks.some((track) => track.model === editingModel && track.target === inst.key && track.source === 'baked-flight')).length;
  const canBake = !!timeline && !planning && !buildError;
  const activeInterpolation = selectedKeys(animation, selected).map((s) => s.key.interpolation);
  const interpolation: KeyInterpolation | '' = activeInterpolation.length && activeInterpolation.every((v) => v === activeInterpolation[0]) ? activeInterpolation[0] : '';

  return (
    <div className="nx-timeline bm-keys" aria-label="Keyframe timeline editor">
      <div className="bm-key-transport">
        <div className="bm-key-left">
          <strong className="bm-key-appname">Dope Sheet</strong>
          <span className="bm-key-separator" />
          <button className="bm-key-button bm-key-insert" onClick={() => insert()} disabled={!selectedObjects.length && !propertyId} title="Insert Location, Rotation and Scale keys for the selected objects (I)">
            <Ic name="key" /> Insert key <kbd>I</kbd>
          </button>
          <button className={`bm-key-button ${autoKey ? 'bm-key-record-on' : ''}`} aria-pressed={autoKey} title="Auto Key: record viewport gizmo transforms at the current frame" onClick={() => useKeyframePlayback.getState().set({ autoKey: !autoKey })}>
            <span className="bm-key-record-dot" /> Auto Key
          </button>
          <span className="bm-key-count">{allCount} key{allCount === 1 ? '' : 's'}</span>
        </div>
        <div className="bm-key-center">
          <button className="bm-key-icon" title="Previous keyframe" aria-label="Previous keyframe" onClick={() => neighboringKey(-1)}><Ic name="prev" /></button>
          <button className="bm-key-play" title="Play/Pause (Space)" aria-label={playing ? 'Pause keyframes' : 'Play keyframes'} onClick={togglePlay}><Ic name={playing ? 'pause' : 'play'} /></button>
          <button className="bm-key-icon" title="Next keyframe" aria-label="Next keyframe" onClick={() => neighboringKey(1)}><Ic name="next" /></button>
          <label className="bm-key-frame-input">Frame <input type="number" min={animation.startFrame} max={animation.endFrame} value={frameRounded}
            onChange={(e) => seek(Number(e.target.value))} aria-label="Current animation frame" /></label>
        </div>
        <div className="bm-key-right">
          <button className={`bm-key-icon ${loop ? 'active' : ''}`} title="Loop playback" aria-pressed={loop} aria-label="Loop animation" onClick={() => useKeyframePlayback.getState().set({ loop: !loop })}><Ic name="repeat" /></button>
          <button className="bm-key-icon" title="Zoom out (Ctrl+wheel)" aria-label="Zoom out" onClick={() => zoomTo(zoom / 1.4)}><Ic name="zoomOut" /></button>
          <span className="bm-key-zoom">{Math.round(zoom * 100)}%</span>
          <button className="bm-key-icon" title="Zoom in (Ctrl+wheel)" aria-label="Zoom in" onClick={() => zoomTo(zoom * 1.4)}><Ic name="zoomIn" /></button>
          <button className="bm-key-icon" title="Fit frame range" aria-label="Fit timeline" onClick={fit}><Ic name="widen" /></button>
        </div>
      </div>
      <div className={`bm-key-buildlayer ${buildLayer ? 'is-linked' : ''}`} aria-label="Construction animation layer">
        <span className="bm-build-status-icon"><Ic name="brick" /></span>
        {buildLayer ? (
          <>
            <strong>Build motion</strong><span className="bm-key-linked">Linked</span>
            <span className="bm-key-buildnote" title="The generated Build stays editable through its steps and planner. Keys are non-destructive offsets on top of its motion.">Procedural base · Transform keys add offsets</span>
            <label>Speed <LayerNumberField value={buildLayer.speed} label="Build layer playback speed" min={0.1} max={4} step={0.1}
              onCommit={(speed) => { if (timeline) changeLayer((a) => updateBuildLayer(a, editingModel, { ...buildLayer, speed }, timeline.duration)); }} />×</label>
            <label>Start <LayerNumberField value={buildLayer.startFrame} label="Build layer start frame" min={animation.startFrame} max={animation.endFrame} step={1}
              onCommit={(startFrame) => { if (timeline) changeLayer((a) => updateBuildLayer(a, editingModel, { ...buildLayer, startFrame }, timeline.duration)); }} /></label>
            <button className="bm-key-unlink" title="Unlink the Build layer (unbaked bricks will become static)" onClick={() => {
              if (bakedCount < instances.length && !window.confirm('Unlinking Build will make every unbaked brick static. Bake all flights first if you want to keep their motion. Unlink anyway?')) return;
              changeLayer((a) => unlinkBuildLayer(a, editingModel));
            }}><Ic name="x" /> Unlink</button>
            <button className="bm-key-bake" disabled={!canBake} title="Turn selected Build flights into independent editable object keys" onClick={() => doBake(false)}><Ic name="key" /> Bake selected</button>
            <button className="bm-key-bake" disabled={!canBake} title="Bake every brick, preserve appearance timing, and detach this model from its planner" onClick={() => doBake(true)}>Bake all & detach</button>
          </>
        ) : (
          <>
            <strong>{bakedCount ? 'Baked keyframes' : 'Static model'}</strong><span className="bm-key-buildnote">Keyframe freely, or place an editable motion layer over the generated Build.</span>
            <button className="bm-key-build-link" disabled={!timeline || planning || !!buildError} onClick={() => {
              if (timeline) changeLayer((a) => linkBuildLayer(a, editingModel, timeline.duration));
            }}><Ic name="key" /> Use Build as base</button>
            {bakedCount > 0 && <span className="bm-key-buildnote">{bakedCount} individual flights baked · independent of Build</span>}
            {bakedCount > 0 && <button className="bm-key-bake" disabled={!canBake} title="Bake current generated motion for every item and remove the Build source" onClick={() => doBake(true)}>Rebake all</button>}
          </>
        )}
        {(layerError || (buildLayer && (buildError || planning || !timeline))) &&
          <span className="bm-key-layer-error" role="status" title={layerError || buildError}>{layerError || (planning ? 'Updating Build…' : buildError || 'Build animation unavailable')}</span>}
        <button className="bm-key-motion-check" title="Conservative broad-phase motion overlap diagnostics (not mesh collision certification)" onClick={checkMotion} disabled={!animation.tracks.some((t) => t.model === editingModel)}><Ic name="check" /> Check motion</button>
        {motionReport && <span className={`bm-key-motion-result ${motionReport.warnings.length ? 'warning' : 'clear'}`} role="status"
          onClick={() => gotoFirstContact()}
          title={motionReport.warnings.length ? "Broad-phase swept-bounds advisory, not a mesh collision certificate. Check any reported contacts manually. Jump to the first suspected contact frame." : "Broad-phase swept-bounds advisory, not a mesh collision certificate."}>
          {motionReport.warnings.length ? `${motionReport.warnings.length}+ potential contacts at frames ${motionReport.warnings.slice(0, 3).map((w) => w.frame).join(', ')}${motionReport.complete ? '' : ' · partial scan'}` : `No new bounds overlaps in ${motionReport.checkedFrames} samples${motionReport.complete ? '' : ' · partial scan'}`}
        </span>}
        {motionReport && motionReport.warnings.length > 0 && (
          <details className="bm-key-motion-details">
            <summary title="Opens every suspected contact and jumps the playhead to the first one"
              onClick={() => gotoFirstContact()}>Review contacts</summary>
            <div className="bm-key-motion-list" role="group" aria-label="Potential motion contacts">
              {motionReport.warnings.map((warning, i) => (
                <button key={`${warning.frame}:${warning.first}:${warning.second}:${i}`} type="button"
                  title="Jump to the suspected contact frame and inspect the viewport"
                  onClick={() => seek(warning.frame)}>
                  <strong>F{warning.frame}</strong> {warning.first} / {warning.second}
                </button>
              ))}
              <p>AABB / swept-bounds advisory only. A reported contact may be an intentional LEGO connection; an empty report is not collision certification.</p>
            </div>
          </details>
        )}
        {timeline?.motion && (
          <details className="bm-key-motion-details" aria-label="Generated assembly route review">
            <summary title="Opens every suspected conflict and jumps the playhead to the first one"
              onClick={() => gotoFirstConflict()}>
              {timeline.motion.v4
                ? `Review v4 · ${timeline.motion.v4.mesh.blocked} blocked · ${timeline.motion.v4.mesh.unverified} unverified`
                : (timeline.motion.obstructed ?? 0) > 0
                  ? <>Review routes · <b className="bm-key-conflict-count">{timeline.motion.obstructed}</b> possible conflicts</>
                  : `Review routes · ${timeline.motion.obstructed ?? 0} possible conflicts`}
            </summary>
            <div className="bm-key-motion-list" role="group" aria-label="Generated motion review list">
              {timeline.motion.logical && <p>Connected-part build order ({timeline.motion.logical.strategy}): {timeline.motion.logical.order.map(chain => chain.join(' → ')).join(' · ')}. Routes and keyframes remain editable.</p>}
              {(timeline.motion.issues ?? []).map((issue, i) => (
                <button key={`${issue.key}:${issue.unit}:${i}`} type="button"
                  title={`Jump to ${issue.key} near ${issue.time.toFixed(2)}s and expand all nine channels`}
                  onClick={() => jumpToConflict(issue.key, issue.time)}>
                  <strong>{issue.key}</strong> near {(issue.time).toFixed(2)}s · {issue.status ?? 'possible overlap'} · {issue.blockers.join(', ') || issue.reason || 'unknown obstacle'}
                </button>
              ))}
              {(timeline.motion.obstructed ?? 0) > (timeline.motion.issues?.length ?? 0) &&
                <p>Only the first {timeline.motion.issues?.length ?? 0} potential conflicts are listed. All parts remain searchable.</p>}
              {timeline.motion.v4 ? <p>Continuous mesh review includes installed, staged, and simultaneous flights. Only CLEAR is certified; contacts and unsupported interpolation remain UNVERIFIED. After changing keyframes, regenerate or revalidate the motion.</p> : <>
                {!timeline.motion.obstructed && <p>No overlaps found in sampled installed-part AABBs. This does not prove collision-free motion.</p>}
                <p>These are advisory checks only. Simultaneous flights, flexible geometry and connector contacts require manual inspection.</p></>}
            </div>
          </details>
        )}
        {bakeMessage && <span className="bm-key-bake-success" role="status" title={bakeMessage}>{bakeMessage}</span>}
      </div>
      <div className="bm-key-layout">
        <div className="bm-key-outliner">
          <div className="bm-key-outline-head">
            <input type="search" placeholder="Search objects…" aria-label="Filter animated objects" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className="bm-key-icon" title={filter === 'animated' ? 'Showing keyed and selected objects; show all objects' : 'Showing all objects; show keyed only'} aria-label="Toggle animated-only filter"
              aria-pressed={filter === 'animated'} onClick={() => setFilter(filter === 'animated' ? 'all' : 'animated')}><Ic name={filter === 'animated' ? 'key' : 'box'} /></button>
          </div>
          <div className="bm-key-outline-scroll" ref={headsRef} onScroll={(e) => {
            // Two-way: the object list and the tracks scroll together either way round.
            const to = editorRef.current;
            if (to && to.scrollTop !== e.currentTarget.scrollTop) to.scrollTop = e.currentTarget.scrollTop;
          }}>
            {rows.map((row) => {
              const active = row.target && (selectedObjects.includes(row.target) || focused === row.target);
              const num = keyFor(row).length;
              return (
                <div key={row.id} className={`bm-key-outline-row kind-${row.kind} ${active ? 'active' : ''}`} style={{ height: ROW, paddingLeft: 7 + row.depth * 13 }}
                  title={row.label} onClick={() => {
                    if (row.kind === 'summary') return;
                    if (row.target) { useStudio.getState().select([row.target.split('/')[0]]); setFocused(row.target); }
                    if (row.kind === 'object' && row.target) setExpanded((old) => { const next = new Set(old); if (next.has(row.target!)) next.delete(row.target!); else next.add(row.target!); return next; });
                  }}>
                  {row.kind === 'object' ? <button className="bm-key-disclose" aria-label={`${expanded.has(row.target!) ? 'Collapse' : 'Expand'} ${row.label}`} onClick={(e) => { e.stopPropagation(); setExpanded((old) => { const next = new Set(old); if (next.has(row.target!)) next.delete(row.target!); else next.add(row.target!); return next; }); }}><Ic name={expanded.has(row.target!) ? 'chevron' : 'right'} /></button> : row.kind === 'channel' ? <span className={`bm-key-axis axis-${row.channel!.split('.')[1]}`}>{(row.channel === 'visibility' ? 'V' : row.channel!.split('.')[1].toUpperCase())}</span> : <Ic name={row.kind === 'summary' ? 'steps' : row.kind === 'build' ? 'brick' : 'move'} />}
                  <span className="bm-key-trackname">{row.label}</span>
                  {num > 0 && row.kind !== 'channel' && <span className="bm-key-trackcount">{num}</span>}
                  {row.kind === 'channel' && <button className="bm-key-addchannel" title={`Insert ${row.label} keyframe at frame ${frameRounded}`} aria-label={`Insert keyframe in ${row.label}`} onClick={(e) => { e.stopPropagation(); insert([row.channel!], [row.target!]); }}><Ic name="plus" /></button>}
                </div>
              );
            })}
          </div>
        </div>
        <div className="bm-key-editor" ref={editorRef} onScroll={(e) => {
          const to = headsRef.current;
          if (to && to.scrollTop !== e.currentTarget.scrollTop) to.scrollTop = e.currentTarget.scrollTop;
          setScrollState({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth });
        }}>
          <div className="bm-key-content" style={{ width: widthPx }}>
            <div className="bm-key-ruler" onPointerDown={startScrub} role="slider" tabIndex={0} aria-label="Keyframe ruler" aria-valuemin={animation.startFrame} aria-valuemax={animation.endFrame} aria-valuenow={frameRounded} onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); seek(frameRounded + (e.key === 'ArrowRight' ? 1 : -1)); } }}>
              {ticks.map((tick) => <span key={tick} className="bm-key-tick" style={{ left: X(tick) }}><i />{tick}</span>)}
            </div>
            <div className="bm-key-body" ref={bodyRef} style={{ minHeight: Math.max(rows.length * ROW, 120), backgroundSize: `${tickStep * px}px 100%` }} onPointerDown={startMarquee}>
              {rows.map((row, i) => {
                // Only render diamonds close to the visible horizontal viewport.
                // Full baked models can have tens of thousands of channel keys.
                const refs = keyFor(row).filter((ref) => ref.frame >= visibleFirst && ref.frame <= visibleLast);
                const displayed = new Map<number, KeyRef[]>();
                for (const ref of refs) displayed.set(ref.frame, [...(displayed.get(ref.frame) ?? []), ref]);
                return (
                  <div key={row.id} className={`bm-key-lane kind-${row.kind}`} style={{ height: ROW, top: i * ROW }} onDoubleClick={(e) => {
                    if (row.channel && row.target) { const at = boundedFrame(timeAt(e.clientX), animation); seek(at); insert([row.channel], [row.target], at); }
                  }}>
                    {row.kind === 'build' && buildLayer && (
                      <div className={`bm-key-buildstrip ${!timeline ? 'unavailable' : ''}`}
                        style={{ left: X(buildLayer.startFrame), width: Math.max(16, (timeline ? Math.min(animation.endFrame - buildLayer.startFrame, timeline.duration / buildLayer.speed * fps) : 2) * px) }}
                        title={timeline ? `Live Build source · ${timeline.duration.toFixed(2)}s at ${buildLayer.speed}× · starts at frame ${buildLayer.startFrame}. Edit speed and start above.` : 'Linked Build source currently unavailable. Inspect the planning error above.'}>
                        <span>Build · {timeline ? `${buildLayer.speed}×` : 'Unavailable'}</span>
                      </div>
                    )}
                    {[...displayed].map(([atFrame, frameRefs]) => {
                      const on = frameRefs.some((ref) => keysSelected.has(refId(ref)));
                      const delta = on ? drag?.delta ?? 0 : 0;
                      const displayFrame = clamp(atFrame + delta, animation.startFrame, animation.endFrame);
                      return (
                        <button key={atFrame} className={`bm-key-diamond ${on ? 'selected' : ''} ${row.kind === 'summary' ? 'summary' : ''}`} style={{ left: X(displayFrame) }}
                          aria-label={`${row.label}, keyframe ${atFrame}${on ? ', selected' : ''}`} title={`${row.label} · Frame ${atFrame}. Drag to move; Shift+click to multi-select; right-click for options.`}
                          onPointerDown={(e) => pressKey(e, frameRefs)}
                          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); const use = frameRefs.every((ref) => keysSelected.has(refId(ref))) ? selected : frameRefs; setSelected(use); setMenu({ x: e.clientX, y: e.clientY, refs: use }); }}>
                          <i />
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {marquee && <div className="bm-key-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} />}
            </div>
            <div className="bm-key-playhead" style={{ left: X(frame) }}><i /></div>
          </div>
        </div>
        <aside className="bm-key-properties" aria-label="Animation properties">
          <div className="bm-key-property-title"><Ic name="move" /><span>Transform</span></div>
          {propertyObject && propertyValues ? (
            <>
              <div className="bm-key-property-object" title={propertyObject.label}><Ic name={propertyObject.isSubmodel ? 'box' : 'brick'} />{propertyObject.label}</div>
              {(['location', 'rotation', 'scale'] as const).map((kind) => (
                <section className={`bm-key-property-section section-${kind}`} key={kind}>
                  <div className="bm-key-section-title">{kind === 'location' ? 'Location' : kind === 'rotation' ? 'Euler Rotation' : 'Scale'} <span>{kind === 'location' ? 'studs' : kind === 'rotation' ? 'degrees' : 'factor'}</span></div>
                  {(['x', 'y', 'z'] as const).map((axis) => {
                    const channel = `${kind}.${axis}` as AnimationChannel;
                    const key = propertyTrack?.channels[channel]?.some((key) => key.frame === frameRounded) ?? false;
                    return (
                      <div className="bm-key-property-axis" key={channel}>
                        <span className={`bm-key-axis axis-${axis}`}>{axis.toUpperCase()}</span>
                        <ValueField value={propertyValues[channel]} keyed={key} unit={kind === 'rotation' ? '°' : undefined}
                          onCommit={(value) => updateChannel(propertyObject.id, channel, value)} onKey={() => updateChannel(propertyObject.id, channel, propertyValues[channel])} />
                      </div>
                    );
                  })}
                </section>
              ))}
            </>
          ) : (
            <div className="bm-key-property-empty"><Ic name="pointer" /><strong>Select an object</strong><p>Select a piece or submodel in the viewport to edit its animated transforms.</p><button onClick={() => setFilter('all')}>Browse all objects</button></div>
          )}
          <div className="bm-key-properties-bottom">
            {buildLayer && <div className="bm-key-layer-explainer"><Ic name="brick" /> Unbaked parts follow Build. Baked flights are independently editable; group keys offset both.</div>}
            {propertyTrack?.source === 'baked-flight' && <div className="bm-key-baked-explainer">Baked flight · edit or retime the yellow diamonds directly. These keys replace this brick's generated motion.</div>}
            {propertyObject && <section className="bm-key-property-section"><div className="bm-key-section-title">Visibility <span>step / hold</span></div>
              <label className="bm-key-visibility"><input type="checkbox" checked={!!propertyValues && propertyValues.visibility >= .5}
                onChange={(e) => updateChannel(propertyObject.id, 'visibility', e.target.checked ? 1 : 0)} /> Visible at frame {frameRounded}</label></section>}
            <div className="bm-key-section-title">Keyframe tools</div>
            <label className="bm-key-select-label">Interpolation <select value={interpolation} onChange={(e) => { if (e.target.value) applyAnimation((a) => setInterpolation(a, selected, e.target.value as KeyInterpolation)); }} disabled={!selected.length}>
              <option value="">{selected.length ? 'Mixed' : 'Select a key'}</option>
              <option value="bezier">Bezier / Ease</option><option value="linear">Linear</option><option value="constant">Constant / Hold</option>
            </select></label>
            <div className="bm-key-toolrow"><button disabled={!selected.length} onClick={copy}><Ic name="file" /> Copy</button><button disabled={!clipboard.length} onClick={paste}><Ic name="plus" /> Paste</button><button disabled={!selected.length} onClick={() => remove(selected)}><Ic name="trash" /> Delete</button></div>
            <div className="bm-key-section-title">Scene range</div>
            <div className="bm-key-settingsrow"><label>FPS <input aria-label="Animation frames per second" type="number" min={1} max={120} value={fps} onChange={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 1 && v <= 120) applyAnimation((a) => ({ ...a, fps: v })); }} /></label></div>
            <div className="bm-key-settingsrow"><label>Start <input aria-label="Animation start frame" type="number" min={0} max={latestStart} value={animation.startFrame} onChange={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 0 && v <= latestStart) applyAnimation((a) => ({ ...a, startFrame: v })); }} /></label><label>End <input aria-label="Animation end frame" type="number" min={earliestEnd} max={20000} value={animation.endFrame} onChange={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= earliestEnd && v <= 20000) applyAnimation((a) => ({ ...a, endFrame: v })); }} /></label></div>
          </div>
        </aside>
      </div>
      <div className="bm-key-footer"><span><kbd>I</kbd> Insert</span><span><kbd>Shift</kbd> + Click / Drag to multi-select</span><span><kbd>Shift+D</kbd> Duplicate</span><span><kbd>Del</kbd> Delete</span><span><kbd>Ctrl+Wheel</kbd> Zoom</span><span className="bm-key-footer-right">Frame {frameRounded} · {(frame / fps).toFixed(2)}s</span></div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.refs)} label="Keyframe actions" onClose={() => setMenu(null)} />}
    </div>
  );
}
