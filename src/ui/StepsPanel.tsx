import { Fragment, useState } from 'react';
import { deleteStep, insertStep, modelSteps, moveItemsToStep, reorderStep } from '../plan/ops';
import { isSub, type Step } from '../plan/types';
import { useStudio } from '../state/store';
import { Ic } from './icons';

function subsIn(step: Step): string[] {
  return [...new Set(step.pieces.filter(isSub).map((i) => i.submodel))];
}

/** The build steps of the model being edited: pick one to edit, reorder, insert, delete, move the selection. */
export function StepsPanel() {
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
    <div className="nx-pane">
      <div className="nx-pane-head">
        <h3>
          Steps <span className="nx-count">{steps.length}</span>
        </h3>
        <button className={`nx-btn nx-sm ${currentStep === null ? 'nx-primary' : ''}`} onClick={() => setCurrentStep(null)}>
          All
        </button>
      </div>
      {editingModel && (
        <div className="bm-crumb">
          <button className="nx-link" onClick={() => setEditingModel('')}>
            Main model
          </button>
          <Ic name="right" />
          <strong>{editingModel}</strong>
        </div>
      )}
      <p className="nx-fine">Pick a step to see the model up to it; new pieces go into that step. Drag to reorder.</p>
      <ol className="bm-steps" aria-label="Build steps">
        {steps.map((step, i) => {
          const subs = subsIn(step);
          const active = currentStep === i;
          return (
            <li
              key={i}
              className={`bm-step-row ${active ? 'active' : ''}`}
              draggable
              onDragStart={() => setDragFrom(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom !== null && dragFrom !== i) apply((p) => reorderStep(p, editingModel, dragFrom, i));
                setDragFrom(null);
              }}
            >
              <div className="bm-step-main">
                <button className="bm-step-btn" onClick={() => setCurrentStep(i)}>
                  <span className="bm-step-no" aria-hidden="true">
                    {i + 1}
                  </span>
                  Step {i + 1}
                  <span className="nx-hint">
                    · {step.pieces.length} piece{step.pieces.length === 1 ? '' : 's'}
                  </span>
                </button>
                {hasSelection && (
                  <button
                    className="nx-icon"
                    title="Move selected pieces here"
                    aria-label={`Move selection to step ${i + 1}`}
                    onClick={() => apply((p) => moveItemsToStep(p, editingModel, selection.ids, i))}
                  >
                    <Ic name="moveHere" />
                  </button>
                )}
                <button
                  className="nx-icon bm-reveal"
                  title="Insert a step before this one"
                  aria-label={`Insert step before step ${i + 1}`}
                  onClick={() => apply((p) => insertStep(p, editingModel, i))}
                >
                  <Ic name="plus" />
                </button>
                {(step.pieces.length === 0 || active) && (
                  <button
                    className="nx-icon"
                    title="Delete step (its pieces join the previous step)"
                    aria-label={`Delete step ${i + 1}`}
                    onClick={() => {
                      apply((p) => deleteStep(p, editingModel, i));
                      setCurrentStep(null);
                    }}
                  >
                    <Ic name="trash" />
                  </button>
                )}
              </div>
              {subs.map((name) => {
                const key = `${i}:${name}`;
                const isOpen = open.has(key);
                return (
                  <Fragment key={name}>
                    <button
                      className="bm-sub-toggle"
                      aria-label={`${isOpen ? 'Hide' : 'Show'} steps of ${name}`}
                      title={`Submodel ${name}`}
                      onClick={() => toggle(key)}
                    >
                      <Ic name={isOpen ? 'chevron' : 'right'} />
                      <Ic name="box" />
                      {name}
                    </button>
                    {isOpen && (
                      <div className="bm-sub-steps">
                        {modelSteps(plan, name).map((s, j) => (
                          <button
                            key={j}
                            className="bm-sub-step"
                            onClick={() => {
                              setEditingModel(name);
                              setCurrentStep(j);
                            }}
                          >
                            {name} step {j + 1} <span className="nx-hint">· {s.pieces.length}</span>
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
      <button className="nx-btn" aria-label="Add a step at the end" onClick={() => apply((p) => insertStep(p, editingModel, steps.length))}>
        <Ic name="plus" /> Add step
      </button>
    </div>
  );
}
