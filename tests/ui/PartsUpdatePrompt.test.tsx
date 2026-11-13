// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { PartsUpdatePrompt } from '../../src/ui/PartsUpdatePrompt';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });

test('prompts for an available release and installs only after confirmation', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(reply({ available: true })).mockResolvedValueOnce(reply({ updated: true }));
  vi.stubGlobal('fetch', fetch);
  render(<PartsUpdatePrompt />);
  await screen.findByRole('dialog');
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Update parts'));
  await screen.findByText('Parts library updated');
  expect(fetch).toHaveBeenLastCalledWith('/api/parts-update', { method: 'POST' });
});

test('shows update failures and allows retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ available: true })).mockResolvedValueOnce(reply({ error: 'Network unavailable' }, false)));
  render(<PartsUpdatePrompt />);
  fireEvent.click(await screen.findByText('Update parts'));
  expect((await screen.findByRole('alert')).textContent).toBe('Network unavailable');
  await waitFor(() => expect((screen.getByText('Update parts') as HTMLButtonElement).disabled).toBe(false));
});

test('does not prompt when up to date or when update service is unavailable', async () => {
  const fetch = vi.fn().mockResolvedValue(reply({ available: false }));
  vi.stubGlobal('fetch', fetch);
  render(<PartsUpdatePrompt />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('dialog')).toBeNull();
});
