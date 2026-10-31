import { expect, test, vi } from 'vitest';
import { disposeOffscreenStudio } from '../../src/render/studio';

test('an export studio frees its resources and releases its WebGL context', () => {
  const order: string[] = [];
  disposeOffscreenStudio({ dispose: () => order.push('dispose'), renderer: { forceContextLoss: () => order.push('release') } });
  expect(order).toEqual(['dispose', 'release']);
});

test('a studio without a real renderer, or one already lost, is still disposed', () => {
  const dispose = vi.fn();
  disposeOffscreenStudio({ dispose });
  disposeOffscreenStudio({ dispose, renderer: { forceContextLoss: () => { throw new Error('lost'); } } });
  expect(dispose).toHaveBeenCalledTimes(2);
});
