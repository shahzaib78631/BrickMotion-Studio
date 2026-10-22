import { beforeEach, expect, test, vi } from 'vitest';

const calls = vi.hoisted(() => ({ add: [] as number[], cancel: 0, finalize: 0 }));
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
  return { Output, CanvasSource, Mp4OutputFormat, BufferTarget, QUALITY_HIGH: 'high', canEncodeVideo: async () => true };
});

import { buildTimeline } from '../../src/anim/timeline';
import { exportVideo, frameCount, drawLogo, type ExportOpts } from '../../src/export/exportVideo';
import { measurePart } from '../../src/ldraw/metrics';

beforeEach(() => {
  calls.add = [];
  calls.cancel = 0;
  calls.finalize = 0;
});

const fakeCtx = () => ({ drawImage: vi.fn(), globalAlpha: 1, fillRect: vi.fn() });
const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => fakeCtx() }) as unknown as OffscreenCanvas;
const fakeStudio = () => {
  const render = vi.fn();
  const create = vi.fn(() => ({
    renderer: {},
    scene: {},
    camera: { position: { copy: vi.fn() }, lookAt: vi.fn(), fov: 30, updateProjectionMatrix: vi.fn() },
    bricks: { setInstances: vi.fn(), setMatrices: vi.fn() },
    setSize: vi.fn(),
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
