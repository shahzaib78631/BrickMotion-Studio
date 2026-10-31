import { beforeEach, expect, test, vi } from 'vitest';

const calls = vi.hoisted(() => ({ add: [] as number[], cancel: 0, finalize: 0, encodeConfig: null as unknown }));
vi.mock('mediabunny', () => {
  class Output {
    target: { buffer: ArrayBuffer | null };
    constructor(o: { target: { buffer: ArrayBuffer | null } }) {
      this.target = o.target;
    }
    addVideoTrack() {}
    async start() {}
    async finalize() {
      calls.finalize++;
      this.target.buffer = new ArrayBuffer(8);
    }
    async cancel() {
      calls.cancel++;
    }
  }
  class CanvasSource {
    async add(t: number) {
      calls.add.push(t);
    }
  }
  class Mp4OutputFormat {}
  class BufferTarget {
    buffer: ArrayBuffer | null = null;
  }
  return { Output, CanvasSource, Mp4OutputFormat, BufferTarget, QUALITY_HIGH: 'high', canEncodeVideo: async (_codec: string, config: unknown) => ((calls.encodeConfig = config), true) };
});

const lensCalls = vi.hoisted(() => ({ made: 0, px: [] as number[] }));
vi.mock('../../src/render/depthOfField', () => ({
  LensPass: class {
    constructor() { lensCalls.made++; }
    apply(_s: unknown, o: { lens: { px?: number } }) { lensCalls.px.push(o.lens.px ?? -1); }
    dispose() {}
  },
}));

const blurCalls = vi.hoisted(() => ({ made: 0, adds: 0, resolves: 0 }));
vi.mock('../../src/render/motionBlur', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/render/motionBlur')>()),
  MotionBlurAccumulator: class {
    constructor() { blurCalls.made++; }
    begin() {}
    add() { blurCalls.adds++; }
    resolve() { blurCalls.resolves++; }
    dispose() {}
  },
}));

import { buildTimeline } from '../../src/anim/timeline';
import { canExportMp4, exportVideo, frameCount, drawLogo, type ExportOpts } from '../../src/export/exportVideo';
import { FPS_OPTIONS, isExportFps } from '../../src/export/frameRates';
import { measurePart } from '../../src/ldraw/metrics';

beforeEach(() => {
  lensCalls.made = 0;
  blurCalls.made = 0; blurCalls.adds = 0; blurCalls.resolves = 0;
  lensCalls.px = [];
  calls.add = [];
  calls.cancel = 0;
  calls.finalize = 0;
  calls.encodeConfig = null;
});

const fakeCtx = () => ({ drawImage: vi.fn(), globalAlpha: 1, fillRect: vi.fn() });
const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => fakeCtx() }) as unknown as OffscreenCanvas;
const fakeStudio = () => {
  const render = vi.fn();
  const create = vi.fn(() => ({
    renderer: {},
    scene: {},
    camera: { position: { copy: vi.fn() }, lookAt: vi.fn(), fov: 30, updateProjectionMatrix: vi.fn() },
    perspective: { position: { copy: vi.fn() }, lookAt: vi.fn(), fov: 30, updateProjectionMatrix: vi.fn(),
      clearViewOffset: vi.fn(), setViewOffset: vi.fn() },
    bricks: { setInstances: vi.fn(), setMatrices: vi.fn() },
    setSize: vi.fn(),
    setSceneSetup: vi.fn(),
    fitTo: vi.fn(),
    render,
    dispose: vi.fn(),
  }));
  return { create, render };
};

const shortTimeline = () => {
  const tl = buildTimeline({ nodes: [], instances: [], bounds: null, problems: [] }, (p) => measurePart(null, p), { targetSeconds: 15, heroOrbit: true });
  return { ...tl, duration: 0.1 };
};

