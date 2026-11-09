import * as THREE from 'three';
import type { SurfaceBakeInput, SurfaceBakeResult } from './surfaceCacheCore';

type Snapshot = {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  positionVersion: number;
  normalVersion: number;
  indexVersion: number;
  matrices: Float32Array;
  material: THREE.Material;
};
type Installed = { snapshot: Snapshot; material: THREE.Material; texture: THREE.DataTexture };

function worldMatrices(mesh: THREE.Mesh): Float32Array {
  const instanced = mesh as THREE.InstancedMesh;
  const count = instanced.isInstancedMesh ? instanced.count : 1;
  const values = new Float32Array(count * 16), matrix = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    if (instanced.isInstancedMesh) instanced.getMatrixAt(i, matrix); else matrix.identity();
    matrix.premultiply(mesh.matrixWorld).toArray(values, i * 16);
  }
  return values;
}

function eligible(root: THREE.Object3D): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  root.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material) || !mesh.geometry.attributes.normal) return;
    const material = mesh.material as THREE.MeshPhysicalMaterial;
    // Glass needs transmission transport; do not silently bake it as an opaque solid.
    if (!material.isMeshStandardMaterial || material.transparent || material.transmission > 0) return;
    result.push(mesh);
  });
  return result;
}

/**
 * Experimental camera-independent opaque dome cache. No neural inference, G-buffer,
 * screen-space tracing or extra draw pass after baking. It modifies indirect diffuse
 * and approximates environment-specular occlusion before tone mapping. Direct lighting
 * and its highlights are preserved. Call validate() before rendering after any scene edit.
 * It is deliberately opt-in; the normal viewport and training pipeline are untouched.
 */
export class SurfaceLightingCache {
  private worker: Worker | null = null;
  private rejectBake: ((error: Error) => void) | null = null;
  private snapshots: Snapshot[] = [];
  private installed: Installed[] = [];
  private amount = { value: 1 };
  private root: THREE.Object3D | null = null;
  status: 'empty' | 'baking' | 'ready' | 'invalid' = 'empty';
  stats: Omit<SurfaceBakeResult, 'values'> & { textureBytes: number } | null = null;

  setStrength(value: number): void { this.amount.value = THREE.MathUtils.clamp(value, 0, 1); }

  /** Read-only material pairs for controlled baseline measurements. Restore before validate(). */
  originalMaterials(): readonly (readonly [THREE.Mesh, THREE.Material])[] {
    return this.installed.map(({ snapshot }) => [snapshot.mesh, snapshot.material] as const);
  }

  /** Exact matrix comparison also catches edits that didn't mark instanceMatrix.needsUpdate. */
  validate(): boolean {
    if (!this.root || (this.status !== 'ready' && this.status !== 'baking')) return false;
    this.root.updateWorldMatrix(true, true);
    const meshes = eligible(this.root);
    const valid = meshes.length === this.snapshots.length && this.snapshots.every((s, i) => {
      if (meshes[i] !== s.mesh || s.mesh.geometry !== s.geometry) return false;
      const own = this.installed.find((entry) => entry.snapshot === s);
      if (s.mesh.material !== (own?.material ?? s.material)) return false;
      if ((s.geometry.attributes.position as THREE.BufferAttribute).version !== s.positionVersion ||
          (s.geometry.attributes.normal as THREE.BufferAttribute).version !== s.normalVersion ||
          (s.geometry.index?.version ?? 0) !== s.indexVersion) return false;
      const matrices = worldMatrices(s.mesh);
      return matrices.length === s.matrices.length && matrices.every((v, j) => v === s.matrices[j]);
    });
    if (!valid) { this.clear(); this.status = 'invalid'; }
    return valid;
  }

