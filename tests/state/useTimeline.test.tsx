// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Plan } from '../../src/plan/types';
import type { Timeline } from '../../src/anim/timeline';
import { useTimeline } from '../../src/state/useTimeline';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/state/store', () => ({ useStudio: (select: (s: { gesture: null }) => unknown) => select({ gesture: null }) }));
vi.mock('../../src/state/timelineService', () => ({
  planTimeline: mocks.run,
  isAbandoned: (e: Error) => e.name === 'AbortError',
}));
const plan: Plan = { format: 'brickmotion-plan', version: 1, name: 'test', steps: [{ pieces: [] }] };
const opts = { targetSeconds: 15, heroOrbit: true };
const timeline = { duration: 15 } as Timeline;
beforeEach(() => { vi.useFakeTimers(); mocks.run.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const runDebounce = () => act(async () => { await vi.advanceTimersByTimeAsync(121); });

test('a failed request stops planning and exposes its error', async () => {
  mocks.run.mockRejectedValue(new Error('blocked-route: wrist'));
  const { result } = renderHook(() => useTimeline(true, plan, '', opts));
  await runDebounce();
  expect(result.current.planning).toBe(false);
  expect(result.current.error).toContain('wrist');
  expect(result.current.timeline).toBeNull();
});

test('retry clears a previous error and can finish successfully', async () => {
  mocks.run.mockRejectedValueOnce(new Error('worker failed')).mockResolvedValueOnce(timeline);
  const { result } = renderHook(() => useTimeline(true, plan, '', opts));
  await runDebounce();
  act(() => result.current.retry());
  expect(result.current.error).toBe('');
  expect(result.current.planning).toBe(true);
  await runDebounce();
  expect(result.current.timeline).toBe(timeline);
  expect(result.current.planning).toBe(false);
});

test('option changes invalidate the old successful timeline', async () => {
  mocks.run.mockResolvedValue(timeline);
  const { result, rerender } = renderHook(({ seconds }) => useTimeline(true, plan, '', { ...opts, targetSeconds: seconds }), { initialProps: { seconds: 15 } });
  await runDebounce();
  rerender({ seconds: 30 });
  expect(result.current.planning).toBe(true);
  expect(result.current.timeline).toBeNull();
  await runDebounce();
  expect(mocks.run).toHaveBeenCalledTimes(2);
});

test('an obsolete request cannot overwrite a newer model', async () => {
  let completeOld!: (t: Timeline) => void;
  mocks.run.mockImplementationOnce(() => new Promise<Timeline>((resolve) => { completeOld = resolve; })).mockResolvedValueOnce(timeline);
  const { result, rerender } = renderHook(({ model }) => useTimeline(true, plan, model, opts), { initialProps: { model: 'old' } });
  await runDebounce();
  rerender({ model: 'new' });
  await runDebounce();
  await act(async () => { completeOld({ duration: 999 } as Timeline); });
  expect(result.current.timeline).toBe(timeline);
});

test('synchronous request errors become visible instead of escaping the effect', async () => {
  mocks.run.mockImplementation(() => { throw new Error('metrics unavailable'); });
  const { result } = renderHook(() => useTimeline(true, plan, '', opts));
  await runDebounce();
  expect(result.current.error).toBe('metrics unavailable');
  expect(result.current.planning).toBe(false);
});