const opts = (signal: AbortSignal): ExportOpts => ({
  timeline: shortTimeline(),
  instances: [],
  width: 1080,
  height: 1920,
  fps: 30,
  logo: null,
  onProgress: () => {},
  signal,
});

test('frameCount', () => {
  expect(frameCount(15, 30)).toBe(450);
  expect(frameCount(4.01, 30)).toBe(121);
  expect(frameCount(0.1, 30)).toBe(3);
});

test('an already-aborted signal rejects with AbortError', async () => {
  const s = fakeStudio();
  const ac = new AbortController();
  ac.abort();
  await expect(exportVideo(opts(ac.signal), { createStudio: s.create as never, createCanvas: fakeCanvas })).rejects.toMatchObject({ name: 'AbortError' });
  expect(s.render).not.toHaveBeenCalled();
});

test('renders one frame per 1/30 s', async () => {
  const s = fakeStudio();
  const progress: number[] = [];
  const blob = await exportVideo(
    { ...opts(new AbortController().signal), onProgress: (d) => progress.push(d) },
    { createStudio: s.create as never, createCanvas: fakeCanvas },
  );
  expect(s.render).toHaveBeenCalledTimes(3);
  expect(calls.add).toEqual([0, 1 / 30, 2 / 30]);
  expect(progress).toEqual([1, 2, 3]);
  expect(blob.type).toBe('video/mp4');
  expect(calls.finalize).toBe(1);
});

test('aborting mid-export cancels the output', async () => {
  const s = fakeStudio();
  const ac = new AbortController();
  const p = exportVideo({ ...opts(ac.signal), onProgress: (d) => d === 1 && ac.abort() }, { createStudio: s.create as never, createCanvas: fakeCanvas });
  await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls.cancel).toBe(1);
});


test('export FPS presets include cinematic, broadcast and high frame rates', () => {
  expect(FPS_OPTIONS).toEqual([24, 25, 30, 48, 50, 60, 90, 120]);
  expect(isExportFps(60)).toBe(true);
  expect(isExportFps(23)).toBe(false);
  expect(frameCount(1, 60)).toBe(60);
  expect(frameCount(1, 120)).toBe(120);
});

test('checks encoding support at the SELECTED size and frame rate', async () => {
  expect(await canExportMp4(1080, 1920, 120)).toBe(true);
  expect(calls.encodeConfig).toEqual({ width: 1080, height: 1920, frameRate: 120 });
});

test('exports all 60 FPS frames at uniform, exact media timestamps', async () => {
  const s = fakeStudio();
  const c = vi.fn(fakeCanvas);
  const result = await exportVideo({ ...opts(new AbortController().signal), fps: 60 }, { createStudio: s.create as never, createCanvas: c });
  expect(s.render).toHaveBeenCalledTimes(6);
  expect(calls.add).toEqual(Array.from({ length: 6 }, (_, i) => i / 60));
  expect(c).toHaveBeenCalledTimes(1); // no unnecessary full-HD composite without a logo
  expect(result.type).toBe('video/mp4');
});
test('logo: 22% wide, 48 px margin, 90% opacity', () => {
  const ctx = fakeCtx();
  const img = { width: 200, height: 100 } as ImageBitmap;
  drawLogo(ctx as unknown as CanvasRenderingContext2D, img, 'br', 1080, 1920);
  const [, x, y, w, h] = ctx.drawImage.mock.calls[0];
  expect(w).toBeCloseTo(237.6);
  expect(h).toBeCloseTo(118.8);
  expect(x).toBeCloseTo(1080 - 48 - 237.6);
  expect(y).toBeCloseTo(1920 - 48 - 118.8);
  expect(ctx.globalAlpha).toBe(1); // restored
});

