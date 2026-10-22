import { Fragment, useState } from 'react';
import { deleteStep, insertStep, modelSteps, moveItemsToStep, reorderStep } from '../plan/ops';
import { isSub, type Step } from '../plan/types';
import { useStudio } from '../state/store';

function subsIn(step: Step): string[] {
  return [...new Set(step.pieces.filter(isSub).map((i) => i.submodel))];
}

export function StepsTimeline() {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const currentStep = useStudio((s) => s.currentStep);
  const selection = useStudio((s) => s.selection);
  const { apply, setCurrentStep, setEditingModel } = useStudio.getState();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const steps = modelSteps(plan, editingModel);
  const hasSelection = selection.ids.length > 0 && selection.model === editingModel;

  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  return (
    <div className="timeline" role="toolbar" aria-label="Build steps">
      <button className={`chip ${currentStep === null ? 'active' : ''}`} onClick={() => setCurrentStep(null)}>
        All
      </button>
      {steps.map((step, i) => {
        const subs = subsIn(step);
        return (
          <Fragment key={i}>
            <button className="chip-add" title="Insert a step here" aria-label={`Insert step before step ${i + 1}`} onClick={() => apply((p) => insertStep(p, editingModel, i))}>
              +
            </button>
            <div
              className={`chip-wrap ${currentStep === i ? 'active' : ''}`}
              draggable
              onDragStart={() => setDragFrom(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom !== null && dragFrom !== i) apply((p) => reorderStep(p, editingModel, dragFrom, i));
                setDragFrom(null);
              }}
            >
              <button className={`chip ${currentStep === i ? 'active' : ''}`} onClick={() => setCurrentStep(i)}>
                Step {i + 1} <span className="muted">· {step.pieces.length}</span>
              </button>
              {hasSelection && (
                <button className="chip-mini" title="Move selected pieces here" aria-label={`Move selection to step ${i + 1}`} onClick={() => apply((p) => moveItemsToStep(p, editingModel, selection.ids, i))}>
                  ⤵
                </button>
              )}
              {(step.pieces.length === 0 || currentStep === i) && (
                <button
                  className="chip-mini"
                  title="Delete step (its pieces join the previous step)"
                  aria-label={`Delete step ${i + 1}`}
                  onClick={() => {
                    apply((p) => deleteStep(p, editingModel, i));
                    setCurrentStep(null);
                  }}
                >
                  ×
                </button>
              )}
              {subs.map((name) => {
                const key = `${i}:${name}`;
                const isOpen = open.has(key);
                return (
                  <Fragment key={name}>
                    <button className="chip-mini sub" aria-label={`${isOpen ? 'Hide' : 'Show'} steps of ${name}`} title={`Submodel ${name}`} onClick={() => toggle(key)}>
                      {isOpen ? '▾' : '▸'} {name}
                    </button>
                    {isOpen &&
                      modelSteps(plan, name).map((s, j) => (
                        <button
                          key={j}
                          className="chip sub"
                          onClick={() => {
                            setEditingModel(name);
                            setCurrentStep(j);
                          }}
                        >
                          {name} step {j + 1} <span className="muted">· {s.pieces.length}</span>
                        </button>
                      ))}
                  </Fragment>
                );
              })}
            </div>
          </Fragment>
        );
      })}
      <button className="chip-add" aria-label="Add a step at the end" title="Add a step at the end" onClick={() => apply((p) => insertStep(p, editingModel, steps.length))}>
        +
      </button>
    </div>
  );
}
