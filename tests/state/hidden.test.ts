import { beforeEach, describe, expect, it } from 'vitest';
import { emptyPlan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';

describe('hiding pieces in the Build view', () => {
  beforeEach(() => useStudio.getState().setPlan(emptyPlan(), { resetHistory: true }));

  it('hides, isolates and shows pieces per model, without undo steps', () => {
    const st = useStudio.getState;
    st().select(['a', 'b']);
    st().hide(['a']);
    expect(st().hidden['']).toEqual(['a']);
    expect(st().selection.ids).toEqual(['b']);
    expect(st().past).toHaveLength(0);
    st().setEditingModel('wheel');
    st().isolate(['w1'], ['w1', 'w2', 'w3']);
    expect(st().hidden.wheel).toEqual(['w2', 'w3']);
    st().showAll();
    expect(st().hidden.wheel).toBeUndefined();
    expect(st().hidden['']).toEqual(['a']);
  });

  it('forgets hidden pieces when another set is loaded', () => {
    useStudio.getState().hide(['a']);
    useStudio.getState().setPlan(emptyPlan('other'));
    expect(useStudio.getState().hidden).toEqual({});
  });
});
