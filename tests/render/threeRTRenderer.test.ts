import { afterEach, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { Studio } from '../../src/render/studio';
const mock = vi.hoisted(() => ({ engine: {
  resetEngine: vi.fn(), geometry: vi.fn(), material: vi.fn(), object: vi.fn(), transform: vi.fn(),
  instances: vi.fn(), visible: vi.fn(), camera: vi.fn(), environment: vi.fn(), settings: vi.fn(),
  start: vi.fn(async () => '{}'), frameBegin: vi.fn(), frameEnd: vi.fn(() => '{"frame":1,"gpu_ms":0,"scale":1,"guard_trips":0}'),
  markSubmitted: vi.fn(), frameIdle: vi.fn(() => true),
}, release: vi.fn() }));
vi.mock('../../src/render/threert/engine', () => ({ acquireThreeRT: async () => ({ engine: mock.engine, release: mock.release }) }));
import { ThreeRTRenderer } from '../../src/render/threeRTRenderer';
function scene() {
  const root = new THREE.Group();
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 2);
  root.add(mesh);
  const bricks = { root, structureVersion: 0, poseVersion: 0 };
  const camera = new THREE.PerspectiveCamera(); camera.position.z = 5;
  const studio = { bricks, camera, groundY: 0 } as unknown as Studio;
  return { studio, bricks, mesh, canvas: { width: 0, height: 0 } as HTMLCanvasElement };
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('updates poses without reuploading geometry or restarting the Rust engine', async () => {
  vi.stubGlobal('navigator', { gpu: {} });
  const { studio, bricks, mesh, canvas } = scene();
  const renderer = await ThreeRTRenderer.create(canvas, studio, { width: 100, height: 60, palette: 'ldraw' });
  mock.engine.geometry.mockClear(); mock.engine.resetEngine.mockClear(); mock.engine.instances.mockClear();
  renderer.renderSample(); expect(mock.engine.instances).not.toHaveBeenCalled();
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(4, 2, 1)); bricks.poseVersion++;
  renderer.renderSample();
  expect(mock.engine.instances).toHaveBeenCalledTimes(1);
  expect(mock.engine.instances.mock.calls[0][2][28]).toBe(4);
  expect(mock.engine.geometry).not.toHaveBeenCalled(); expect(mock.engine.resetEngine).not.toHaveBeenCalled();
  renderer.dispose(); expect(mock.release).toHaveBeenCalledTimes(1);
});
it('holds ownership until an in-flight resize finishes, then releases it once', async () => {
  vi.stubGlobal('navigator', { gpu: {} }); vi.useFakeTimers();
  const { studio, canvas } = scene();
  const renderer = await ThreeRTRenderer.create(canvas, studio, { width: 100, height: 60, palette: 'ldraw' });
  let finish!: (value: string) => void;
  mock.engine.start.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  renderer.setSize(200, 120);
  await vi.advanceTimersByTimeAsync(151);
  expect(renderer.ready).toBe(false);
  renderer.dispose(); expect(mock.release).not.toHaveBeenCalled();
  finish('{}'); await vi.advanceTimersByTimeAsync(0);
  // The lease itself is idempotent; a single session should also release it once.
  expect(mock.release).toHaveBeenCalledTimes(1);
  expect(renderer.ready).toBe(false);
});

it('keeps only one GPU submission in flight and uploads the newest animation pose', async () => {
  vi.stubGlobal('navigator', { gpu: {} });
  const { studio, canvas, bricks, mesh } = scene();
  const renderer = await ThreeRTRenderer.create(canvas, studio, { width: 100, height: 60, palette: 'ldraw' });
  renderer.renderSample(); mock.engine.frameEnd.mockClear(); mock.engine.instances.mockClear();
  mock.engine.frameIdle.mockReturnValue(false);
  for (let x = 1; x <= 4; x++) {
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(x, 0, 0)); bricks.poseVersion++;
    expect(renderer.renderSample()).toBe(true);
  }
  expect(mock.engine.frameEnd).not.toHaveBeenCalled(); expect(mock.engine.instances).not.toHaveBeenCalled();
  mock.engine.frameIdle.mockReturnValue(true); renderer.renderSample();
  expect(mock.engine.frameEnd).toHaveBeenCalledTimes(1);
  expect(mock.engine.instances.mock.calls[0][2][12]).toBe(4);
  renderer.dispose();
});
