// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Timeline } from '../../src/anim/timeline';
import type { Plan } from '../../src/plan/types';
import { usePlayback } from '../../src/state/playback';
import { useStudio } from '../../src/state/store';
import { BuildTimeline } from '../../src/ui/BuildTimeline';

const piece = (id: string) => ({ id, part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 as const });
const plan: Plan = {
  format: 'brickmotion-plan',
  version: 1,
  name: 't',
  submodels: { engine: { steps: [{ pieces: [piece('e1')] }] } },
  steps: [{ pieces: [piece('a')] }, { pieces: [piece('b'), { id: 's', submodel: 'engine', x: 0, y: 0, z: 0, rot: 0 }] }],
};
const tl = {
  duration: 10,
  intro: 1,
  buildEnd: 7,
  heroOrbit: true,
  steps: [
    { model: '', index: 0, start: 1, end: 3 },
    { model: 'engine', index: 0, start: 3, end: 4 },
    { model: '', index: 1, start: 4, end: 7 },
  ],
  subBuilds: [{ key: 's', name: 'engine', start: 3, attachStart: 4.5, attachEnd: 5 }],
  units: [
    { kind: 'piece', keys: ['a'], start: 1.5, dur: 0.6, step: 0 },
    { kind: 'piece', keys: ['s/e1'], start: 3.2, dur: 0.6, step: 0 }, // inside the engine's own build
    { kind: 'piece', keys: ['b'], start: 4.1, dur: 0.6, step: 1 },
    { kind: 'attach', keys: ['s/e1'], start: 4.5, dur: 0.5, step: 1 },
  ],
} as unknown as Timeline;

beforeEach(() => {
  useStudio.getState().setPlan(plan, { resetHistory: true });
  useStudio.getState().setMode('edit');
  usePlayback.getState().set({ t: 0, playing: false });
});
afterEach(cleanup);

test('shows one block per main step, one per submodel build, and the camera parts', () => {
  render(<BuildTimeline timeline={tl} />);
  expect(screen.getAllByRole('button', { name: /^Step \d+ ·/ })).toHaveLength(2);
  expect(screen.getByRole('button', { name: /^Build engine/ })).toBeTruthy();
  expect(screen.getByText('Hero orbit')).toBeTruthy();
});

test('clicking a step block edits that step and moves the playhead to it', () => {
  render(<BuildTimeline timeline={tl} />);
  fireEvent.click(screen.getByRole('button', { name: /^Step 2 ·/ }));
  expect(useStudio.getState().currentStep).toBe(1);
  expect(useStudio.getState().editingModel).toBe('');
  expect(usePlayback.getState().t).toBe(4);
});

test('clicking a submodel block opens that submodel', () => {
  render(<BuildTimeline timeline={tl} />);
  fireEvent.click(screen.getByRole('button', { name: /^Build engine/ }));
  expect(useStudio.getState().editingModel).toBe('engine');
});

test('play in the Build view plays there (following the playhead)', () => {
  useStudio.setState({ mode: 'edit' });
  render(<BuildTimeline timeline={tl} />);
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  expect(useStudio.getState().mode).toBe('edit');
  expect(usePlayback.getState().playing).toBe(true);
  expect(usePlayback.getState().follow).toBe(true);
});

test('next step jumps the playhead to the next step', () => {
  usePlayback.getState().set({ t: 1.5 });
  render(<BuildTimeline timeline={tl} />);
  fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
  expect(usePlayback.getState().t).toBe(4);
});

test('the Parts lane shows each piece of the open model and clicking one selects it', () => {
  render(<BuildTimeline timeline={tl} />);
  const lane = screen.getByLabelText('Parts: when each piece arrives');
  const clips = lane.querySelectorAll('.bm-part-clip');
  // a, b and the attached engine; the engine's own pieces stay in its own timeline
  expect(clips).toHaveLength(3);
  const engine = screen.getByRole('button', { name: /^engine, step 2, piece 2/ });
  fireEvent.pointerDown(engine, { button: 0, clientX: 10 });
  fireEvent.pointerUp(window, { clientX: 10 });
  expect(useStudio.getState().selection.ids).toEqual(['s']);
  expect(useStudio.getState().currentStep).toBe(1);
  expect(usePlayback.getState().t).toBe(4.5);
  expect(engine.getAttribute('aria-pressed')).toBe('true');
});
