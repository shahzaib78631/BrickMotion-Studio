// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { initPartService } from '../../src/state/partService';
import { useStudio } from '../../src/state/store';
import { paletteDrag } from '../../src/state/placing';
import { PartsPanel } from '../../src/ui/PartsPanel';
import { emptyPlan } from '../../src/plan/types';

beforeAll(async () => {
  // a one-part catalog, served the way the browser fetches it
  vi.stubGlobal('fetch', async (url: string) => ({ ok: url.endsWith('catalog.json'), json: async () => [{ id: '3001', name: 'Brick 2 x 4', category: 'Brick' }] }));
  await initPartService(async () => '0 LDConfig');
  vi.unstubAllGlobals();
});
beforeEach(() => useStudio.getState().setPlan(emptyPlan('t'), { resetHistory: true }));
afterEach(cleanup);

const firstTile = () => screen.getAllByRole('button').find((b) => b.classList.contains('part-tile'))!;

test('dragging a tile registers the part for placing in the view', () => {
  render(<PartsPanel />);
  const tile = firstTile();
  const data = new Map<string, string>();
  fireEvent.dragStart(tile, { dataTransfer: { setData: (k: string, v: string) => data.set(k, v), effectAllowed: '' } });
  expect(paletteDrag()).toBe('3001');
  fireEvent.dragEnd(tile);
  expect(paletteDrag()).toBeNull();
});

test('the help text mentions dragging into the view', () => {
  render(<PartsPanel />);
  const help = screen.getByLabelText('How this panel works');
  if (help.getAttribute('aria-expanded') !== 'true') fireEvent.click(help);
  expect(document.body.innerHTML).toContain('Drag a part into the view');
});
