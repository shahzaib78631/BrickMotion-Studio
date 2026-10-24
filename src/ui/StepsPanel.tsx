import { Fragment, useRef, useState, type FormEvent, type PointerEvent as RPointerEvent } from 'react';
import { deleteStep, insertStep, mergeSteps, modelSteps, moveItemsToStep, reorderItemInStep, splitStep, updateStep } from '../plan/ops';
import { isSub, type Step } from '../plan/types';
import type { Timeline } from '../anim/timeline';
import { autoSplitSteps, LARGE_STEP } from '../plan/autoSteps';
import { getColors, metricsOf } from '../state/partService';
import { playRange, usePlayback } from '../state/playback';
import { stepRange } from '../anim/partClips';
import { useStudio } from '../state/store';
import { Ic } from './icons';
import { ContextMenu } from './ContextMenu';
import { PaneHead } from './PaneHead';

function subsIn(step: Step): string[] {
  return [...new Set(step.pieces.filter(isSub).map((i) => i.submodel))];
}

type StepEditorProps = {
  step: Step;
  index: number;
  model: string;
  hasNext: boolean;
  selectedIds: string[];
  onClose(): void;
};

/** An explicit Save button keeps one edit in one undo history entry. */
function StepEditor({ step, index, model, hasNext, selectedIds, onClose }: StepEditorProps) {
  const [title, setTitle] = useState(step.title ?? '');
  const [notes, setNotes] = useState(step.notes ?? '');
  const [pauseAfter, setPauseAfter] = useState(String(step.pauseAfter ?? 0));
  const apply = useStudio.getState().apply;
  const inThisStep = new Set(step.pieces.map((p) => p.id).filter(Boolean));
  const movable = selectedIds.filter((id) => inThisStep.has(id));
  const selectedSplit = movable.length > 0 && movable.length < step.pieces.length;
  const save = (e: FormEvent) => {
    e.preventDefault();
    apply((p) => updateStep(p, model, index, { title, notes, pauseAfter: Number(pauseAfter) }));
    onClose();
  };

  return (
    <div className="bm-step-editor" aria-label={`Edit step ${index + 1}`}>
      <form onSubmit={save}>
        <label className="nx-field">
          Step title
          <input aria-label="Step title" value={title} maxLength={80} placeholder={`Step ${index + 1} (automatic)`} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="nx-field">
          Instructions / notes
          <textarea aria-label="Step notes" value={notes} maxLength={1000} rows={2} placeholder="What should happen in this step?" onChange={(e) => setNotes(e.target.value)} />
        </label>
        <label className="nx-field">
          Pause after this step
          <span className="bm-step-hold">
            <input
              aria-label="Pause after step in seconds"
              type="number"
              min={0}
              max={10}
              step={0.1}
              value={pauseAfter}
              onChange={(e) => setPauseAfter(e.target.value)}
            />
            <span className="nx-hint">seconds (0–10); adds time to the MP4</span>
          </span>
        </label>
        <div className="bm-step-actions">
          <button className="nx-btn nx-sm nx-primary" type="submit"><Ic name="check" /> Save changes</button>
          <button className="nx-btn nx-sm" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
      <div className="bm-step-editor-divider" />
      <div className="bm-step-editor-heading">Piece order <span className="nx-count">{step.pieces.length}</span></div>
      <p className="nx-fine">Use the arrows to change the arrival order. Select pieces in the 3D view to move or split them.</p>
      <div className="bm-step-pieces">
        {step.pieces.map((item, k) => (
          <div className={`bm-step-piece ${item.id && selectedIds.includes(item.id) ? 'sel' : ''}`} key={item.id ?? k} aria-selected={!!item.id && selectedIds.includes(item.id)}>
            <span className="bm-piece-index">{k + 1}</span>
            <button
              className="bm-piece-select"
              title="Select and frame this part"
              aria-label={`Select piece ${k + 1}`}
              onClick={() => {
                if (!item.id) return;
                useStudio.getState().select([item.id]);
                useStudio.getState().setCurrentStep(index);
                useStudio.getState().requestFocus([item.id]);
              }}
            >
              {isSub(item) ? `Submodel · ${item.submodel}` : `Part · ${item.part}`}
            </button>
            <button className="nx-icon" aria-label={`Move piece ${k + 1} earlier`} title="Earlier in this step" disabled={k === 0} onClick={() => apply((p) => reorderItemInStep(p, model, index, k, k - 1))}><Ic name="arrowUp" /></button>
            <button className="nx-icon" aria-label={`Move piece ${k + 1} later`} title="Later in this step" disabled={k === step.pieces.length - 1} onClick={() => apply((p) => reorderItemInStep(p, model, index, k, k + 1))}><Ic name="arrowDown" /></button>
          </div>
        ))}
      </div>
      <div className="bm-step-actions bm-step-structure">
        <button
          className="nx-btn nx-sm"
          disabled={step.pieces.length < 2}
          title={selectedSplit ? 'Move the selected pieces into a new step after this one' : 'Divide the step into two halves'}
          onClick={() => {
            apply((p) => splitStep(p, model, index, selectedSplit ? movable : []));
            useStudio.getState().setCurrentStep(index + 1);
            onClose();
          }}
        ><Ic name="plus" /> {selectedSplit ? 'Split selected' : 'Split in two'}</button>
        <button
          className="nx-btn nx-sm"
          disabled={!hasNext}
          title="Merge this step with the next step, keeping every piece"
          onClick={() => {
            apply((p) => mergeSteps(p, model, index));
            useStudio.getState().setCurrentStep(index);
            onClose();
          }}
        ><Ic name="copy" /> Merge with next</button>
      </div>
    </div>
  );
}

