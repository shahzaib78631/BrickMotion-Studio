import * as THREE from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  canRecordViewport, captureFileName, captureTransparentStill, captureViewportStill,
  recorderMime, turntableSampler,
} from '../../src/export/capture';
import { DEFAULT_CAMERA_SETTINGS } from '../../src/anim/camera';
import type { Studio } from '../../src/render/studio';

const blob = (type = 'image/png') => new Blob(['pixels'], { type });

/** The live studio surface a still touches, with its calls recorded. */
function fakeStudio(options: { toBlob?: (cb: (b: Blob | null) => void) => void } = {}) {
  const canvas = {
    width: 800,
    height: 600,
    toBlob: options.toBlob ?? ((cb: (b: Blob | null) => void) => cb(blob())),
  };
  const renderer = {
    domElement: canvas,
    getPixelRatio: () => 1.5,
    setPixelRatio: vi.fn(),
    getSize: (v: THREE.Vector2) => v.set(1600 / 3, 400),
    setSize: vi.fn(),
  };
  const setSize = vi.fn();
  const render = vi.fn();
  const studio = { renderer, setSize, render } as unknown as Studio;
  return { studio, renderer, setSize, render, canvas };
}

describe('captureViewportStill', () => {
  test('renders at the scaled backing size and restores the viewport afterwards', async () => {
    const { studio, renderer, setSize, render } = fakeStudio();
    const result = await captureViewportStill(studio, 2, 'image/png');
    expect(renderer.setPixelRatio).toHaveBeenNthCalledWith(1, 1);
    expect(setSize).toHaveBeenNthCalledWith(1, 1600, 1200);
    expect(render).toHaveBeenCalledTimes(1);
    expect(result.width).toBe(1600);
    expect(result.height).toBe(1200);
    // restored: device pixel ratio, then the CSS size the renderer reported
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    expect(setSize).toHaveBeenLastCalledWith(1600 / 3, 400);
  });

  test('restores the viewport even when the read-back fails', async () => {
    const { studio, renderer, setSize } = fakeStudio({ toBlob: (cb) => cb(null) });
    await expect(captureViewportStill(studio, 1)).rejects.toThrow(/could not be captured/);
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    expect(setSize).toHaveBeenLastCalledWith(1600 / 3, 400);
  });
});

