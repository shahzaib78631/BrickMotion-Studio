import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { bakeSurfaceVisibility, cosineDirection, type SurfaceBakeInput, type SurfaceGeometry } from '../../src/render/surfaceCacheCore';
import { SurfaceLightingCache } from '../../src/render/surfaceCache';

function data(g: THREE.BufferGeometry): SurfaceGeometry {
  return { positions: new Float32Array(g.attributes.position.array), normals: new Float32Array(g.attributes.normal.array),
    index: g.index ? new Uint32Array(g.index.array) : null };
}
function plane(): SurfaceGeometry {
  return data(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
}
function input(blocker = false, scale = 1): SurfaceBakeInput {
  const matrices = new THREE.Matrix4().makeScale(scale, scale * 2, scale).toArray();
  const result: SurfaceBakeInput = { geometries: [plane()], batches: [{ geometry: 0, matrices: new Float32Array(matrices) }],
    rays: 64, maxDistance: 10 * scale, bias: 0.001 * scale };
  if (blocker) {
    result.geometries.push(data(new THREE.BoxGeometry(100, 0.1, 100)));
    result.batches.push({ geometry: 1, matrices: new Float32Array(new THREE.Matrix4().makeTranslation(0, scale, 0).toArray()) });
  }
  return result;
}

describe('surface visibility cache', () => {
  it('samples the outward hemisphere with unit directions', () => {
    for (const normal of [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 2, 3).normalize()]) {
      let mean = 0;
      for (let i = 0; i < 128; i++) {
        const direction = cosineDirection(i, 128, normal);
        expect(direction.length()).toBeCloseTo(1, 6);
        expect(direction.dot(normal)).toBeGreaterThan(0);
        mean += direction.dot(normal);
      }
      expect(mean / 128).toBeCloseTo(2 / 3, 2);
    }
  });

  it('leaves an exposed surface open and detects an off-camera blocker', () => {
    const open = bakeSurfaceVisibility(input());
    expect([...open.values[0]].every((v) => v === 255)).toBe(true);
    const covered = bakeSurfaceVisibility({ ...input(true), maxDistance: 100 });
    for (let i = 0; i < covered.values[0].length; i += 4) expect(covered.values[0][i]).toBe(0);
  });

  it('respects finite world distance under nonuniform instance transforms', () => {
    const scene = input(true, 2);
    scene.maxDistance = 0.5;
    const result = bakeSurfaceVisibility(scene);
    for (let i = 0; i < result.values[0].length; i += 4) expect(result.values[0][i]).toBe(255);
  });

  it('handles hidden instances without singular transforms and gives each instance its own cache', () => {
    const scene = input();
    scene.batches[0].matrices = new Float32Array([
      ...new THREE.Matrix4().toArray(), ...new THREE.Matrix4().makeScale(0, 0, 0).toArray(),
    ]);
    const result = bakeSurfaceVisibility(scene);
    expect(result.values[0].length).toBe(4 * 4 * 2);
    expect([...result.values[0]].every((v) => v === 255)).toBe(true);
  });

  it('is deterministic and does not mutate source indices', () => {
    const scene = input(true);
    const before = scene.geometries.map((g) => g.index?.slice());
    expect(bakeSurfaceVisibility(scene).values).toEqual(bakeSurfaceVisibility(scene).values);
    expect(scene.geometries.map((g) => g.index)).toEqual(before);
  });

  it('rejects invalid sampling settings', () => {
    expect(() => bakeSurfaceVisibility({ ...input(), rays: 0 })).toThrow('Invalid');
  });

  it('stores separate visibility for the back of a two-sided sheet', () => {
    const scene = input(true);
    scene.maxDistance = 100;
    scene.batches[0].twoSided = true;
    const result = bakeSurfaceVisibility(scene);
    expect(result.values[0][0]).toBe(0);
    expect(result.values[0][1]).toBe(255);
  });
});

describe('surface cache lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());
  class WorkerStub {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror = null;
    terminate() {}
    postMessage(input: SurfaceBakeInput) {
      queueMicrotask(() => this.onmessage?.({ data: { type: 'complete', result: bakeSurfaceVisibility(input) } }));
    }
  }
  const renderer = { capabilities: { maxTextureSize: 4096 } } as THREE.WebGLRenderer;
  function setup() {
    vi.stubGlobal('Worker', WorkerStub);
    const original = new THREE.MeshStandardMaterial();
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), original, 1);
    mesh.setMatrixAt(0, new THREE.Matrix4());
    const root = new THREE.Group(); root.add(mesh);
    return { root, mesh, original, cache: new SurfaceLightingCache() };
  }

  it('preserves original materials and invalidates when an instance moves without a version bump', async () => {
    const { root, mesh, original, cache } = setup();
    await cache.bake(root, renderer, { rays: 4 });
    expect(cache.status).toBe('ready');
    expect(mesh.material).not.toBe(original);
    expect(cache.validate()).toBe(true);
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(2, 0, 0));
    expect(cache.validate()).toBe(false);
    expect(cache.status).toBe('invalid');
    expect(mesh.material).toBe(original);
  });

  it('discards an in-flight result when the scene changes', async () => {
    const { root, mesh, original, cache } = setup();
    const pending = cache.bake(root, renderer, { rays: 4 });
    mesh.position.x = 5;
    await expect(pending).rejects.toThrow('Scene changed');
    expect(mesh.material).toBe(original);
  });

  it('detects additions and restores original materials on disposal', async () => {
    const { root, mesh, original, cache } = setup();
    await cache.bake(root, renderer, { rays: 4 });
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial()));
    expect(cache.validate()).toBe(false);
    expect(mesh.material).toBe(original);
    await cache.bake(root, renderer, { rays: 4 });
    cache.dispose();
    expect(cache.status).toBe('empty');
    expect(mesh.material).toBe(original);
  });
});
