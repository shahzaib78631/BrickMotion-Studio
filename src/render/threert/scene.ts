import * as THREE from 'three';
import type { ThreeRTEngine } from './engine';

type GeometryAPI = Pick<ThreeRTEngine, 'geometry'>;

/** Copy attributes explicitly: interleaved buffers and nonindexed LDraw faces are both valid. */
export function uploadGeometry(engine: GeometryAPI, id: number, source: THREE.BufferGeometry): void {
  const geometry = source.getAttribute('normal') ? source : source.clone();
  if (geometry !== source) geometry.computeVertexNormals();
  try {
    const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
    if (!p || !n) throw new Error('ThreeRT: model geometry has no positions/normals.');
    const uv = geometry.getAttribute('uv');
    const positions = new Float32Array(p.count * 3), normals = new Float32Array(p.count * 3), uvs = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      positions.set([p.getX(i), p.getY(i), p.getZ(i)], i * 3);
      normals.set([n.getX(i), n.getY(i), n.getZ(i)], i * 3);
      if (uv) uvs.set([uv.getX(i), uv.getY(i)], i * 2);
    }
    const index = geometry.index;
    const available = index?.count ?? p.count;
    const start = Math.min(available, Math.max(0, geometry.drawRange.start));
    const end = Math.min(available, start + geometry.drawRange.count);
    const indices = Uint32Array.from({ length: Math.floor((end - start) / 3) * 3 }, (_, i) => index ? index.getX(start + i) : start + i);
    const groups: number[] = [];
    for (const group of geometry.groups) {
      const lo = Math.max(start, group.start), hi = Math.min(end, group.start + group.count);
      if (hi > lo) groups.push(lo - start, hi - lo, group.materialIndex ?? 0);
    }
    engine.geometry(id, positions, normals, uvs, indices, groups.length ? new Uint32Array(groups) : undefined);
  } finally { if (geometry !== source) geometry.dispose(); }
}

/** Preserve full affine LDraw transforms, including reflection and shear. No TRS decomposition. */
export function instanceWorldMatrices(source: THREE.InstancedMesh, target: Float32Array = new Float32Array(source.count * 16)): Float32Array {
  const local = new THREE.Matrix4(), world = new THREE.Matrix4();
  for (let i = 0; i < source.count; i++) {
    source.getMatrixAt(i, local);
    world.multiplyMatrices(source.matrixWorld, local).toArray(target, i * 16);
  }
  return target;
}

export function shown(source: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = source; node; node = node.parent) if (!node.visible) return false;
  return true;
}

export function describeMaterial(source: THREE.Material): Record<string, unknown> {
  const material = source as THREE.MeshPhysicalMaterial;
  // Upstream implements surface-tinted transmission, not KHR_materials_volume.
  // Do not claim attenuationDistance/thickness parity or modify its shader to fake it.
  return {
    name: source.name || source.uuid,
    color: material.color?.toArray() ?? [0.8, 0.8, 0.8],
    opacity: source.opacity, metalness: material.metalness ?? 0, roughness: material.roughness ?? 0.5,
    emissive: material.emissive?.toArray() ?? [0, 0, 0], emissiveIntensity: material.emissiveIntensity ?? 1,
    doubleSided: source.side === THREE.DoubleSide, transparent: source.transparent,
    transmission: material.transmission ?? 0, ior: material.ior ?? 1.5,
    clearcoat: material.clearcoat ?? 0, clearcoatRoughness: material.clearcoatRoughness ?? 0,
    specularIntensity: material.specularIntensity ?? 1, alphaTest: source.alphaTest || null,
    unlit: (source as THREE.MeshBasicMaterial).isMeshBasicMaterial === true,
  };
}