type DragState = { from: number; startX: number; startY: number; moved: boolean };
type DropSpot = { row: number; after: boolean };

/** Move a draggable row relative to an insertion line, not the hovered row's identity. */
export function destinationForDrop(from: number, spot: DropSpot): number {
  const boundary = spot.row + (spot.after ? 1 : 0);
  return from < boundary ? boundary - 1 : boundary;
}

/** Steps can be rearranged by mouse/touch drag handles or by accessible up/down buttons. */
export function StepsPanel({ timeline = null }: { timeline?: Timeline | null }) {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const currentStep = useStudio((s) => s.currentStep);
  const selection = useStudio((s) => s.selection);
  const { apply, setCurrentStep, setEditingModel, reorderBuildStep } = useStudio.getState();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editAt, setEditAt] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; i: number } | null>(null);
  const [dropSpot, setDropSpot] = useState<DropSpot | null>(null);
  const drag = useRef<DragState | null>(null);
  const dropRef = useRef<DropSpot | null>(null);
  const setDrop = (spot: DropSpot | null) => { dropRef.current = spot; setDropSpot(spot); };
  const steps = modelSteps(plan, editingModel);
  const hasSelection = selection.ids.length > 0 && selection.model === editingModel;

  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  const pause = () => usePlayback.getState().set({ playing: false });
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= steps.length) return;
    pause();
    setEditAt(null);
    reorderBuildStep(editingModel, from, to);
  };

  const onPointerDown = (e: RPointerEvent<HTMLButtonElement>, from: number) => {
    if (e.button !== 0) return;
    drag.current = { from, startX: e.clientX, startY: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: RPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return;
    d.moved = true;
    // ElementFromPoint works even when pointer capture stays on the drag grip.
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-bm-step-index]');
    if (!target) return setDrop(null);
    const row = Number(target.dataset.bmStepIndex);
    if (!Number.isInteger(row)) return;
    const bounds = target.getBoundingClientRect();
    setDrop({ row, after: e.clientY >= bounds.top + bounds.height / 2 });
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved && dropRef.current) move(d.from, destinationForDrop(d.from, dropRef.current));
    setDrop(null);
  };
  const add = (at: number) => {
    pause();
    apply((p) => insertStep(p, editingModel, at));
    setCurrentStep(at);
    setEditAt(`${editingModel}:${at}`);
  };
  const remove = (at: number) => {
    pause();
    apply((p) => deleteStep(p, editingModel, at));
    setCurrentStep(steps.length <= 1 ? null : Math.min(at, steps.length - 2));
    setEditAt(null);
  };

  return (
    <div className="nx-pane">
      <PaneHead id="steps" title="Steps" count={steps.length}
        help={<>Drag the grip to change the build sequence. Use the pencil to edit titles, timing, notes or piece order. Keys: <kbd>,</kbd> / <kbd>.</kbd> previous / next step. All changes are undoable; the timeline and MP4 follow the new sequence.</>}>
        <button className={`nx-btn nx-sm ${currentStep === null ? 'nx-primary' : ''}`} title="Show every step" onClick={() => setCurrentStep(null)}>All</button>
      </PaneHead>
      {editingModel && (
        <div className="bm-crumb">
          <button className="nx-link" onClick={() => { setEditingModel(''); setEditAt(null); }}>Main model</button>
          <Ic name="right" /><strong>{editingModel}</strong>
        </div>
      )}
      {steps.some((s) => s.pieces.length > LARGE_STEP) && (
        <div className="bm-banner" role="note">
          <span>
            {steps.length === 1 ? 'All parts are in one step.' : 'Some steps have many parts.'} Builds read better (and animate more smoothly) with smaller steps.
          </span>
          <button className="nx-btn nx-sm" onClick={() => { pause(); setEditAt(null); apply((p) => autoSplitSteps(p, editingModel, metricsOf, getColors())); setCurrentStep(null); }}>
            <Ic name="wand" /> Auto-split into layers
          </button>
        </div>
      )}
      <ol className="bm-steps" aria-label="Build steps">
        {steps.map((step, i) => {
          const subs = subsIn(step);
          const active = currentStep === i;
          const editing = editAt === `${editingModel}:${i}`;
          const before = dropSpot?.row === i && !dropSpot.after;
          const after = dropSpot?.row === i && dropSpot.after;
          return (
            <li
              key={`${editingModel}:${i}`}
              data-bm-step-index={i}
              className={`bm-step-row ${active ? 'active' : ''} ${editing ? 'editing' : ''} ${menu?.i === i ? 'menu-open' : ''} ${before ? 'bm-drop-before' : ''} ${after ? 'bm-drop-after' : ''}`}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, i }); }}
            >
              <div className="bm-step-main">
                <button
                  className="bm-drag-grip"
                  aria-label={`Drag step ${i + 1} to reorder`}
                  title="Drag to reorder (works with mouse and touch)"
                  onPointerDown={(e) => onPointerDown(e, i)}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => { drag.current = null; setDrop(null); }}
                ><Ic name="grip" /></button>
                <button className="bm-step-btn" aria-label={`Step ${i + 1} · ${step.pieces.length} pieces`} title={step.title ? `Step ${i + 1} · ${step.title}` : `Step ${i + 1}`} onClick={() => setCurrentStep(i)}>
                  <span className="bm-step-no" aria-hidden="true">{i + 1}</span>
                  <span className="bm-step-label">
                    <strong>{step.title || `Step ${i + 1}`}</strong>
                    {step.pauseAfter ? <span className="nx-hint">+{step.pauseAfter}s hold</span> : null}
                  </span>
                  <span className="bm-step-count" title={`${step.pieces.length} piece${step.pieces.length === 1 ? '' : 's'}`}>{step.pieces.length}</span>
                </button>
                <div className="bm-step-tools">
                  {hasSelection && (
                    <button className="nx-icon bm-step-here" title="Move selected pieces here" aria-label={`Move selection to step ${i + 1}`} onClick={() => { pause(); apply((p) => moveItemsToStep(p, editingModel, selection.ids, i)); setCurrentStep(i); }}><Ic name="moveHere" /></button>
                  )}
                  <button
                    className="nx-icon"
                    title="Play this step"
                    aria-label={`Play step ${i + 1}`}
                    disabled={!stepRange(timeline, i)}
                    onClick={() => {
                      const r = stepRange(timeline, i);
                      if (!r) return;
                      setCurrentStep(i);
                      // plays where you are: in the Build view with your camera, or in the preview
                      playRange(r[0] - 0.25, r[1] + (step.pauseAfter ?? 0) + 0.35);
                    }}
                  ><Ic name="play" /></button>
                  <button className="nx-icon bm-step-edit" title="Edit this step" aria-label={`Edit step ${i + 1}`} aria-expanded={editing} onClick={() => { setCurrentStep(i); setEditAt(editing ? null : `${editingModel}:${i}`); }}><Ic name="edit" /></button>
                  <button className="nx-icon" title="More" aria-label={`More for step ${i + 1}`} aria-haspopup="menu"
                    onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, i }); }}><Ic name="more" /></button>
                </div>
              </div>
              {editing && (
                <StepEditor key={`${editingModel}:${i}`} step={step} index={i} model={editingModel} hasNext={i < steps.length - 1} selectedIds={hasSelection ? selection.ids : []} onClose={() => setEditAt(null)} />
              )}
              {subs.map((name) => {
                const key = `${i}:${name}`;
                const isOpen = open.has(key);
                return (
                  <Fragment key={name}>
                    <button className="bm-sub-toggle" aria-label={`${isOpen ? 'Hide' : 'Show'} steps of ${name}`} title={`Submodel ${name}`} onClick={() => toggle(key)}>
                      <Ic name={isOpen ? 'chevron' : 'right'} /><Ic name="box" />{name}
                    </button>
                    {isOpen && (
                      <div className="bm-sub-steps">
                        {modelSteps(plan, name).map((s, j) => (
                          <button key={j} className="bm-sub-step" onClick={() => { setEditingModel(name); setCurrentStep(j); setEditAt(null); }}>
                            {s.title || `${name} step ${j + 1}`} <span className="nx-hint">· {s.pieces.length}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </li>
          );
        })}
      </ol>
      {menu && steps[menu.i] && (
        <ContextMenu x={menu.x} y={menu.y} label={`Step ${menu.i + 1} menu`} onClose={() => setMenu(null)} items={[
          { heading: steps[menu.i].title ? `Step ${menu.i + 1} · ${steps[menu.i].title}` : `Step ${menu.i + 1}` },
          { icon: 'pointer', label: 'Select its pieces', disabled: !steps[menu.i].pieces.length, onClick: () => { useStudio.getState().select(steps[menu.i].pieces.flatMap((item) => item.id ? [item.id] : [])); setCurrentStep(menu.i); } },
          { icon: 'edit', label: 'Edit…', onClick: () => { setCurrentStep(menu.i); setEditAt(`${editingModel}:${menu.i}`); } },
          'sep',
          { icon: 'plus', label: 'Insert a step before', onClick: () => add(menu.i) },
          { icon: 'plus', label: 'Insert a step after', onClick: () => add(menu.i + 1) },
          'sep',
          { icon: 'arrowUp', label: 'Move earlier', disabled: menu.i === 0, onClick: () => move(menu.i, menu.i - 1) },
          { icon: 'arrowDown', label: 'Move later', disabled: menu.i === steps.length - 1, onClick: () => move(menu.i, menu.i + 1) },
          'sep',
          { icon: 'trash', label: steps.length > 1 ? 'Delete (pieces join the step before)' : 'Delete', danger: true, disabled: steps.length <= 1 && steps[menu.i].pieces.length > 0, onClick: () => remove(menu.i) },
        ]} />
      )}
      {steps.length === 0 && <p className="nx-fine">No steps yet. Add a step, then insert parts from the Parts panel.</p>}
      <button className="nx-btn bm-add-step" aria-label="Add a step at the end" onClick={() => add(steps.length)}><Ic name="plus" /> Add step</button>
    </div>
  );
}
