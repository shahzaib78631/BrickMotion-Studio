import * as THREE from 'three';

/**
 * Studio geometry captured once into the existing PMREM lighting map.
 * Broad panels produce readable white reflections on plastic; the neutral surround
 * keeps the diffuse fill soft. These meshes never enter the model or shadow passes.
 */
export function createSoftboxEnvironment(pmrem: THREE.PMREMGenerator): THREE.WebGLRenderTarget {
  const scene = new THREE.Scene();
  // Dark space between panels supplies contrast in the reflection. A bright
  // surround fills every reflection direction and makes red ABS look pink.
  scene.background = new THREE.Color().setRGB(0.18, 0.18, 0.18, THREE.LinearSRGBColorSpace);
  const panels: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  const panel = (position: [number, number, number], width: number, height: number, radiance: number) => {
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(radiance, radiance, radiance), side: THREE.DoubleSide, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    mesh.position.set(...position); mesh.lookAt(0, 0, 0);
    panels.push(mesh); scene.add(mesh);
  };
  // Tall strips are deliberately different sizes: a broad face reflection and a thin rim.
  panel([-6, 3, 4], 3, 7, 3);
  panel([6, 2, 2], 1.5, 6, 2.5);
  panel([0, 8, -2], 7, 5, 1.8);
  panel([1, 2, -7], 3, 5, 1.5);
  try {
    return pmrem.fromScene(scene, 0.025, 0.1, 30);
  } finally {
    for (const mesh of panels) { mesh.geometry.dispose(); mesh.material.dispose(); }
    scene.clear();
  }
}
