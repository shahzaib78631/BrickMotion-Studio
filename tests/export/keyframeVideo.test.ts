import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { Instance } from '../../src/model/assemble';
import type { Timeline } from '../../src/anim/timeline';

const spy = vi.hoisted(() => ({ stamps: [] as number[], cancelled: 0, finalized: 0 }));
vi.mock('mediabunny', () => {
  class Output {
    target: { buffer: ArrayBuffer | null };
    constructor(opts: { target: { buffer: ArrayBuffer | null } }) { this.target = opts.target; }
    addVideoTrack() {}
    async start() {}
    async finalize() { spy.finalized++; this.target.buffer = new ArrayBuffer(8); }
    async cancel() { spy.cancelled++; }
  }
  class CanvasSource { async add(t: number) { spy.stamps.push(t); } }
  class BufferTarget { buffer: ArrayBuffer | null = null; }
  return { Output, CanvasSource, BufferTarget, Mp4OutputFormat: class {}, QUALITY_HIGH: 'high', QUALITY_MEDIUM: 'medium', canEncodeVideo: async () => true };
});

import { emptyAnimation, insertKeys } from '../../src/anim/keyframes';
import { buildTimeline } from '../../src/anim/timeline';
import { measurePart } from '../../src/ldraw/metrics';
import { animationDuration, animationFrameAtVideoTime, exportKeyframeVideo, keyframeSceneBounds } from '../../src/export/exportVideo';

const brick = (): Instance => ({ key: 'brick', itemId: 'brick', model: '', part: '3001', color: 4,
  placeholder: false, grid: true, world: new THREE.Matrix4(), worldBox: { min: [0, -24, 0], max: [20, 0, 20] } });
const canvas = () => ({ width: 100, height: 100, getContext: () => ({ drawImage: vi.fn(), globalAlpha: 1 }) }) as unknown as OffscreenCanvas;
const studio = () => {
  const matrices: Array<number | null> = [];
  const positions: THREE.Vector3[] = [];
  const stub = { createStudio: vi.fn(() => ({
    bricks: { setInstances: vi.fn(), setMatrices: (at: (key: string) => THREE.Matrix4 | null) => { const pose = at('brick'); matrices.push(pose?.elements[12] ?? null); } },
    perspective: { position: { copy: vi.fn((v: THREE.Vector3) => positions.push(v.clone())) }, lookAt: vi.fn(), fov: 30, updateProjectionMatrix: vi.fn(),
      clearViewOffset: vi.fn(), setViewOffset: vi.fn() },
    setSize: vi.fn(), setSceneSetup: vi.fn(), fitTo: vi.fn(), render: vi.fn(), dispose: vi.fn(),
  })), createCanvas: canvas };
  return { stub: stub as unknown as Parameters<typeof exportKeyframeVideo>[1], matrices, positions };
};
const options = (animation = emptyAnimation(), signal = new AbortController().signal) => ({
  animation, editingModel: '', placements: new Map(), buildTimeline: null,
  instances: [brick()], width: 640, height: 360, fps: 48, logo: null,
  onProgress: vi.fn(), signal,
});
beforeEach(() => { spy.stamps = []; spy.cancelled = 0; spy.finalized = 0; });

