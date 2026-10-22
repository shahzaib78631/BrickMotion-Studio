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

test('play switches to the preview and starts playback', () => {
  render(<BuildTimeline timeline={tl} />);
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  expect(useStudio.getState().mode).toBe('preview');
  expect(usePlayback.getState().playing).toBe(true);
});

test('next step jumps the playhead to the next step', () => {
  usePlayback.getState().set({ t: 1.5 });
  render(<BuildTimeline timeline={tl} />);
  fireEvent.click(screen.getByRole('button', { name: 'Next step' }));
  expect(usePlayback.getState().t).toBe(4);
});
