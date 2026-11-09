import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** Worker protocol. Geometry is sent once, regardless of the instance count. */
export type SurfaceGeometry = { positions: Float32Array; normals: Float32Array; index: Uint32Array | null };
export type SurfaceBatch = { geometry: number; matrices: Float32Array; twoSided?: boolean };
export type SurfaceBakeInput = {
  geometries: SurfaceGeometry[];
  batches: SurfaceBatch[];
  rays: number;
  maxDistance: number;
  bias: number;
};
export type SurfaceBakeResult = { values: Uint8Array[]; samples: number; rays: number; elapsedMs: number };

type Instance = { geometry: number; inverse: THREE.Matrix4; matrix: THREE.Matrix4; bounds: THREE.Box3 };
type Node = { bounds: THREE.Box3; children?: [Node, Node]; instances?: Instance[] };

function tree(instances: Instance[]): Node {
  const bounds = new THREE.Box3();
  for (const i of instances) bounds.union(i.bounds);
  if (instances.length <= 4) return { bounds, instances };
  const s = bounds.getSize(new THREE.Vector3());
  const axis = s.x >= s.y && s.x >= s.z ? 'x' : s.y >= s.z ? 'y' : 'z';
  instances.sort((a, b) => a.bounds.min[axis] + a.bounds.max[axis] - b.bounds.min[axis] - b.bounds.max[axis]);
  const middle = Math.floor(instances.length / 2);
  return { bounds, children: [tree(instances.slice(0, middle)), tree(instances.slice(middle))] };
}

/** Deterministic cosine-weighted hemisphere samples. No temporal noise or camera dependence. */
export function cosineDirection(index: number, count: number, normal: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const r = Math.sqrt((index + 0.5) / count);
  const phi = index * Math.PI * (3 - Math.sqrt(5));
  const tangent = new THREE.Vector3(normal.y, -normal.x, 0);
  if (tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0);
  tangent.normalize();
  const bitangent = new THREE.Vector3().crossVectors(normal, tangent);
  return out.copy(normal).multiplyScalar(Math.sqrt(1 - r * r))
    .addScaledVector(tangent, r * Math.cos(phi)).addScaledVector(bitangent, r * Math.sin(phi)).normalize();
}

/**
 * Opaque uniform-dome visibility, not GI. One BLAS per geometry and a small instance
 * hierarchy avoid copying triangles for every brick. Intended to run in a worker.
 * Vertex interpolation is an explicit approximation on large, sparsely tessellated faces.
 * The floor is deliberately excluded: the existing renderer owns floor/contact lighting.
 */
export function bakeSurfaceVisibility(input: SurfaceBakeInput, progress?: (done: number, total: number) => void): SurfaceBakeResult {
  const started = performance.now();
  if (!Number.isInteger(input.rays) || input.rays < 1 || input.rays > 1024 ||
      !Number.isFinite(input.maxDistance) || input.maxDistance <= 0 ||
      !Number.isFinite(input.bias) || input.bias <= 0) throw new Error('Invalid surface bake options');
  const geometries = input.geometries.map((g) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
    if (g.index) geometry.setIndex(new THREE.BufferAttribute(g.index, 1));
    geometry.computeBoundingBox();
    // indirect preserves the vertex/index ordering used by the GPU lookup.
    return { geometry, bvh: new MeshBVH(geometry, { indirect: true }) };
  });
  const batchInstances = input.batches.map((batch) => {
    const result: (Instance | null)[] = [];
    for (let offset = 0; offset < batch.matrices.length; offset += 16) {
      const matrix = new THREE.Matrix4().fromArray(batch.matrices, offset);
      if (Math.abs(matrix.determinant()) < 1e-12) { result.push(null); continue; }
      result.push({ geometry: batch.geometry, matrix, inverse: matrix.clone().invert(),
        bounds: geometries[batch.geometry].geometry.boundingBox!.clone().applyMatrix4(matrix) });
    }
    return result;
  });
  const instances = batchInstances.flat().filter((i): i is Instance => i !== null);
  const top = tree(instances);
  const ray = new THREE.Ray(), localRay = new THREE.Ray();
  const end = new THREE.Vector3(), localEnd = new THREE.Vector3(), near = new THREE.Vector3();
  const blocked = (node: Node): boolean => {
    if (!ray.intersectBox(node.bounds, near)) return false;
    if (!node.bounds.containsPoint(ray.origin) && ray.origin.distanceToSquared(near) > input.maxDistance ** 2) return false;
    if (node.children) return blocked(node.children[0]) || blocked(node.children[1]);
    for (const instance of node.instances!) {
      if (!ray.intersectsBox(instance.bounds)) continue;
      // Convert both endpoints: this preserves world-space ray length under nonuniform scale.
      localRay.origin.copy(ray.origin).applyMatrix4(instance.inverse);
      localEnd.copy(end).applyMatrix4(instance.inverse);
      localRay.direction.subVectors(localEnd, localRay.origin);
      const length = localRay.direction.length();
      localRay.direction.divideScalar(length);
      if (geometries[instance.geometry].bvh.raycastFirst(localRay, THREE.DoubleSide, 0, length)) return true;
    }
    return false;
  };
  const total = input.batches.reduce((n, b) => n + input.geometries[b.geometry].positions.length / 3 * b.matrices.length / 16, 0);
  let done = 0, samples = 0;
  const normal = new THREE.Vector3(), position = new THREE.Vector3(), direction = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  const values = input.batches.map((batch, bi) => {
    const source = input.geometries[batch.geometry], count = source.positions.length / 3;
    const result = new Uint8Array(count * batchInstances[bi].length * 4).fill(255);
    batchInstances[bi].forEach((instance, ii) => {
      if (!instance) { done += count; return; }
      normalMatrix.getNormalMatrix(instance.matrix);
      // Share coincident vertices only when their shading normals also match.
      const cache = new Map<string, [number, number]>();
      for (let vertex = 0; vertex < count; vertex++) {
        const p = vertex * 3;
        const key = `${source.positions[p]},${source.positions[p + 1]},${source.positions[p + 2]}:${source.normals[p]},${source.normals[p + 1]},${source.normals[p + 2]}`;
        let visibility = cache.get(key);
        if (visibility === undefined) {
          position.fromArray(source.positions, p).applyMatrix4(instance.matrix);
          normal.fromArray(source.normals, p).applyNormalMatrix(normalMatrix);
          visibility = [255, 255];
          for (let side = 0; side < (batch.twoSided ? 2 : 1); side++) {
            if (side === 1) normal.negate();
            ray.origin.copy(position).addScaledVector(normal, input.bias);
            let open = 0;
            for (let sample = 0; sample < input.rays; sample++) {
              cosineDirection(sample, input.rays, normal, direction);
              ray.direction.copy(direction);
              end.copy(ray.origin).addScaledVector(direction, input.maxDistance);
              if (!blocked(top)) open++;
            }
            visibility[side] = Math.round(255 * open / input.rays);
            samples++;
          }
          if (!batch.twoSided) visibility[1] = visibility[0];
          cache.set(key, visibility);
        }
        const offset = (ii * count + vertex) * 4;
        result[offset] = visibility[0]; result[offset + 1] = visibility[1];
        done++;
        if (done % 2048 === 0) progress?.(done, total);
      }
    });
    return result;
  });
  for (const { geometry } of geometries) geometry.dispose();
  progress?.(total, total);
  return { values, samples, rays: samples * input.rays, elapsedMs: performance.now() - started };
}
