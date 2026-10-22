import { beforeEach, expect, test } from 'vitest';
import { useStudio } from '../../src/state/store';
import { emptyPlan, type Plan } from '../../src/plan/types';

const named = (n: string): Plan => ({ ...emptyPlan(n) });
beforeEach(() => useStudio.getState().setPlan(named('start'), { resetHistory: true }));

test('apply, undo, redo', () => {
  const s = useStudio.getState;
  const p0 = s().plan;
  s().apply((p) => ({ ...p, name: 'one' }));
  const p1 = s().plan;
  s().undo();
  expect(s().plan).toBe(p0);
  s().redo();
  expect(s().plan).toBe(p1);
});

test('a new edit after undo clears redo', () => {
  const s = useStudio.getState;
  s().apply((p) => ({ ...p, name: 'one' }));
  s().undo();
  s().apply((p) => ({ ...p, name: 'two' }));
  expect(s().future).toHaveLength(0);
});

test('history is capped at 200', () => {
  const s = useStudio.getState;
  for (let i = 0; i < 250; i++) s().apply((p) => ({ ...p, name: String(i) }));
  expect(s().past).toHaveLength(200);
});

test('selection', () => {
  const s = useStudio.getState;
  s().select(['a']);
  s().select(['b'], true);
  expect(s().selection.ids).toEqual(['a', 'b']);
  s().select(['a'], true);
  expect(s().selection.ids).toEqual(['b']);
  s().select([]);
  expect(s().selection.ids).toEqual([]);
});

test('a drag gesture is one undo step', () => {
  const s = useStudio.getState;
  const p0 = s().plan;
  s().beginGesture();
  s().apply((p) => ({ ...p, name: 'a' }));
  s().apply((p) => ({ ...p, name: 'ab' }));
  s().endGesture();
  expect(s().plan.name).toBe('ab');
  expect(s().past).toHaveLength(1);
  s().undo();
  expect(s().plan).toBe(p0);
});

test('a gesture that changes nothing adds no undo step', () => {
  const s = useStudio.getState;
  s().beginGesture();
  s().endGesture();
  expect(s().past).toHaveLength(0);
});

test('the tool can be switched', () => {
  useStudio.getState().setTool('move');
  expect(useStudio.getState().tool).toBe('move');
  useStudio.getState().setTool('select');
});
