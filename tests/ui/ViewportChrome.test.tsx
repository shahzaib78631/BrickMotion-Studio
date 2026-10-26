// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, test } from 'vitest';
import type { Plan } from '../../src/plan/types';
import { useAppSettings } from '../../src/state/appSettings';
import { useStudio } from '../../src/state/store';
import type { ModelState } from '../../src/state/useModel';
import { ViewportChrome } from '../../src/ui/ViewportChrome';

const plan: Plan = {
  format: 'brickmotion-plan',
  version: 1,
  name: 't',
  steps: [{ pieces: [{ id: 'a', part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }],
};
const model = () => ({
  plan,
  assembly: { nodes: [], instances: [], bounds: null, problems: [] },
  view: { nodes: [], instances: [], bounds: null, problems: [] },
  viewPlan: plan,
  warnings: [],
  ready: true,
}) as unknown as ModelState;

beforeAll(() => {
  useStudio.getState().setPlan(plan, { resetHistory: true });
  useStudio.getState().setMode('edit');
});
afterEach(cleanup);

test('the viewport tool group switches between Select and Move', () => {
  render(<ViewportChrome model={model()} onMakeSubmodel={() => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move parts' }));
  expect(useStudio.getState().tool).toBe('move');
  fireEvent.click(screen.getByRole('button', { name: 'Select parts' }));
  expect(useStudio.getState().tool).toBe('select');
});

test('nothing is drawn outside edit mode', () => {
  useStudio.getState().setMode('preview');
  const { container } = render(<ViewportChrome model={model()} onMakeSubmodel={() => undefined} />);
  expect(container.querySelector('.bm-viewport-chrome')).toBeNull();
  useStudio.getState().setMode('edit');
});

test('the floating selection toolbar can be hidden by the setting', () => {
  useStudio.getState().select(['a']);
  useAppSettings.getState().set({ showSelectionBar: true });
  const shown = render(<ViewportChrome model={model()} onMakeSubmodel={() => undefined} />);
  expect(shown.container.querySelector('.bm-selection-float')).not.toBeNull();
  shown.unmount();

  useAppSettings.getState().set({ showSelectionBar: false });
  const hidden = render(<ViewportChrome model={model()} onMakeSubmodel={() => undefined} />);
  expect(hidden.container.querySelector('.bm-selection-float')).toBeNull();
  useAppSettings.getState().set({ showSelectionBar: true });
  useStudio.getState().select([]);
});

test('Split lays every part out and shares the store flag', () => {
  useStudio.getState().setLaidOut(false);
  render(<ViewportChrome model={model()} onMakeSubmodel={() => undefined} />);
  const split = screen.getByRole('button', { name: 'Split' });
  fireEvent.click(split);
  expect(useStudio.getState().laidOut).toBe(true);
  expect(split.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(split);
  expect(useStudio.getState().laidOut).toBe(false);
  expect(split.getAttribute('aria-pressed')).toBe('false');
});
