// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Plan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';
import { EditPad } from '../../src/ui/EditPad';

const plan: Plan = { format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [{ id: 'a', part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }] };
const a = () => useStudio.getState().plan.steps[0].pieces.find((i) => i.id === 'a') as { x: number; y: number; z: number };

beforeEach(() => {
  useStudio.getState().setPlan(plan, { resetHistory: true });
  useStudio.getState().select(['a']);
});
afterEach(cleanup);

test('raise and lower move the selection by a plate', () => {
  render(<EditPad azimuth={() => 0} />);
  fireEvent.click(screen.getByRole('button', { name: 'Raise one plate' }));
  fireEvent.click(screen.getByRole('button', { name: 'Raise one plate' }));
  fireEvent.click(screen.getByRole('button', { name: 'Lower one plate' }));
  expect(a().y).toBe(1);
});

test('arrow buttons move relative to the camera', () => {
  render(<EditPad azimuth={() => 0} />);
  fireEvent.click(screen.getByRole('button', { name: 'Move away' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move right' }));
  expect(a()).toMatchObject({ x: 1, z: 1 });
});

test('duplicate selects the copy, delete removes the selection', () => {
  render(<EditPad azimuth={() => 0} />);
  fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
  const ids = useStudio.getState().plan.steps[0].pieces.map((i) => i.id);
  expect(ids).toHaveLength(2);
  expect(useStudio.getState().selection.ids).toEqual([ids[1]]);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(useStudio.getState().plan.steps[0].pieces.map((i) => i.id)).toEqual(['a']);
});

test('rotate turns the piece', () => {
  render(<EditPad azimuth={() => 0} />);
  fireEvent.click(screen.getByRole('button', { name: 'Rotate 90°' }));
  expect(useStudio.getState().plan.steps[0].pieces[0]).toMatchObject({ rot: 90 });
});
