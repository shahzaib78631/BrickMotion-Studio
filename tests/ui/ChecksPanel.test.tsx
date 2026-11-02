// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Warning } from '../../src/model/validate';
import type { Plan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';
import { ChecksPanel } from '../../src/ui/ChecksPanel';

const piece = (id: string) => ({ id, part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 as const });
const plan: Plan = { format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces: [piece('a'), piece('b')] }] };
const overlap: Warning = {
  kind: 'overlap', itemIds: ['a', 'b'], instanceKeys: ['a', 'b'], model: '',
  message: 'Brick 2 x 4 overlaps Plate 2 x 4', detail: '6 × 20 × 12 LDU inside each other',
};

beforeEach(() => { useStudio.getState().setPlan(plan, { resetHistory: true }); useStudio.getState().clearBlockedNote(); });
afterEach(cleanup);

test('a check says what it means, how deep, and what it is about', () => {
  render(<ChecksPanel warnings={[overlap]} />);
  // the kind group explains itself, and the row carries the measured depth
  expect(screen.getByText(/Two pieces reach into each other/)).toBeTruthy();
  expect(screen.getByText('Brick 2 x 4 overlaps Plate 2 x 4')).toBeTruthy();
  expect(screen.getByText('6 × 20 × 12 LDU inside each other')).toBeTruthy();
  expect(screen.getByText(/outlined red in the viewport/)).toBeTruthy();
});

test('a refused edit is explained in the sidebar and can be dismissed', () => {
  useStudio.getState().flashBlocked(['a'], ['b'], 'it would sit inside another piece');
  render(<ChecksPanel warnings={[]} />);
  expect(screen.getByText('Last refused edit')).toBeTruthy();
  // which piece and why (the text spans elements; the library may render the part id as its name)
  expect(document.body.textContent).toContain('was left where it was: it would sit inside another piece');
  fireEvent.click(screen.getByRole('button', { name: /Select those pieces/ }));
  expect(useStudio.getState().selection.ids).toEqual(['a', 'b']);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('Last refused edit')).toBeNull();
});