describe('Timeline MP4 export', () => {
  it('samples the authored animation at video FPS independently of the authoring FPS', async () => {
    const a = insertKeys(insertKeys({ ...emptyAnimation(), endFrame: 25 }, 1,
      [{ model: '', target: 'brick', channel: 'location.x', value: 0 }]), 25,
      [{ model: '', target: 'brick', channel: 'location.x', value: 4 }]);
    const { stub, matrices } = studio();
    const result = await exportKeyframeVideo(options(a), stub);
    expect(matrices).toHaveLength(50); // 25 author frames at 24 fps, sampled at 48 fps
    expect(matrices[0]).toBeCloseTo(0);
    expect(matrices[49]).toBeCloseTo(80); // four studs, not four LDraw units
    expect(spy.stamps[1]).toBe(1 / 48);
    expect(spy.finalized).toBe(1);
    expect(result.type).toBe('video/mp4');
    expect(animationDuration(a)).toBeCloseTo(25 / 24);
    expect(animationFrameAtVideoTime(a, 1 / 48)).toBeCloseTo(1.5);
  });
  it('exports a static Timeline even when the Build planner has no route', async () => {
    const { stub, matrices } = studio();
    await exportKeyframeVideo(options({ ...emptyAnimation(), endFrame: 2 }), stub);
    expect(matrices).toEqual([0, 0, 0, 0]); // no missing planner dependency
  });
  it('preserves invisible pieces and layers animated offsets over the Build result', async () => {
    // A real timeline keeps the Build camera available; only its flights are simplified.
    const built = buildTimeline({ nodes: [], instances: [], bounds: null, problems: [] },
      (p) => measurePart(null, p), { targetSeconds: 15, heroOrbit: false });
    const source = { ...built, duration: 1,
      sceneBox: { min: [0, -24, 0], max: [120, 0, 20] },
      units: [], tracks: new Map([['brick', { appear: 0.5, floor: new THREE.Matrix4(),
        floorBox: { min: [0, -24, 0], max: [20, 0, 20] }, ctx: 0, moves: [], final: new THREE.Matrix4().makeTranslation(100, 0, 0) }]]) } as unknown as Timeline;
    const a = insertKeys({ ...emptyAnimation(), endFrame: 25, buildLayers: { '': { startFrame: 1, speed: 1 } } }, 14,
      [{ model: '', target: 'brick', channel: 'location.x', value: 2 }]);
    const { stub, matrices } = studio();
    await exportKeyframeVideo({ ...options(a), buildTimeline: source }, stub);
    expect(matrices[0]).toBeNull();
    expect(matrices[21]).toBeNull();
    expect(matrices[26]).toBeCloseTo(140);
    expect(matrices.at(-1)).toBeCloseTo(140);
  });
  it('reports unavailable procedural Build rather than exporting incorrect static geometry', async () => {
    const linked = { ...emptyAnimation(), buildLayers: { '': { startFrame: 1, speed: 1 } } };
    const { stub } = studio();
    await expect(exportKeyframeVideo(options(linked), stub)).rejects.toThrow('construction planning failed');
  });
  it('follows the Build camera and its hero orbit for build-derived motion', async () => {
    const built = buildTimeline({ nodes: [], instances: [], bounds: null, problems: [] },
      (p) => measurePart(null, p), { targetSeconds: 15, heroOrbit: true });
    const source = { ...built, buildEnd: 0.2, duration: 2, heroOrbit: true,
      modelBox: { min: [-20, -20, -20] as [number, number, number], max: [20, 20, 20] as [number, number, number] } };
    const { stub, positions } = studio();
    await exportKeyframeVideo({ ...options({ ...emptyAnimation(), endFrame: 25 }), buildTimeline: source }, stub);
    expect(positions.length).toBeGreaterThan(1);
    // A static fit would show the identical camera in every frame.
    expect(positions[0].distanceTo(positions[positions.length - 1])).toBeGreaterThan(0.1);
  });
  it('includes distant animated positions in camera framing', () => {
    const clip = insertKeys(emptyAnimation(), 10, [{ model: '', target: 'brick', channel: 'location.z', value: 40 }]);
    const b = keyframeSceneBounds(options(clip));
    expect(b.max.z).toBeGreaterThan(39); // editor Z is reversed from LDraw Z
  });
  it('cancels an in-progress Timeline video without finalizing its MP4', async () => {
    const ac = new AbortController();
    const o = { ...options({ ...emptyAnimation(), endFrame: 10 }, ac.signal),
      onProgress: (done: number) => { if (done === 1) ac.abort(); } };
    const { stub } = studio();
    await expect(exportKeyframeVideo(o, stub)).rejects.toMatchObject({ name: 'AbortError' });
    expect(spy.cancelled).toBe(1);
    expect(spy.finalized).toBe(0);
  });
});
