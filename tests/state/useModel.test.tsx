// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { Plan, PlanItem } from '../../src/plan/types';
import type { PartMetrics } from '../../src/ldraw/metrics';
import { fixtureColors, fixtureMetrics } from '../helpers/fixtureMetrics';

const parts = vi.hoisted(() => ({
  loaded: new Set<string>(),
  metrics: null as ((p: string) => PartMetrics) | null,
  release: null as (() => void) | null,
}));
const store = vi.hoisted(() => ({ s: null as unknown as { setState(p: object): void } }));

vi.mock('../../src/state/store', async () => {
  const { create: make } = await import('zustand');
  const useStudio = make(() => ({ plan: null as unknown as Plan, editingModel: '' }));
  store.s = useStudio;
  return { useStudio };
});
vi.mock('../../src/state/partService', () => ({
  isLoaded: (id: string) => parts.loaded.has(id),
  metricsOf: (id: string) => parts.metrics!(id),
  getColors: () => fixtureColors,
  partName: (id: string) => id,
  registerInlineParts: () => {},
  ensureParts: (ids: string[]) => ids.every((id) => parts.loaded.has(id))
    ? Promise.resolve()
    : new Promise<void>((resolve) => { parts.release = () => { ids.forEach((id) => parts.loaded.add(id)); resolve(); }; }),
}));

const { useModel } = await import('../../src/state/useModel');

const brick = (id: string, part: string, x: number): PlanItem => ({ id, part, color: 4, x, y: 0, z: 0, rot: 0 });
const planOf = (...pieces: PlanItem[]): Plan => ({ format: 'brickmotion-plan', version: 1, name: 't', steps: [{ pieces }] });

beforeAll(async () => { parts.metrics = await fixtureMetrics(['3001', '3020']); });
afterEach(() => { cleanup(); parts.loaded.clear(); parts.release = null; });

test('with every part loaded, a plan change is assembled in the same render (no "Loading parts")', () => {
  parts.loaded.add('3001');
  store.s.setState({ plan: planOf(brick('a', '3001', 0)), editingModel: '' });
  const { result } = renderHook(() => useModel());
  expect(result.current.ready).toBe(true);
  // a drag moves the piece: every move is a new plan
  for (let x = 20; x <= 100; x += 20) {
    act(() => store.s.setState({ plan: planOf(brick('a', '3001', x)) }));
    expect(result.current.ready).toBe(true);
    expect(result.current.assembly.instances).toHaveLength(1);
  }
});

test('a part that is not loaded yet still waits for it', async () => {
  store.s.setState({ plan: planOf(brick('a', '3020', 0)), editingModel: '' });
  const { result } = renderHook(() => useModel());
  expect(result.current.ready).toBe(false);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(result.current.ready).toBe(false);
  await act(async () => { parts.release!(); await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(result.current.ready).toBe(true);
  expect(result.current.assembly.instances).toHaveLength(1);
});
