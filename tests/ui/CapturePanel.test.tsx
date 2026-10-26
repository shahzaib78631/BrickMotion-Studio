// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as THREE from 'three';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Plan } from '../../src/plan/types';
import { useStudio } from '../../src/state/store';
import type { ModelState } from '../../src/state/useModel';
import { CapturePanel } from '../../src/ui/CapturePanel';
import { viewportApi } from '../../src/ui/viewportApi';

const mocks = vi.hoisted(() => ({
  mp4: true,
  recordable: true,
  still: vi.fn(),
  transparent: vi.fn(),
  turntable: vi.fn(),
  save: vi.fn(),
}));

vi.mock('../../src/export/capture', () => ({
  canRecordViewport: () => mocks.recordable,
  captureFileName: (name: string, model: string, suffix: string, ext: string) =>
    `${[name, model, suffix].filter(Boolean).join(' - ')}.${ext}`,
  captureViewportStill: (...args: unknown[]) => {
    mocks.still(...args);
    return Promise.resolve({ blob: new Blob(['x'], { type: 'image/png' }), width: 1600, height: 1200 });
  },
  captureTransparentStill: (...args: unknown[]) => {
    mocks.transparent(...args);
    return Promise.resolve(new Blob(['x'], { type: 'image/png' }));
  },
  exportTurntable: () => {
    mocks.turntable();
    return Promise.resolve(new Blob(['x'], { type: 'video/mp4' }));
  },
  startViewportRecording: () => ({ mime: 'video/webm', stop: () => Promise.resolve(new Blob(['x'], { type: 'video/webm' })) }),
}));

vi.mock('../../src/export/exportVideo', () => ({
  canExportMp4: () => Promise.resolve(mocks.mp4),
  encodeMp4: vi.fn(),
}));

vi.mock('../../src/ui/download', () => ({ saveBlob: (...args: unknown[]) => mocks.save(...args) }));

const plan: Plan = {
  format: 'brickmotion-plan',
  version: 1,
  name: 'Set',
  steps: [{ pieces: [{ id: 'a', part: '3001', color: 4, x: 0, y: 0, z: 0, rot: 0 }] }],
};
const bounds = { min: [-20, -24, -20], max: [20, 0, 20] };
const model = () => ({
  plan,
  assembly: { nodes: [], instances: [], bounds, problems: [] },
  view: { nodes: [], instances: [], bounds, problems: [] },
  viewPlan: plan,
  warnings: [],
  ready: true,
}) as unknown as ModelState;

const liveCanvas = { width: 800, height: 600, toBlob: () => undefined };
const liveCamera = {
  position: new THREE.Vector3(10, 20, 30), quaternion: new THREE.Quaternion(),
  fov: 40, near: 0.1, far: 500, isPerspectiveCamera: true,
};

beforeEach(() => {
  mocks.mp4 = true;
  mocks.recordable = true;
  mocks.still.mockClear();
  mocks.transparent.mockClear();
  mocks.save.mockClear();
  useStudio.getState().setPlan(plan, { resetHistory: true });
  useStudio.getState().setEditingModel('');
  viewportApi.studio = { renderer: { domElement: liveCanvas }, camera: liveCamera, bricks: { readMatrices: () => new Map() } } as never;
});
afterEach(() => {
  cleanup();
  viewportApi.studio = null;
});

test('shows the exact output size for the chosen scale', async () => {
  render(<CapturePanel model={model()} />);
  expect(screen.getByText('800 × 600 px')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '2×' }));
  expect(screen.getByText('1600 × 1200 px')).toBeTruthy();
});

test('saving a still uses the chosen scale and file type', async () => {
  render(<CapturePanel model={model()} />);
  const save = screen.getByRole('button', { name: 'Save image' });
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(save);
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.still).toHaveBeenCalledWith(expect.objectContaining({ renderer: expect.anything() }), 1, 'image/png');
  expect((mocks.save.mock.calls[0][0] as string)).toMatch(/\.png$/);

  fireEvent.click(screen.getByRole('button', { name: '3×' }));
  fireEvent.change(screen.getByLabelText('Still image file type'), { target: { value: 'image/jpeg' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save image' }));
  await waitFor(() => expect(mocks.still).toHaveBeenCalledWith(expect.anything(), 3, 'image/jpeg'));
  expect((mocks.save.mock.calls.at(-1)![0] as string)).toMatch(/\.jpg$/);
});

test('the transparent toggle renders offscreen at the selected size', async () => {
  render(<CapturePanel model={model()} />);
  fireEvent.click(screen.getByLabelText('Transparent background'));
  fireEvent.click(screen.getByRole('button', { name: 'Save transparent PNG' }));
  await waitFor(() => expect(mocks.transparent).toHaveBeenCalled());
  const options = mocks.transparent.mock.calls[0][0] as { width: number; height: number; pose: unknown };
  expect([options.width, options.height]).toEqual([1080, 1920]);
  expect((mocks.save.mock.calls.at(-1)![0] as string)).toMatch(/capture-transparent\.png$/);
});

test('turntable rendering is disabled when the browser cannot encode MP4', async () => {
  mocks.mp4 = false;
  render(<CapturePanel model={model()} />);
  await waitFor(() => expect(screen.getByText(/cannot encode MP4/)).toBeTruthy());
  expect((screen.getByRole('button', { name: 'Render turntable' }) as HTMLButtonElement).disabled).toBe(true);
});

test('recording is disabled when the canvas cannot be captured', () => {
  mocks.recordable = false;
  render(<CapturePanel model={model()} />);
  expect((screen.getByRole('button', { name: 'Start recording' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/cannot record the canvas/)).toBeTruthy();
});
