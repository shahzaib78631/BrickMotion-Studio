import { deleteStep, findItem, insertStep, mergeSteps, modelSteps, moveItemTo, splitStep, splitStepAt } from '../plan/ops';
import { isSub } from '../plan/types';
import { runCommand } from '../state/editing';
import { usePlayback } from '../state/playback';
import { partName } from '../state/partService';
import { useStudio } from '../state/store';
import type { ContextItem } from './ContextMenu';
import { hasOwnMotion, saveMotion, type MotionTarget } from './MotionEditor';
import { moveTo } from './PieceMenu';

const stop = () => usePlayback.getState().set({ playing: false });

/**
 * Right-click menu for part clips on the timeline. `ids` are the clips it acts on
 * (the selection when the clicked clip is in it). `onMotion` opens the motion editor.
 */
export function partClipMenu(ids: string[], onMotion: (t: MotionTarget) => void): ContextItem[] {
  const st = useStudio.getState();
  const { plan, editingModel: m } = st;
  const steps = modelSteps(plan, m);
  const first = findItem(plan, m, ids[0]);
  if (!first) return [];
  const one = ids.length === 1;
  const at = first.step;
  const index = steps[at].pieces.findIndex((i) => i.id === ids[0]);
  const count = steps[at].pieces.length;
  const sameStep = ids.every((id) => findItem(plan, m, id)?.step === at);
  const name = isSub(first.item) ? `${first.item.submodel} (submodel)` : `${partName(first.item.part)} (${first.item.part})`;
  const target: MotionTarget = { kind: 'pieces', model: m, ids };
  const reorder = (to: number) => () => { stop(); st.apply((p) => moveItemTo(p, m, ids[0], at, to)); st.select(ids); };
  const label = (i: number) => (steps[i].title ? `Step ${i + 1} · ${steps[i].title}` : `Step ${i + 1}`);

  return [
    { heading: one ? name : `${ids.length} pieces` },
    { heading: one ? `Step ${at + 1}, arrives ${index + 1} of ${count}` : sameStep ? `In step ${at + 1}` : 'In several steps' },
    { icon: 'fit', label: 'Frame in view', onClick: () => { st.select(ids); st.requestFocus(ids); } },
    'sep',
    { heading: 'Order' },
    { icon: 'steps', label: 'Move to step', disabled: steps.length < 2, items: steps.map((_, i) => ({
      icon: i === at && sameStep ? 'check' as const : 'steps' as const, label: label(i), current: i === at && sameStep,
      disabled: i === at && sameStep, onClick: () => { stop(); moveTo(ids, { step: i }); },
    })) },
    { icon: 'plus', label: 'Move to a new step', items: [
      { icon: 'raise', label: `Before step ${at + 1}`, onClick: () => { stop(); moveTo(ids, { newAt: at }); } },
      { icon: 'lower', label: `After step ${at + 1}`, onClick: () => { stop(); moveTo(ids, { newAt: at + 1 }); } },
      'sep',
      { icon: 'next', label: 'At the start', onClick: () => { stop(); moveTo(ids, { newAt: 0 }); } },
      { icon: 'next', label: 'At the end', onClick: () => { stop(); moveTo(ids, { newAt: steps.length }); } },
    ] },
    { icon: 'widen', label: one ? 'Split step here (this piece starts a new step)' : 'Split these into their own step',
      disabled: one ? index <= 0 : !sameStep || ids.length >= count,
      onClick: () => {
        stop();
        st.apply((p) => (one ? splitStepAt(p, m, at, index) : splitStep(p, m, at, ids)));
        st.select(ids);
        st.setCurrentStep(at + 1);
      } },
    ...(one ? [
      { icon: 'raise' as const, label: 'Arrive earlier', disabled: index <= 0, onClick: reorder(index - 1) },
      { icon: 'lower' as const, label: 'Arrive later', disabled: index >= count - 1, onClick: reorder(index + 1) },
      { icon: 'prev' as const, label: 'Arrive first in its step', disabled: index <= 0, onClick: reorder(0) },
      { icon: 'next' as const, label: 'Arrive last in its step', disabled: index >= count - 1, onClick: reorder(count - 1) },
    ] : []),
    'sep',
    { heading: 'Motion' },
    { icon: 'settings', label: one ? 'Motion for this piece…' : `Motion for ${ids.length} pieces…`, onClick: () => onMotion(target) },
    { icon: 'x', label: 'Use step / project motion', disabled: !hasOwnMotion(target), onClick: () => saveMotion(target, null) },
    'sep',
    { icon: 'trash', label: one ? 'Delete piece' : `Delete ${ids.length} pieces`, danger: true, onClick: () => { st.select(ids); runCommand({ kind: 'delete' }); } },
  ];
}