describe('captureTransparentStill', () => {
  const pose = new Map<string, THREE.Matrix4 | null>([['a', new THREE.Matrix4().makeTranslation(1, 2, 3)], ['b', null]]);
  const camera = {
    ortho: false,
    position: new THREE.Vector3(10, 20, 30),
    quaternion: new THREE.Quaternion(),
    fov: 40, near: 0.1, far: 500,
    orthoHeight: 0,
    view: { enabled: true, fullWidth: 1000, fullHeight: 1000, offsetX: 10, offsetY: 20, width: 500, height: 500 },
  };
  const options = {
    instances: [], width: 800, height: 600, pose, camera,
    box: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
    groundY: 0,
  };

  test('uses a transparent offscreen studio and replays pose and camera', async () => {
    const setMatrices = vi.fn();
    const setSceneSetup = vi.fn();
    const setProjection = vi.fn();
    const render = vi.fn();
    const dispose = vi.fn();
    const setViewOffset = vi.fn();
    const perspective = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      fov: 30, near: 0.1, far: 2000,
      clearViewOffset: vi.fn(),
      setViewOffset,
      updateProjectionMatrix: vi.fn(),
    };
    const created: Studio[] = [];
    const fake = {
      renderer: { domElement: { toBlob: (cb: (b: Blob | null) => void) => cb(blob()) } },
      bricks: { setInstances: vi.fn(), setMatrices },
      setLook: vi.fn(), setRenderOptions: vi.fn(), setSceneSetup, setSize: vi.fn(), fitTo: vi.fn(),
      setProjection, perspective, ortho: { ...perspective }, render, dispose,
    } as unknown as Studio;
    const createStudio = vi.fn((canvas: unknown, opts: unknown) => {
      expect(opts).toEqual({ preserveDrawingBuffer: true, transparent: true });
      created.push(fake);
      return fake;
    });
    const out = await captureTransparentStill(options, { createStudio: createStudio as never, createCanvas: () => ({ toBlob: (cb: (b: Blob | null) => void) => cb(blob()) }) as never });
    expect(out.size).toBeGreaterThan(0);
    expect(createStudio).toHaveBeenCalledTimes(1);
    expect(setProjection).toHaveBeenCalledWith('perspective');
    expect(perspective.position.toArray()).toEqual([10, 20, 30]);
    expect(perspective.fov).toBe(40);
    expect(setViewOffset).toHaveBeenCalledWith(1000, 1000, 10, 20, 500, 500);
    expect(setMatrices).toHaveBeenCalledTimes(1);
    expect((setMatrices.mock.calls[0][0] as (k: string) => unknown)('a')).toBeInstanceOf(THREE.Matrix4);
    expect((setMatrices.mock.calls[0][0] as (k: string) => unknown)('b')).toBeNull();
    expect(setSceneSetup).toHaveBeenCalledWith(undefined, false, null, 800 / 600);
    expect(render).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('disposes the offscreen studio when rendering fails', async () => {
    const dispose = vi.fn();
    const fake = {
      renderer: { domElement: {} },
      bricks: { setInstances: vi.fn(), setMatrices: vi.fn() },
      setSceneSetup: vi.fn(), setSize: vi.fn(), fitTo: vi.fn(), setProjection: vi.fn(),
      perspective: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), clearViewOffset: vi.fn(), setViewOffset: vi.fn(), updateProjectionMatrix: vi.fn() },
      ortho: {}, render: () => { throw new Error('no context'); }, dispose,
    } as unknown as Studio;
    await expect(captureTransparentStill(options, {
      createStudio: (() => fake) as never,
      createCanvas: () => ({ toBlob: (cb: (b: Blob | null) => void) => cb(blob()) }) as never,
    })).rejects.toThrow('no context');
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('turntableSampler', () => {
  const bounds = { min: [-40, -24, -40] as [number, number, number], max: [40, 0, 40] as [number, number, number] };
  const instance = { key: 'a', world: new THREE.Matrix4().makeTranslation(5, 0, 0) } as never;
  const sampler = turntableSampler({
    instances: [instance], bounds, width: 1080, height: 1920, fps: 30, seconds: 6,
    camera: DEFAULT_CAMERA_SETTINGS, signal: new AbortController().signal,
  });

  test('turns a full circle at a constant distance', () => {
    const aspect = 1080 / 1920;
    const start = sampler.camera(0, aspect);
    const quarter = sampler.camera(1.5, aspect);
    const end = sampler.camera(6, aspect);
    // a whole turn comes back to where it began
    expect(start.position.distanceTo(end.position)).toBeLessThan(1e-6);
    // and the radius never changes, so the model does not drift while orbiting
    const radius = (pose: typeof start) => pose.position.distanceTo(pose.target);
    expect(quarter.position.distanceTo(start.position)).toBeGreaterThan(1);
    expect(radius(quarter)).toBeCloseTo(radius(start), 6);
    expect(quarter.fov).toBe(start.fov);
  });

  test('shows the supplied poses and reports the box and ground', () => {
    expect(sampler.duration).toBe(6);
    expect(sampler.groundY).toBe(0);
    const get = sampler.at(2);
    expect(get('a')).toBeInstanceOf(THREE.Matrix4);
    expect(get('missing')).toBeNull();
  });
});

describe('file names and recording support', () => {
  test('composes a sanitised name', () => {
    expect(captureFileName('Whirl/Truck', 'truck', 'capture', 'png')).toBe('Whirl-Truck - truck - capture.png');
    expect(captureFileName('Set', '', 'turntable', 'mp4')).toBe('Set - turntable.mp4');
  });

  test('recorder support is reported honestly', () => {
    const original = globalThis.MediaRecorder;
    // no recorder in this environment
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    expect(recorderMime()).toBeNull();
    expect(canRecordViewport(null)).toBe(false);
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = class {
      static isTypeSupported(type: string) { return type === 'video/webm;codecs=vp8'; }
    };
    expect(recorderMime()).toBe('video/webm;codecs=vp8');
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = original;
  });

  afterEach(() => vi.restoreAllMocks());
});
