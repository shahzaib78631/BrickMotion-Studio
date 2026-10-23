import { useMemo } from 'react';
import { resolveColor } from '../ldraw/colors';
import { DEFAULT_COLOR } from '../model/assemble';
import type { StepView } from '../model/stepLayout';
import { modelSteps } from '../plan/ops';
import { isSub, type Step } from '../plan/types';
import { getColors, partName } from '../state/partService';
import { useStudio } from '../state/store';
import { playRange, usePlayback } from '../state/playback';
import { stepRange } from '../anim/partClips';
import type { Timeline } from '../anim/timeline';
import type { ModelState } from '../state/useModel';
import { Ic } from './icons';
import { PartThumb } from './PartThumb';

type Entry = { key: string; part?: string; submodel?: string; color: number; count: number; ids: string[] };

/** Parts list of one step, like the callout box of a printed instruction step. */
export function stepParts(step: Step): Entry[] {
  const colors = getColors();
  const map = new Map<string, Entry>();
  for (const item of step.pieces) {
    if (isSub(item)) {
      const key = `sub|${item.submodel}`;
      const e = map.get(key);
      if (e) e.count++;
      else map.set(key, { key, submodel: item.submodel, color: DEFAULT_COLOR, count: 1, ids: [] });
      if (item.id) map.get(key)!.ids.push(item.id);
      continue;
    }
    const color = item.color === 16 || item.color === '16' ? DEFAULT_COLOR : (resolveColor(colors, item.color) ?? DEFAULT_COLOR);
    const key = `${item.part}|${color}`;
    const e = map.get(key);
    if (e) e.count++;
    else map.set(key, { key, part: item.part, color, count: 1, ids: [] });
    if (item.id) map.get(key)!.ids.push(item.id);
  }
  return [...map.values()];
}

const VIEWS: [StepView, string, string][] = [
  ['separated', 'Separated', 'New parts wait on the floor in front of the model'],
  ['exploded', 'Exploded', 'New parts float just above where they go'],
  ['assembled', 'Assembled', 'Everything in place'],
];

/** Shown over the Build view while one step is selected. */
export function StepCallout({ model, timeline = null }: { model: ModelState; timeline?: Timeline | null }) {
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const currentStep = useStudio((s) => s.currentStep);
  const stepView = useStudio((s) => s.stepView);
  const follow = usePlayback((s) => s.follow);
  const playing = usePlayback((s) => s.playing);
  const selection = useStudio((s) => s.selection);
  const steps = modelSteps(plan, editingModel);
  const step = currentStep === null ? undefined : steps[currentStep];
  const parts = useMemo(() => (step ? stepParts(step) : []), [step]);
  if (!model.ready || currentStep === null || !step) return null;
  const st = useStudio.getState();
  const total = step.pieces.length;
  const range = stepRange(timeline, currentStep);
  // following the timeline, the arrows move the playhead; otherwise they lay out the next step
  const goTo = (i: number) => {
    const r = follow ? stepRange(timeline, i) : null;
    if (!r) return st.setCurrentStep(i);
    usePlayback.getState().set({ t: r[0], playing: false });
    useStudio.setState({ currentStep: i });
  };
  return (
    <div className="bm-callout" aria-label={`Step ${currentStep + 1} parts`}>
      <div className="bm-callout-head">
        <button className="nx-icon" aria-label="Previous step" title="Previous step (,)" disabled={currentStep === 0} onClick={() => goTo(currentStep - 1)}>
          <Ic name="prev" />
        </button>
        <div className="bm-callout-title">
          <strong>
            Step {currentStep + 1}
            <span className="nx-hint"> / {steps.length}</span>
          </strong>
          {step.title && <span className="bm-callout-sub">{step.title}</span>}
        </div>
        <button className="nx-icon" aria-label="Next step" title="Next step (.)" disabled={currentStep >= steps.length - 1} onClick={() => goTo(currentStep + 1)}>
          <Ic name="next" />
        </button>
        <button className="nx-icon" aria-label="Show all steps" title="Show the whole model (/)" onClick={() => st.setCurrentStep(null)}>
          <Ic name="x" />
        </button>
      </div>
      {step.notes && <p className="bm-callout-notes">{step.notes}</p>}
      <div className="bm-callout-parts" aria-label={`${total} part${total === 1 ? '' : 's'} in this step`}>
        {parts.map((p) => {
          const chosen = selection.model === editingModel ? p.ids.filter((id) => selection.ids.includes(id)).length : 0;
          return (
          <div key={p.key} className={`bm-callout-part ${chosen ? 'sel' : ''}`} aria-selected={chosen > 0}
            title={`${p.submodel ? `Submodel ${p.submodel} — double-click to open it` : `${partName(p.part!)} (${p.part})`}${chosen ? ` · ${chosen} selected` : ''}. Click to select${p.count > 1 ? ' them' : ' it'}.`}
            onClick={(e) => st.select(p.ids, e.shiftKey)}
            onDoubleClick={() => p.submodel && st.setEditingModel(p.submodel)}>
            {p.submodel ? <span className="bm-callout-sub-ic"><Ic name="box" /></span> : <PartThumb id={p.part!} color={p.color} size={36} />}
            <span className="bm-callout-count">{p.count}×</span>
            {p.submodel && <span className="bm-callout-subname">{p.submodel}</span>}
          </div>
          );
        })}
        {!parts.length && <span className="nx-hint">Empty step</span>}
      </div>
      <div className="bm-callout-play">
        {playing && follow ? (
          <button className="nx-btn nx-sm" onClick={() => usePlayback.getState().set({ playing: false })} title="Stop here: the pieces stay where they are, ready to edit">
            <Ic name="pause" /> Stop
          </button>
        ) : (
          <>
            <button className="nx-btn nx-sm nx-primary" title="Play this step here, with your current camera" disabled={!range} onClick={() => range && playRange(range[0] - 0.25, range[1] + (step.pauseAfter ?? 0) + 0.35)}>
              <Ic name="play" /> Play step
            </button>
            <button
              className="nx-btn nx-sm"
              title="Play from this step to the end, with your current camera"
              disabled={!range}
              onClick={() => range && usePlayback.getState().set({ t: Math.max(0, range[0] - 0.25), playing: true, stopAt: null, loopFrom: null, follow: true })}
            >
              <Ic name="next" /> Play from here
            </button>
          </>
        )}
      </div>
      {follow && <p className="nx-fine bm-callout-follow">Showing the build at the playhead. Pick a view below to lay this step out instead.</p>}
      <div className="nx-seg bm-callout-views" role="radiogroup" aria-label="Show the step's new parts">
        {VIEWS.map(([id, label, hint]) => (
          <button key={id} role="radio" aria-checked={!follow && stepView === id} className={!follow && stepView === id ? 'on' : ''} title={hint} onClick={() => {
            usePlayback.getState().set({ follow: false, playing: false });
            st.setStepView(id);
          }}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
