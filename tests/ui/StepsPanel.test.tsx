// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Plan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';
import { StepsPanel } from '../../src/ui/StepsPanel';
import { usePlayback } from '../../src/state/playback';
import { modelSteps } from '../../src/plan/ops';

const piece = (id: string) => ({ id, part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 as const });
const plan: Plan = {
  format: 'brickmotion-plan',
  version: 1,
  name: 't',
  submodels: { engine: { steps: [{ pieces: [piece('e1')] }, { pieces: [piece('e2')] }] } },
  steps: [{ pieces: [piece('a')] }, { pieces: [piece('b'), piece('c')] }, { pieces: [{ id: 's', submodel: 'engine', x: 0, y: 0, z: 0, rot: 0 }] }],
};

beforeEach(() => useStudio.getState().setPlan(plan, { resetHistory: true }));
afterEach(cleanup);

test('renders one chip per step plus All', () => {
  render(<StepsPanel />);
  expect(screen.getAllByRole('button', { name: /^Step \d+/ })).toHaveLength(3);
  expect(screen.getByRole('button', { name: 'All' })).toBeTruthy();
});

test('the step menu moves a whole step before another step, pieces untouched', () => {
  render(<StepsPanel />);
  fireEvent.contextMenu(screen.getByRole('button', { name: /^Step 3/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Move this step before/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Step 1' }));
  const steps = modelSteps(useStudio.getState().plan, '');
  expect(steps.map((s) => s.pieces.map((p) => p.id ?? (p as { submodel?: string }).submodel).join(',')))
    .toEqual(['s', 'a', 'b,c']);
});

test('the step menu moves a step to the playhead', () => {
  const timeline = { steps: [
    { model: '', index: 0, start: 0, end: 1 },
    { model: '', index: 1, start: 1, end: 2 },
    { model: '', index: 2, start: 2, end: 3 },
  ] } as never;
  usePlayback.getState().set({ t: 2.5, playing: false });
  render(<StepsPanel timeline={timeline} />);
  fireEvent.contextMenu(screen.getByRole('button', { name: /^Step 1/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Move before step 3 \(the playhead\)/ }));
  const steps = modelSteps(useStudio.getState().plan, '');
  expect(steps.map((s) => s.pieces.map((p) => p.id ?? (p as { submodel?: string }).submodel).join(',')))
    .toEqual(['b,c', 'a', 's']);
});

test('clicking a chip shows the model up to that step', () => {
  render(<StepsPanel />);
  fireEvent.click(screen.getByRole('button', { name: /^Step 2/ }));
  expect(useStudio.getState().currentStep).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(useStudio.getState().currentStep).toBeNull();
});

test('a submodel chip expands to show its own steps', () => {
  render(<StepsPanel />);
  expect(screen.queryByRole('button', { name: /^engine step/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show steps of engine' }));
  expect(screen.getAllByRole('button', { name: /^engine step/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: /^engine step 2/ }));
  expect(useStudio.getState().editingModel).toBe('engine');
  expect(useStudio.getState().currentStep).toBe(1);
});

test('selected pieces can be moved to another step', () => {
  render(<StepsPanel />);
  act(() => useStudio.getState().select(['a']));
  fireEvent.click(screen.getByRole('button', { name: 'Move selection to step 2' }));
  expect(useStudio.getState().plan.steps[1].pieces.map((i) => i.id)).toEqual(['b', 'c', 'a']);
});
