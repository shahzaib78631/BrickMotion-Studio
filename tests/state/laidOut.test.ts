import { beforeEach, expect, test } from 'vitest';
import { useStudio } from '../../src/state/store';

beforeEach(() => useStudio.setState({ laidOut: false, currentStep: null, editingModel: '' }));

test('laying out all parts clears the step; picking a step or another model puts them back', () => {
  useStudio.setState({ currentStep: 2 });
  useStudio.getState().setLaidOut(true);
  expect(useStudio.getState()).toMatchObject({ laidOut: true, currentStep: null });
  useStudio.getState().setCurrentStep(0);
  expect(useStudio.getState().laidOut).toBe(false);
  useStudio.getState().setLaidOut(true);
  useStudio.getState().setEditingModel('engine');
  expect(useStudio.getState().laidOut).toBe(false);
});
