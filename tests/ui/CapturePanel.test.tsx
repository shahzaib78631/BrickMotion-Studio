// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as THREE from 'three';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Plan } from '../../src/plan/types';
import { useAppSettings } from '../../src/state/appSettings';
import { useStudio } from '../../src/state/store';
import type { ModelState } from '../../src/state/useModel';
import { CapturePanel } from '../../src/ui/CapturePanel';
import { viewportApi } from '../../src/ui/viewportApi';

const mocks = vi.hoisted(() => ({
  mp4: true,
  recordable: true,
  still: vi.fn(),
  transparent: vi.fn(),
  offscreen: vi.fn(),
  finish: vi.fn(async (blob: Blob) => blob),
  turntable: vi.fn(),
  save: vi.fn(),
}));

vi.mock('../../src/export/collada', () => ({ buildCollada: () => '<COLLADA/>' }));

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
  captureOffscreenStill: (...args: unknown[]) => {
    mocks.offscreen(...args);
    return Promise.resolve(new Blob(['x'], { type: 'image/png' }));
  },
  exportTurntable: () => {
    mocks.turntable();
    return Promise.resolve(new Blob(['x'], { type: 'video/mp4' }));
  },
  startViewportRecording: () => ({ mime: 'video/webm', stop: () => Promise.resolve(new Blob(['x'], { type: 'video/webm' })) }),
}));

vi.mock('../../src/export/capturePostProcessing', () => ({ finishCapture: (...args: unknown[]) => (mocks.finish as Function)(...args) }));

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
  useAppSettings.getState().set({ logoBitmap: null });
  mocks.mp4 = true;
  mocks.recordable = true;
  mocks.still.mockClear();
  mocks.transparent.mockClear();
  mocks.offscreen.mockClear();
  mocks.finish.mockClear();
  mocks.save.mockClear();
  useStudio.getState().setPlan(plan, { resetHistory: true });
  useStudio.getState().setEditingModel('');
  viewportApi.studio = { renderer: { domElement: liveCanvas }, camera: liveCamera, bricks: { readMatrices: () => new Map() } } as never;
});
afterEach(() => {
  vi.unstubAllGlobals();
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

test('Instagram covers render the current pose at portrait or square size', async () => {
  render(<CapturePanel model={model()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save Instagram cover' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.offscreen).toHaveBeenLastCalledWith(expect.objectContaining({
    width: 1080, height: 1920, type: 'image/png', pose: expect.any(Map),
  }), expect.anything());
  expect(mocks.save.mock.calls.at(-1)![0]).toMatch(/instagram-cover-portrait\.png$/);
  fireEvent.change(screen.getByLabelText('Instagram cover size'), { target: { value: 'square' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Instagram cover' }));
  await waitFor(() => expect(mocks.offscreen).toHaveBeenCalledTimes(2));
  expect(mocks.offscreen).toHaveBeenLastCalledWith(expect.objectContaining({ width: 1080, height: 1080 }), expect.anything());
  expect(mocks.save.mock.calls.at(-1)![0]).toMatch(/instagram-cover-square\.png$/);
});

test('Instagram cover logo is optional and uses the configured image and corner', async () => {
  const image = { width: 200, height: 100 } as ImageBitmap;
  useAppSettings.getState().set({ logoBitmap: image, logoCorner: 'br' });
  render(<CapturePanel model={model()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save Instagram cover' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  expect(mocks.finish).toHaveBeenLastCalledWith(expect.any(Blob), true, null);
  fireEvent.click(screen.getByLabelText('Include logo'));
  fireEvent.click(screen.getByRole('button', { name: 'Save Instagram cover' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
  expect(mocks.finish).toHaveBeenLastCalledWith(expect.any(Blob), true, { image, corner: 'br' });
});

test('including a cover logo requires an uploaded logo', () => {
  render(<CapturePanel model={model()} />);
  expect((screen.getByLabelText('Include logo') as HTMLInputElement).disabled).toBe(true);
});

test('film smoothing is applied to covers when enabled', async () => {
  render(<CapturePanel model={model()} />);
  expect((screen.getByLabelText('Blackman–Harris edge smoothing (subtle)') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save Instagram cover' }));
  await waitFor(() => expect(mocks.finish).toHaveBeenCalledWith(expect.any(Blob), true, null));
});

test('native EyeSight sends the current scene to the local renderer and saves its PNG', async () => {
  const fetchNative = vi.fn(async () => new Response(new Blob(['native'], { type: 'image/png' }), {
    headers: { 'Content-Type': 'image/png' },
  }));
  vi.stubGlobal('fetch', fetchNative);
  const current = model();
  current.view.instances = [{ key: 'a', part: '3001', color: 4, world: new THREE.Matrix4() }] as never;
  viewportApi.studio!.bricks.readMatrices = () => new Map([['a', new THREE.Matrix4()]]);
  render(<CapturePanel model={current} />);
  fireEvent.click(screen.getByRole('button', { name: 'Render native EyeSight cover' }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(fetchNative).toHaveBeenCalledWith('/__eyesight/capture?width=1080&height=1920&samples=256',
    expect.objectContaining({ method: 'POST', body: '<COLLADA/>', signal: expect.any(AbortSignal) }));
  expect(mocks.finish).toHaveBeenCalledWith(expect.any(Blob), false, null);
  expect(mocks.save.mock.calls.at(-1)![0]).toMatch(/eyesight-cover-portrait\.png$/);
});

test('viewport capture keeps its camera and processes the resulting image', async () => {
  render(<CapturePanel model={model()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save image' }));
  await waitFor(() => expect(mocks.finish).toHaveBeenCalledWith(expect.any(Blob), true, null));
  expect(mocks.still).toHaveBeenCalledWith(viewportApi.studio, 1, 'image/png');
  expect(mocks.offscreen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('Blackman–Harris edge smoothing (subtle)'));
  fireEvent.click(screen.getByRole('button', { name: 'Save image' }));
  await waitFor(() => expect(mocks.finish).toHaveBeenLastCalledWith(expect.any(Blob), false, null));
});
