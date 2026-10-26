// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { Plan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';
import type { ModelState } from '../../src/state/useModel';
import { Inspector } from '../../src/ui/Inspector';

// Thumbnails are drawn with WebGL and the LDraw library over HTTP, which a DOM-only
// test has neither of. The URL carries the part and colour so the wiring is testable.
vi.mock('../../src/render/thumbnails', () => ({
  getThumbnail: (id: string, color: number) => Promise.resolve(`data:,part=${id}&color=${color}`),
}));

const piece = (id: string, part: string, x: number, color: number | string = 4) => ({ id, part, color, x, y: 0, z: 0, rot: 0 as const });
const plan: Plan = {
  format: 'brickmotion-plan',
  version: 1,
  name: 't',
  steps: [
    { pieces: [piece('a', '3001', 0), piece('b', '3001', 4), piece('c', '3020', 8)] },
    { pieces: [piece('d', '3020', 0)] },
  ],
};
const model = () => ({
  plan,
  assembly: { nodes: [], instances: [], bounds: null, problems: [] },
  view: { nodes: [], instances: [], bounds: null, problems: [] },
  viewPlan: plan,
  warnings: [],
  ready: true,
}) as unknown as ModelState;
const renderInspector = () => render(<Inspector timeline={null} checks={0} model={model()} onMakeSubmodel={() => undefined} />);

beforeAll(() => {
  useStudio.getState().setPlan(plan, { resetHistory: true });
  useStudio.getState().setMode('edit');
});
afterEach(() => {
  cleanup();
  useStudio.getState().select([]);
});

test('Part info shows the thumbnail of the selected part', async () => {
  useStudio.getState().select(['a']);
  const { container } = renderInspector();
  fireEvent.click(screen.getByRole('button', { name: /Part info/ }));
  await waitFor(() => expect(container.querySelector('.bm-part-heading img')).not.toBeNull());
  const thumb = container.querySelector<HTMLImageElement>('.bm-part-heading img')!;
  expect(thumb.getAttribute('src')).toBe('data:,part=3001&color=71');
  expect(thumb.getAttribute('width')).toBe('56');
  expect(screen.getByText('Part ID: 3001')).toBeDefined();
  expect(screen.getByText('Selected model: Main model')).toBeDefined();
});

test('a multi-part selection lists every selected part, with counts', async () => {
  useStudio.getState().select(['a', 'b', 'c']);
  const { container } = renderInspector();
  fireEvent.click(screen.getByRole('button', { name: /Part info/ }));
  await waitFor(() => expect(container.querySelectorAll('.bm-part-thumb img')).toHaveLength(2));
  const srcs = [...container.querySelectorAll('.bm-part-thumb img')].map((img) => img.getAttribute('src'));
  expect(srcs).toEqual(['data:,part=3001&color=71', 'data:,part=3020&color=71']);
  expect(screen.getByText('×2')).toBeDefined();
  expect(screen.getByText('2 distinct parts · 3 pieces selected')).toBeDefined();
});

test('the Part tab shows the strip for a multi selection and the bare thumbnail for one part', async () => {
  useStudio.getState().select(['a', 'c']);
  const { container } = renderInspector();
  fireEvent.click(screen.getByRole('tab', { name: 'Part' }));
  await waitFor(() => expect(container.querySelectorAll('.bm-part-thumb img')).toHaveLength(2));
  expect(screen.getByText('Multiple parts')).toBeDefined();
  expect(screen.getByText('2 pieces · 2 types')).toBeDefined();

  useStudio.getState().select(['a']);
  await waitFor(() => expect(container.querySelectorAll('.bm-part-thumb')).toHaveLength(0));
  await waitFor(() => expect(container.querySelector('.bm-part-heading img')).not.toBeNull());
  const thumb = container.querySelector<HTMLImageElement>('.bm-part-heading img')!;
  expect(thumb.getAttribute('src')).toBe('data:,part=3001&color=71');
  expect(thumb.getAttribute('width')).toBe('46');
  expect(container.querySelector('.bm-part-heading-icon')).toBeNull();
  // Without the part library loaded, the name falls back to the part id.
  expect(container.querySelector('.bm-part-heading small')?.textContent).toBe('3001');
});