/** Right-click menu for a step block on the timeline. */
export function stepClipMenu(index: number, onMotion: (t: MotionTarget) => void): ContextItem[] {
  const st = useStudio.getState();
  const { plan, editingModel: m } = st;
  const steps = modelSteps(plan, m);
  const step = steps[index];
  if (!step) return [];
  const ids = step.pieces.flatMap((i) => (i.id ? [i.id] : []));
  const picked = (st.selection.model === m ? st.selection.ids : []).filter((id) => ids.includes(id));
  const target: MotionTarget = { kind: 'step', model: m, index };
  const go = (fn: Parameters<typeof st.apply>[0], show: number | null = index) => () => {
    stop();
    st.apply(fn);
    if (show !== null) st.setCurrentStep(Math.max(0, Math.min(show, modelSteps(useStudio.getState().plan, m).length - 1)));
  };
  return [
    { heading: step.title ? `Step ${index + 1} · ${step.title}` : `Step ${index + 1}` },
    { heading: `${step.pieces.length} piece${step.pieces.length === 1 ? '' : 's'}` },
    { icon: 'pointer', label: 'Select its pieces', disabled: !ids.length, onClick: () => { st.select(ids); st.setCurrentStep(index); } },
    { icon: 'steps', label: 'Show this step', onClick: () => st.setCurrentStep(index) },
    'sep',
    { heading: 'Split and join' },
    { icon: 'widen', label: 'Split in half', disabled: step.pieces.length < 2, onClick: go((p) => splitStep(p, m, index)) },
    { icon: 'widen', label: `Split off the ${picked.length} selected`, disabled: !picked.length || picked.length >= step.pieces.length,
      onClick: go((p) => splitStep(p, m, index, picked), index + 1) },
    { icon: 'components', label: 'Join with the previous step', disabled: index === 0, onClick: go((p) => mergeSteps(p, m, index - 1), index - 1) },
    { icon: 'components', label: 'Join with the next step', disabled: index >= steps.length - 1, onClick: go((p) => mergeSteps(p, m, index)) },
    'sep',
    { heading: 'Order' },
    { icon: 'raise', label: 'Move step earlier', disabled: index === 0, onClick: () => { stop(); st.reorderBuildStep(m, index, index - 1); st.setCurrentStep(index - 1); } },
    { icon: 'lower', label: 'Move step later', disabled: index >= steps.length - 1, onClick: () => { stop(); st.reorderBuildStep(m, index, index + 1); st.setCurrentStep(index + 1); } },
    { icon: 'plus', label: 'Insert an empty step before', onClick: go((p) => insertStep(p, m, index), null) },
    { icon: 'plus', label: 'Insert an empty step after', onClick: go((p) => insertStep(p, m, index + 1), null) },
    'sep',
    { heading: 'Motion' },
    { icon: 'settings', label: 'Motion for this step…', onClick: () => onMotion(target) },
    { icon: 'x', label: 'Use project motion', disabled: !hasOwnMotion(target), onClick: () => saveMotion(target, null) },
    'sep',
    { icon: 'trash', label: steps.length > 1 ? 'Delete step (pieces join the step before)' : 'Delete step', danger: true,
      disabled: steps.length <= 1 && step.pieces.length > 0, onClick: go((p) => deleteStep(p, m, index), index - 1) },
  ];
}
