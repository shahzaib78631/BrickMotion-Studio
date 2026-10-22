import { get, set } from 'idb-keyval';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ensureParts, geometryOf, getColors } from '../state/partService';
import { materialFor } from './materials';

const SIZE = 128;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let queue: Promise<unknown> = Promise.resolve();
const memo = new Map<string, Promise<string>>();

function setup() {
  if (renderer) return;
  const canvas = document.createElement('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcccccc, 1.2));
  const d = new THREE.DirectionalLight(0xffffff, 1.6);
  d.position.set(-1, 2, 1.5);
  scene.add(d);
}

async function renderThumb(partId: string, color: number): Promise<Blob | null> {
  await ensureParts([partId]);
  const geo = geometryOf(partId);
  if (!geo) return null;
  setup();
  const group = new THREE.Group();
  group.rotation.x = Math.PI;
  const colors = getColors();
  const add = (g: THREE.BufferGeometry | null, c: number, ds: boolean) => g && group.add(new THREE.Mesh(g, materialFor(colors.get(c), ds)));
  add(geo.main, color, false);
  add(geo.mainDoubleSided, color, true);
  for (const f of geo.fixed) add(f.geometry, f.color, f.doubleSided);
  scene!.add(group);
  const box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getBoundingSphere(new THREE.Sphere()).radius;
  const cam = new THREE.PerspectiveCamera(30, 1, 1, 10000);
  const dir = new THREE.Vector3(0.75, 0.6, 1).normalize();
  cam.position.copy(c).add(dir.multiplyScalar(r / Math.sin((15 * Math.PI) / 180)));
  cam.lookAt(c);
  renderer!.setClearColor(0x000000, 0);
  renderer!.render(scene!, cam);
  scene!.remove(group);
  return new Promise((res) => (renderer!.domElement as HTMLCanvasElement).toBlob((b) => res(b), 'image/png'));
}

/** Object URL of a 128×128 part thumbnail, cached in IndexedDB. Empty string if the part can't be drawn. */
export function getThumbnail(partId: string, colorCode = 71): Promise<string> {
  const key = `thumb:${partId}:${colorCode}`;
  let p = memo.get(key);
  if (!p) {
    p = (async () => {
      try {
        const cached = await get<Blob>(key);
        if (cached) return URL.createObjectURL(cached);
      } catch {
        /* storage unavailable */
      }
      const job = queue.then(() => renderThumb(partId, colorCode));
      queue = job.catch(() => undefined);
      const blob = await job;
      if (!blob) return '';
      set(key, blob).catch(() => undefined);
      return URL.createObjectURL(blob);
    })();
    memo.set(key, p);
  }
  return p;
}