test('with a camera track every frame looks where the track says', async () => {
  const { create } = fakeStudio();
  const target: [number, number, number] = [3, 4, 5];
  const cameraTrack = {
    keys: [{ id: 'a', t: 0, target: { kind: 'point' as const, at: target }, offset: [0, 0, 0] as [number, number, number], azimuth: 20, elevation: 30,
      distance: { fit: false as const, value: 40 }, roll: 0, lensMm: 50, focus: 0.5, blur: 0, origin: 'user' as const }],
    transitions: [], shutter: 0,
  };
  await exportVideo({ ...opts(new AbortController().signal), cameraTrack }, { createStudio: create as never, createCanvas: fakeCanvas });
  const studio = create.mock.results[0].value;
  const looks = studio.perspective.lookAt.mock.calls;
  expect(looks.length).toBe(calls.add.length);
  for (const [p] of looks) expect([p.x, p.y, p.z]).toEqual(target);
});

const blurTrack = (b0: number, b1: number) => {
  const k = (id: string, t: number, blur: number) => ({ id, t, target: { kind: 'point' as const, at: [0, 0, 0] as [number, number, number] },
    offset: [0, 0, 0] as [number, number, number], azimuth: 0, elevation: 20, distance: { fit: false as const, value: 40 }, roll: 0, lensMm: 50, focus: 0.5, blur, origin: 'user' as const });
  return { keys: [k('a', 0, b0), k('b', 0.1, b1)], transitions: [], shutter: 0 };
};

test('depth of field follows the camera track frame by frame', async () => {
  const { create } = fakeStudio();
  await exportVideo({ ...opts(new AbortController().signal), cameraTrack: blurTrack(0, 1) }, { createStudio: create as never, createCanvas: fakeCanvas });
  expect(lensCalls.made).toBe(1);
  expect(lensCalls.px.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < lensCalls.px.length; i++) expect(lensCalls.px[i]).toBeGreaterThan(lensCalls.px[i - 1]);
});

test('a camera track with no blur makes no lens pass', async () => {
  const { create } = fakeStudio();
  await exportVideo({ ...opts(new AbortController().signal), cameraTrack: blurTrack(0, 0) }, { createStudio: create as never, createCanvas: fakeCanvas });
  expect(lensCalls.made).toBe(0);
});

const swingTrack = (shutter: number) => {
  const k = (id: string, t: number, azimuth: number) => ({ id, t, target: { kind: 'point' as const, at: [0, 0, 0] as [number, number, number] },
    offset: [0, 0, 0] as [number, number, number], azimuth, elevation: 20, distance: { fit: false as const, value: 40 }, roll: 0, lensMm: 50, focus: 0.5, blur: 0, origin: 'user' as const });
  const settings = { curve: { kind: 'linear' as const, strength: 0 }, path: 'arc' as const, orbit: 'shortest' as const, extraTurns: 0, overshoot: 0,
    motionBlur: shutter, shake: { amount: 0, frequency: 0.6 }, cut: false, flowThrough: false };
  return { keys: [k('a', 0, 0), k('b', 0.1, 90)], transitions: [{ from: 'a', to: 'b', preset: 'whip-pan', settings, origin: 'user' as const }], shutter };
};

test('a fast camera move is rendered as several blurred sub-frames', async () => {
  const { create, render } = fakeStudio();
  await exportVideo({ ...opts(new AbortController().signal), cameraTrack: swingTrack(1) }, { createStudio: create as never, createCanvas: fakeCanvas });
  expect(blurCalls.made).toBe(1);
  expect(render.mock.calls.length).toBeGreaterThan(calls.add.length);
  expect(blurCalls.adds).toBe(render.mock.calls.length);
  expect(blurCalls.resolves).toBe(calls.add.length);
});

test('with the shutter shut every frame is one render', async () => {
  const { create, render } = fakeStudio();
  await exportVideo({ ...opts(new AbortController().signal), cameraTrack: swingTrack(0) }, { createStudio: create as never, createCanvas: fakeCanvas });
  expect(blurCalls.made).toBe(0);
  expect(render.mock.calls.length).toBe(calls.add.length);
});