  async bake(root: THREE.Object3D, renderer: THREE.WebGLRenderer, options: {
    rays?: number; maxDistance?: number; bias?: number; onProgress?: (fraction: number) => void;
  } = {}): Promise<void> {
    this.clear();
    this.root = root;
    root.updateWorldMatrix(true, true);
    const meshes = eligible(root);
    if (!meshes.length) throw new Error('No supported opaque surfaces to bake');
    const input: SurfaceBakeInput = { geometries: [], batches: [], rays: options.rays ?? 64,
      maxDistance: options.maxDistance ?? 32, bias: options.bias ?? 0.003 };
    const geometryIds = new Map<THREE.BufferGeometry, number>();
    const maxSize = renderer.capabilities.maxTextureSize;
    this.snapshots = meshes.map((mesh) => {
      const g = mesh.geometry;
      let id = geometryIds.get(g);
      if (id === undefined) {
        id = input.geometries.length; geometryIds.set(g, id);
        const positions = new Float32Array(g.attributes.position.count * 3);
        const normals = new Float32Array(positions.length);
        const v = new THREE.Vector3();
        for (let i = 0; i < g.attributes.position.count; i++) {
          v.fromBufferAttribute(g.attributes.position, i).toArray(positions, i * 3);
          v.fromBufferAttribute(g.attributes.normal, i).toArray(normals, i * 3);
        }
        input.geometries.push({ positions, normals, index: g.index ? new Uint32Array(g.index.array) : null });
      }
      const matrices = worldMatrices(mesh);
      const texels = g.attributes.position.count * matrices.length / 16;
      if (texels > maxSize * maxSize || texels > 16_777_216) throw new Error('Surface cache exceeds texture/addressing capacity; split this batch');
      input.batches.push({ geometry: id, matrices, twoSided: (mesh.material as THREE.Material).side === THREE.DoubleSide });
      return { mesh, geometry: g, matrices, material: mesh.material as THREE.Material,
        positionVersion: (g.attributes.position as THREE.BufferAttribute).version,
        normalVersion: (g.attributes.normal as THREE.BufferAttribute).version, indexVersion: g.index?.version ?? 0 };
    });
    this.status = 'baking';
    const worker = new Worker(new URL('./surfaceCache.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    try {
      const result = await new Promise<SurfaceBakeResult>((resolve, reject) => {
        this.rejectBake = reject;
        worker.onerror = (error) => reject(new Error(error.message));
        worker.onmessage = (event) => {
          const data = event.data;
          if (data.type === 'progress') options.onProgress?.(data.total ? data.done / data.total : 1);
          else if (data.type === 'error') reject(new Error(data.message));
          else if (data.type === 'complete') resolve(data.result);
        };
        // Keep matrices on this thread for invalidation; structured cloning never detaches scene buffers.
        worker.postMessage(input);
      });
      if (this.worker !== worker) throw new Error('Surface bake cancelled');
      this.rejectBake = null;
      if (!this.validate()) throw new Error('Scene changed during surface bake; result discarded');
      let textureBytes = 0;
      result.values.forEach((bytes, i) => {
        const snapshot = this.snapshots[i];
        const width = Math.min(maxSize, bytes.length / 4), height = Math.ceil(bytes.length / 4 / width);
        const pixels = new Uint8Array(width * height * 4).fill(255); pixels.set(bytes);
        const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
        texture.colorSpace = THREE.NoColorSpace; texture.needsUpdate = true;
        textureBytes += pixels.byteLength;
        const original = snapshot.material;
        const material = original.clone();
        const previousCompile = original.onBeforeCompile;
        const previousKey = original.customProgramCacheKey.call(original);
        const count = snapshot.geometry.attributes.position.count;
        const amount = this.amount;
        material.onBeforeCompile = (shader, r) => {
          previousCompile.call(material, shader, r);
          shader.uniforms.bmSurfaceCache = { value: texture };
          shader.uniforms.bmSurfaceWidth = { value: width };
          shader.uniforms.bmSurfaceCount = { value: count };
          shader.uniforms.bmSurfaceStrength = amount;
          shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
uniform sampler2D bmSurfaceCache;
uniform int bmSurfaceWidth;
uniform int bmSurfaceCount;
varying vec2 bmSurfaceVisibility;`).replace('#include <begin_vertex>', `#include <begin_vertex>
int bmSurfaceAddress = gl_VertexID;
#ifdef USE_INSTANCING
bmSurfaceAddress += gl_InstanceID * bmSurfaceCount;
#endif
bmSurfaceVisibility = texelFetch(bmSurfaceCache, ivec2(bmSurfaceAddress % bmSurfaceWidth, bmSurfaceAddress / bmSurfaceWidth), 0).rg;`);
          shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
uniform float bmSurfaceStrength;
varying vec2 bmSurfaceVisibility;`).replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
float bmVisibility = mix(1.0, clamp(gl_FrontFacing ? bmSurfaceVisibility.x : bmSurfaceVisibility.y, 0.0, 1.0), bmSurfaceStrength);
reflectedLight.indirectDiffuse *= bmVisibility;
// Same inexpensive approximation used by Three's AO maps; this is not traced glossy transport.
#if defined(USE_ENVMAP) && defined(STANDARD)
reflectedLight.indirectSpecular *= computeSpecularOcclusion(saturate(dot(geometryNormal, geometryViewDir)), bmVisibility, material.roughness);
#endif
#ifdef USE_CLEARCOAT
clearcoatSpecularIndirect *= bmVisibility;
#endif
#ifdef USE_SHEEN
sheenSpecularIndirect *= bmVisibility;
#endif`);
        };
        material.customProgramCacheKey = () => `${previousKey}|surface-cache-v1`;
        snapshot.mesh.material = material;
        this.installed.push({ snapshot, material, texture });
      });
      this.stats = { samples: result.samples, rays: result.rays, elapsedMs: result.elapsedMs, textureBytes };
      this.status = 'ready';
    } finally {
      worker.terminate();
      if (this.worker === worker) { this.worker = null; this.rejectBake = null; }
      if (this.status === 'baking') this.status = 'empty';
    }
  }

  clear(): void {
    this.worker?.terminate(); this.worker = null;
    this.rejectBake?.(new Error('Surface bake cancelled')); this.rejectBake = null;
    for (const entry of this.installed) {
      if (entry.snapshot.mesh.material === entry.material) entry.snapshot.mesh.material = entry.snapshot.material;
      entry.material.dispose(); entry.texture.dispose();
    }
    this.installed = []; this.snapshots = []; this.root = null; this.stats = null; this.status = 'empty';
  }

  dispose(): void { this.clear(); }
}
