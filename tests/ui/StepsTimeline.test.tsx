// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Plan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';
import { StepsTimeline } from '../../src/ui/StepsTimeline';

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
  render(<StepsTimeline />);
  expect(screen.getAllByRole('button', { name: /^Step \d+/ })).toHaveLength(3);
  expect(screen.getByRole('button', { name: 'All' })).toBeTruthy();
});

test('clicking a chip shows the model up to that step', () => {
  render(<StepsTimeline />);
  fireEvent.click(screen.getByRole('button', { name: /^Step 2/ }));
  expect(useStudio.getState().currentStep).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(useStudio.getState().currentStep).toBeNull();
});

test('a submodel chip expands to show its own steps', () => {
  render(<StepsTimeline />);
  expect(screen.queryByRole('button', { name: /^engine step/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show steps of engine' }));
  expect(screen.getAllByRole('button', { name: /^engine step/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: /^engine step 2/ }));
  expect(useStudio.getState().editingModel).toBe('engine');
  expect(useStudio.getState().currentStep).toBe(1);
});

test('selected pieces can be moved to another step', () => {
  render(<StepsTimeline />);
  act(() => useStudio.getState().select(['a']));
  fireEvent.click(screen.getByRole('button', { name: 'Move selection to step 2' }));
  expect(useStudio.getState().plan.steps[1].pieces.map((i) => i.id)).toEqual(['b', 'c', 'a']);
});
