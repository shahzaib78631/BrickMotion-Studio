import { runCommand } from '../state/editing';
import { findItem, modelSteps } from '../plan/ops';
import { connectedIds, movePiecesToNewStep, movePiecesToStep, similarIds, stepsOf } from '../plan/pieceActions';
import { isSub, type Plan, type PlanItem } from '../plan/types';
import { getColors, metricsOf, partName } from '../state/partService';
import { useStudio } from '../state/store';
import type { ContextItem } from './ContextMenu';
import { viewportApi } from './viewportApi';

const stepLabel = (plan: Plan, model: string, i: number) => {
  const title = modelSteps(plan, model)[i]?.title;
  return title ? `Step ${i + 1} · ${title}` : `Step ${i + 1}`;
};

const itemName = (item: PlanItem) => (isSub(item) ? `${item.submodel} (submodel)` : `${partName(item.part)} (${item.part})`);

/** Moves the pieces and shows the step they landed in, still selected. */
function moveTo(ids: string[], where: { step: number } | { newAt: number }) {
  const st = useStudio.getState();
  const m = st.editingModel;
  let landed = 0;
  st.apply((p) => {
    const r = 'step' in where ? movePiecesToStep(p, m, ids, where.step) : movePiecesToNewStep(p, m, ids, where.newAt);
    landed = r.step;
    return r.plan;
  });
  st.select(ids);
  if (st.currentStep !== null) st.setCurrentStep(landed);
}

/**
 * The right-click menu for pieces in the Build view: `ids` are the pieces it acts on
 * (the selection, which includes the piece clicked).
 */
