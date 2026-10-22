import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { geometryOf, getColors } from '../state/partService';
import { BrickRenderer } from './bricks';

export const STUDIO_BG = '#EDEDEF';

export type Studio = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  bricks: BrickRenderer;
  setSize(w: number, h: number): void;
  /** Floor height and light/shadow framing for a world-space box (studs, +Y up). */
  fitTo(box: THREE.Box3, groundY: number): void;
  render(): void;
  dispose(): void;
};

export function createStudio(canvas: HTMLCanvasElement | OffscreenCanvas, opts: { preserveDrawingBuffer?: boolean } = {}): Studio {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: !!opts.preserveDrawingBuffer, alpha: false });
  renderer.setPixelRatio(typeof window !== 'undefined' && canvas instanceof HTMLCanvasElement ? Math.min(window.devicePixelRatio, 2) : 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(STUDIO_BG);
  scene.fog = new THREE.Fog(STUDIO_BG, 120, 320);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.6;

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(1000, 1000),
    new THREE.MeshStandardMaterial({ color: STUDIO_BG, roughness: 0.92, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xd8d8dc, 1.1);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 4;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);

  const camera = new THREE.PerspectiveCamera(30, 9 / 16, 0.1, 2000);
  camera.position.set(20, 25, 40);

  const bricks = new BrickRenderer(geometryOf, getColors());
  scene.add(bricks.root);

  return {
    renderer,
    scene,
    camera,
    bricks,
    setSize(w, h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    fitTo(box, groundY) {
      floor.position.y = groundY - 0.001;
      const c = box.getCenter(new THREE.Vector3());
      const r = Math.max(8, box.getSize(new THREE.Vector3()).length() / 2);
      const fog = scene.fog as THREE.Fog;
      fog.near = r * 10;
      fog.far = r * 24;
      key.target.position.copy(c);
      key.position.copy(c).add(new THREE.Vector3(-0.5, 1.2, 0.7).normalize().multiplyScalar(r * 3));
      const s = key.shadow.camera;
      s.left = s.bottom = -r * 1.3;
      s.right = s.top = r * 1.3;
      s.near = 0.1;
      s.far = r * 6;
      s.updateProjectionMatrix();
    },
    render() {
      renderer.render(scene, camera);
    },
    dispose() {
      bricks.dispose();
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}

/** Converts an LDU box to world units (studs, +Y up). */
export function worldBox(b: { min: number[]; max: number[] }): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(b.min[0] / 20, -b.max[1] / 20, -b.max[2] / 20), new THREE.Vector3(b.max[0] / 20, -b.min[1] / 20, -b.min[2] / 20));
}
