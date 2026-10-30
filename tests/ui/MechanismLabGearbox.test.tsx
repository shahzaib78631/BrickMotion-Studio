// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GearboxTable } from '../../src/ui/GearboxTable';

afterEach(cleanup);

const rows = [
  { id: 'n', label: 'neutral', state: 'neutral' as const, engagements: { c1: false, c2: false } },
  { id: 'l', label: '1st', state: 'drive' as const, ratio: 3, engagements: { c1: true, c2: false } },
  { id: 'h', label: '2nd', state: 'drive' as const, ratio: 1 / 3, engagements: { c1: false, c2: true } },
  { id: 'x', label: 'both', state: 'locked' as const, engagements: { c1: true, c2: true } },
];

test('lists the ratio table, one row per mode', () => {
  render(<GearboxTable rows={rows} current="l" onShift={() => {}} />);
  expect(screen.getByText('3.00:1')).toBeTruthy();
  expect(screen.getByText('0.33:1')).toBeTruthy();
  expect(screen.getAllByText('neutral').length).toBeGreaterThan(0);
  expect(screen.getByText('locks')).toBeTruthy();
});

test('shifts to a row, but never into a lock-up', () => {
  const onShift = vi.fn();
  render(<GearboxTable rows={rows} current="l" onShift={onShift} />);
  fireEvent.click(screen.getByRole('button', { name: 'Shift to 2nd' }));
  expect(onShift).toHaveBeenCalledWith(rows[2]);
  expect((screen.getByRole('button', { name: 'Shift to both' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Shift to 1st' }) as HTMLButtonElement).disabled).toBe(true);
});