export function pieceMenuItems(ids: string[]): ContextItem[] {
  const st = useStudio.getState();
  const { plan, editingModel: m } = st;
  const steps = modelSteps(plan, m);
  const first = findItem(plan, m, ids[0]);
  if (!first) return [];
  const inSteps = stepsOf(plan, m, ids);
  const one = ids.length === 1;
  const only = inSteps.length === 1 ? inSteps[0] : null;
  const all = steps.flatMap((s) => s.pieces.map((i) => i.id).filter((x): x is string => !!x));
  const hiddenCount = st.hidden[m]?.length ?? 0;
  const where = only === null ? `in steps ${inSteps.map((s) => s + 1).join(', ')}` : `in step ${only + 1}`;

  const moveSteps: ContextItem[] = steps.map((_, i) => ({
    icon: i === only ? 'check' : 'steps',
    label: stepLabel(plan, m, i),
    disabled: i === only,
    current: i === only,
    onClick: () => moveTo(ids, { step: i }),
  }));
  const lo = inSteps[0];
  const hi = inSteps[inSteps.length - 1];
  const newStep: ContextItem[] = [
    { icon: 'raise', label: `Before step ${lo + 1}`, onClick: () => moveTo(ids, { newAt: lo }) },
    { icon: 'lower', label: `After step ${hi + 1}`, onClick: () => moveTo(ids, { newAt: hi + 1 }) },
    'sep',
    { icon: 'next', label: 'At the start', onClick: () => moveTo(ids, { newAt: 0 }) },
    { icon: 'next', label: 'At the end', onClick: () => moveTo(ids, { newAt: steps.length }) },
  ];
  const select: ContextItem[] = [
    { icon: 'brick', label: isSub(first.item) ? 'Same submodel' : 'Same part', onClick: () => st.select(similarIds(plan, m, ids[0], 'part')) },
    { icon: 'paste', label: 'Same colour', disabled: isSub(first.item), onClick: () => st.select(similarIds(plan, m, ids[0], 'color')) },
    { icon: 'widen', label: one ? 'Touching it' : 'Touching them', onClick: () => st.select(connectedIds(plan, m, ids, 'touching', metricsOf, getColors())) },
    { icon: 'components', label: one ? 'Everything connected to it' : 'Everything connected to them', onClick: () => st.select(connectedIds(plan, m, ids, 'connected', metricsOf, getColors())) },
    'sep',
    { icon: 'steps', label: `Everything in step ${first.step + 1}`, onClick: () => st.select(similarIds(plan, m, ids[0], 'step')) },
    { icon: 'components', label: 'Everything', onClick: () => st.select(all) },
  ];

  return [
    { heading: one ? itemName(first.item) : `${ids.length} pieces` },
    { heading: where },
    { icon: 'fit', label: 'Frame in view', onClick: () => st.requestFocus(ids) },
    ...(one && isSub(first.item)
      ? [{ icon: 'box' as const, label: `Open submodel “${first.item.submodel}”`, onClick: () => st.setEditingModel((first.item as { submodel: string }).submodel) }]
      : []),
    { icon: 'steps', label: 'Show its step', disabled: only === null, onClick: () => only !== null && st.setCurrentStep(only) },
    { icon: 'steps', label: 'Lay out its step', disabled: only === null, onClick: () => { if (only === null) return; st.setCurrentStep(only); st.setStepView('laidout'); } },
    st.laidOut
      ? { icon: 'steps', label: 'Put all parts back', onClick: () => st.setLaidOut(false) }
      : { icon: 'steps', label: 'Lay out all parts', onClick: () => st.setLaidOut(true) },
    'sep',
    { icon: 'steps', label: 'Move to step', items: moveSteps, disabled: steps.length < 2 && only !== null },
    { icon: 'plus', label: 'Move to a new step', items: newStep },
    'sep',
    { icon: 'rotate', label: 'Rotate 90°', hint: 'R', onClick: () => runCommand({ kind: 'rotate' }) },
    { icon: 'raise', label: 'Raise one plate', hint: 'PgUp', onClick: () => runCommand({ kind: 'move', d: { x: 0, y: 1, z: 0 } }) },
    { icon: 'lower', label: 'Lower one plate', hint: 'PgDn', onClick: () => runCommand({ kind: 'move', d: { x: 0, y: -1, z: 0 } }) },
    { icon: 'copy', label: 'Duplicate', hint: '⌘D', onClick: () => runCommand({ kind: 'duplicate' }) },
    ...(one && !isSub(first.item)
      ? [{ icon: 'paste' as const, label: 'Use its colour for new pieces', onClick: () => st.setPaintColor((first.item as { color: string | number }).color) }]
      : []),
    'sep',
    { icon: 'eyeOff', label: one ? 'Hide' : `Hide ${ids.length} pieces`, hint: 'H', onClick: () => st.hide(ids) },
    { icon: 'eye', label: 'Hide everything else', disabled: ids.length >= all.length, onClick: () => st.isolate(ids, all) },
    { icon: 'eye', label: hiddenCount ? `Show ${hiddenCount} hidden` : 'Show hidden', hint: '⇧H', disabled: !hiddenCount, onClick: () => st.showAll() },
    'sep',
    { icon: 'pointer', label: 'Select', items: select },
    'sep',
    { icon: 'trash', label: one ? 'Delete' : `Delete ${ids.length} pieces`, hint: 'Del', danger: true, onClick: () => runCommand({ kind: 'delete' }) },
  ];
}

/** The right-click menu on empty space in the Build view. */
export function emptyMenuItems(): ContextItem[] {
  const st = useStudio.getState();
  const { plan, editingModel: m } = st;
  const all = modelSteps(plan, m).flatMap((s) => s.pieces.map((i) => i.id).filter((x): x is string => !!x));
  const hiddenCount = st.hidden[m]?.length ?? 0;
  return [
    { icon: 'fit', label: 'Fit everything in view', hint: 'F', onClick: () => viewportApi.fit() },
    { icon: 'components', label: 'Select everything', disabled: !all.length, onClick: () => st.select(all) },
    { icon: 'x', label: 'Clear selection', hint: 'Esc', disabled: !st.selection.ids.length, onClick: () => st.select([]) },
    'sep',
    { icon: 'eye', label: hiddenCount ? `Show ${hiddenCount} hidden` : 'Show hidden', hint: '⇧H', disabled: !hiddenCount, onClick: () => st.showAll() },
    { icon: 'steps', label: 'Show every step', hint: '/', disabled: st.currentStep === null, onClick: () => st.setCurrentStep(null) },
    st.laidOut
      ? { icon: 'steps', label: 'Put all parts back', onClick: () => st.setLaidOut(false) }
      : { icon: 'steps', label: 'Lay out all parts', disabled: !all.length, onClick: () => st.setLaidOut(true) },
  ];
}
