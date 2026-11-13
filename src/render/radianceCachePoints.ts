import * as THREE from 'three';

export type RadiancePoints = { positions: Float32Array; normals: Float32Array; table: Float32Array; count: number; cellSize: number; width: number; height: number; tableWidth: number };
export const normalCode = (x: number, y: number, z: number) => (Math.round(x * 4) + 4) * 81 + (Math.round(y * 4) + 4) * 9 + Math.round(z * 4) + 4;
export const planeCode = (p: THREE.Vector3, n: THREE.Vector3) => Math.round(p.dot(n) / 0.01);
export const cellHash = (x: number, y: number, z: number, normal: number, plane = 0) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ Math.imul(normal, 2654435761) ^ Math.imul(plane, 1597334677)) >>> 0;

/** Bounded surface sampling. Unrepresented cells remain full transport, never guessed. */
export function collectRadiancePoints(model: THREE.Object3D, bounds: THREE.Box3, maxPoints = 2048): RadiancePoints {
  if (!Number.isInteger(maxPoints) || maxPoints < 1 || maxPoints > 8192) throw new Error('Invalid radiance point budget');
  model.updateMatrixWorld(true);
  const cellSize = Math.fround(Math.max(0.05, bounds.getSize(new THREE.Vector3()).length() / 48));
  const candidateBudget = 65536;
  const candidates: { p: THREE.Vector3; n: THREE.Vector3; area: number }[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3();
  model.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh || candidates.length >= candidateBudget) return;
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
    if (Array.isArray(mesh.material) || !mesh.material.isMeshPhysicalMaterial || mesh.material.transparent || mesh.material.transmission > 0 || mesh.material.metalness > 0.01 || mesh.material.clearcoat > 0 || Math.abs(mesh.matrixWorld.determinant()) < 1e-15) return;
    const positions = mesh.geometry.getAttribute('position'), normals = mesh.geometry.getAttribute('normal'), indices = mesh.geometry.index;
    if (!positions || !normals) return;
    const count = Math.floor((indices?.count ?? positions.count) / 3), step = Math.max(1, Math.floor(count / 160));
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for (let triangle = 0; triangle < count && candidates.length < candidateBudget; triangle += step) {
      const ia = indices ? indices.getX(triangle * 3) : triangle * 3;
      const ib = indices ? indices.getX(triangle * 3 + 1) : triangle * 3 + 1;
      const ic = indices ? indices.getX(triangle * 3 + 2) : triangle * 3 + 2;
      a.fromBufferAttribute(positions, ia).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(positions, ib).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(positions, ic).applyMatrix4(mesh.matrixWorld);
      const area = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
      if (area < 1e-10) continue;
      normal.fromBufferAttribute(normals, ia).add(new THREE.Vector3().fromBufferAttribute(normals, ib)).add(new THREE.Vector3().fromBufferAttribute(normals, ic)).applyNormalMatrix(normalMatrix);
      if (normal.lengthSq() < 0.99) continue;
      const subdivisions = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(area) / cellSize)));
      for (let y = 0; y < subdivisions && candidates.length < candidateBudget; y++) for (let x = 0; x < subdivisions - y && candidates.length < candidateBudget; x++) {
        const u = (x + 1 / 3) / subdivisions, v = (y + 1 / 3) / subdivisions;
        candidates.push({ p: a.clone().multiplyScalar(1 - u - v).addScaledVector(b, u).addScaledVector(c, v), n: normal.clone(), area });
      }
    }
  });
  candidates.sort((a, b) => b.area - a.area);
  const unique = new Map<string, { p: THREE.Vector3; n: THREE.Vector3 }>();
  for (const point of candidates) {
    const { p, n } = point;
    p.set(Math.fround(p.x), Math.fround(p.y), Math.fround(p.z));
    n.set(Math.fround(n.x), Math.fround(n.y), Math.fround(n.z));
    const key = `${Math.floor(Math.fround(p.x / cellSize))},${Math.floor(Math.fround(p.y / cellSize))},${Math.floor(Math.fround(p.z / cellSize))},${normalCode(n.x, n.y, n.z)},${planeCode(p,n)}`;
    if (!unique.has(key)) unique.set(key, point);
    if (unique.size >= maxPoints) break;
  }
  if (!unique.size) throw new Error('No supported opaque surfaces for the hybrid cache');
  const width = Math.min(64, unique.size), height = Math.ceil(unique.size / width);
  const positions = new Float32Array(width * height * 4), normals = new Float32Array(positions.length);
  const tableWidth = 128, slots = tableWidth * tableWidth, table = new Float32Array(slots * 4);
  const points = [...unique.values()];
  points.forEach(({ p, n }, index) => {
    p.toArray(positions, index * 4); positions[index * 4 + 3] = 1;
    n.toArray(normals, index * 4); normals[index * 4 + 3] = normalCode(n.x, n.y, n.z);
    const x = Math.floor(Math.fround(p.x / cellSize)), y = Math.floor(Math.fround(p.y / cellSize)), z = Math.floor(Math.fround(p.z / cellSize));
    const hash = cellHash(x, y, z, normalCode(n.x, n.y, n.z), planeCode(p,n));
    for (let probe = 0; probe < 8; probe++) {
      const offset = ((hash + probe) & (slots - 1)) * 4;
      if (table[offset + 3] === 0) { table.set([x, y, z, index + 1], offset); break; }
    }
  });
  // The tracer's minimum sample count includes padding pixels; give these a real
  // probe too. Padding is never addressed by the hash table.
  for (let i = points.length; i < width * height; i++) { positions.set(positions.subarray(0, 4), i * 4); normals.set(normals.subarray(0, 4), i * 4); }
  return { positions, normals, table, count: points.length, cellSize, width, height, tableWidth };
}
