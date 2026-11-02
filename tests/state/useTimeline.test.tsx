// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Plan } from '../../src/plan/types';
import type { Timeline } from '../../src/anim/timeline';
import { useTimeline } from '../../src/state/useTimeline';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/state/store', () => ({ useStudio: (select: (s: { gesture: null; replans: number }) => unknown) => select({ gesture: null, replans: 0 }) }));
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


test('editing object keyframes preserves the construction timeline and does not replan', async () => {
  mocks.run.mockResolvedValue(timeline);
  const { result, rerender } = renderHook(({ editedPlan }) => useTimeline(true, editedPlan, '', opts),
    { initialProps: { editedPlan: plan } });
  await runDebounce();
  expect(result.current.timeline).toBe(timeline);
  const keyed = { ...plan, animation: { fps: 24, startFrame: 1, endFrame: 250,
    tracks: [{ kind: 'object' as const, model: '', target: 'i0', channels: {
      'location.x': [{ frame: 1, value: 0, interpolation: 'bezier' as const }],
    } }],
  } };
  rerender({ editedPlan: keyed });
  expect(result.current.timeline).toBe(timeline);
  await runDebounce();
  expect(mocks.run).toHaveBeenCalledTimes(1);
});

test('editing the camera track preserves the construction timeline and does not replan', async () => {
  mocks.run.mockResolvedValue(timeline);
  const { result, rerender } = renderHook(({ editedPlan }) => useTimeline(true, editedPlan, '', opts),
    { initialProps: { editedPlan: plan } });
  await runDebounce();
  const withCamera = { ...plan, cameraTracks: { '': { build: { keys: [], transitions: [], shutter: 0.5 } } } };
  rerender({ editedPlan: withCamera });
  expect(result.current.timeline).toBe(timeline);
  await runDebounce();
  expect(mocks.run).toHaveBeenCalledTimes(1);
});

test('auto-planning on: a part edit plans the build again', async () => {
  mocks.run.mockResolvedValue(timeline);
  const { rerender } = renderHook(({ editedPlan }) => useTimeline(true, editedPlan, '', opts),
    { initialProps: { editedPlan: plan } });
  await runDebounce();
  rerender({ editedPlan: { ...plan, name: 'edited' } });
  await runDebounce();
  expect(mocks.run).toHaveBeenCalledTimes(2);
});

test('auto-planning off: a part edit keeps the last plan and only marks it out of date', async () => {
  mocks.run.mockResolvedValue(timeline);
  const { result, rerender } = renderHook(({ editedPlan }) => useTimeline(true, editedPlan, '', opts, false),
    { initialProps: { editedPlan: plan } });
  await runDebounce(); // the first plan is made either way
  expect(result.current.timeline).toBe(timeline);
  rerender({ editedPlan: { ...plan, name: 'edited' } });
  await runDebounce();
  expect(mocks.run).toHaveBeenCalledTimes(1); // no route search for a part edit
  expect(result.current.timeline).toBe(timeline); // the preview stays where it was
  expect(result.current.planning).toBe(false);
  expect(result.current.stale).toBe(true);
  act(() => result.current.retry()); // Plan asks for a new one
  expect(result.current.planning).toBe(true);
  await runDebounce();
  expect(mocks.run).toHaveBeenCalledTimes(2);
  expect(result.current.stale).toBe(false);
});

test('auto-planning off: options, model and turning it back on still plan', async () => {
  mocks.run.mockResolvedValue(timeline);
  const { rerender } = renderHook(({ model, auto, seconds }) => useTimeline(true, plan, model, { ...opts, targetSeconds: seconds }, auto),
    { initialProps: { model: '', auto: false, seconds: 15 } });
  await runDebounce();
  rerender({ model: '', auto: false, seconds: 30 }); // an animation option changed: plan it
  await runDebounce();
  expect(mocks.run).toHaveBeenCalledTimes(2);
  rerender({ model: 'engine', auto: false, seconds: 30 }); // another model: it needs its own plan
  await runDebounce();
  expect(mocks.run).toHaveBeenCalledTimes(3);
  rerender({ model: 'engine', auto: true, seconds: 30 }); // back on: nothing is pending here
  await runDebounce();
  expect(mocks.run).toHaveBeenCalledTimes(4);
});

test('auto-planning off: switching it off while planning finishes instead of spinning', async () => {
  mocks.run.mockResolvedValue(timeline);
  const { result, rerender } = renderHook(({ auto }) => useTimeline(true, plan, '', opts, auto), { initialProps: { auto: true } });
  rerender({ auto: false }); // before the debounce fires, so the request is replaced, not kept
  await runDebounce();
  expect(result.current.planning).toBe(false);
  expect(result.current.timeline).toBe(timeline);
  expect(result.current.stale).toBe(false);
});

test('auto-planning off: a failed plan keeps its error until asked again', async () => {
  mocks.run.mockRejectedValue(new Error('blocked-route: wrist'));
  const { result, rerender } = renderHook(({ editedPlan }) => useTimeline(true, editedPlan, '', opts, false),
    { initialProps: { editedPlan: plan } });
  await runDebounce();
  expect(result.current.error).toContain('wrist');
  rerender({ editedPlan: { ...plan, name: 'edited' } });
  await runDebounce();
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(result.current.error).toContain('wrist');
  expect(result.current.stale).toBe(true);
});
