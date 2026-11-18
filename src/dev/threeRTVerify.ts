/** Small real-GPU smoke test without downloading the parts library. */
import * as THREE from 'three';
import { ThreeRTRenderer } from '../render/threeRTRenderer';
import type { Studio } from '../render/studio';
const telemetry = { ready: false, error: '', renderAttempts: 0, status: '', tests: [] as string[] };
(window as unknown as { __aoBench: typeof telemetry }).__aoBench = telemetry;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const root = new THREE.Group();
const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshPhysicalMaterial({ color: '#d63a20', roughness: 0.25 }), 3);
boxes.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-1, 0.5, 0));
boxes.setMatrixAt(1, new THREE.Matrix4().makeScale(-1, 1, 1).setPosition(1, 0.5, 0));
boxes.setMatrixAt(2, new THREE.Matrix4().makeScale(0, 0, 0)); root.add(boxes);
const camera = new THREE.PerspectiveCamera(35, 640 / 400, 0.01, 100);
camera.position.set(4, 3, 6); camera.lookAt(0, 0.5, 0);
const bricks = { root, structureVersion: 0, poseVersion: 0, wireframe: () => false };
const studio = { bricks, camera, groundY: 0, projection: 'perspective' } as unknown as Studio;
let renderer: ThreeRTRenderer;
async function frame() { renderer.renderSample(); telemetry.renderAttempts++; telemetry.status = renderer.status; await new Promise(requestAnimationFrame); }
async function frames(count: number) {
  const target = renderer.frameCount + count, deadline = performance.now() + 60_000;
  while (renderer.frameCount < target) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for real GPU frames.');
    await frame();
  }
}
async function run() {
  renderer = await ThreeRTRenderer.create(canvas, studio, { width: 640, height: 400, palette: 'ldraw' });
  await frames(40);
  telemetry.tests.push('rendered upstream frames, reflected instance and hidden zero-scale instance');
  boxes.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-1, 1, 0)); bricks.poseVersion++;
  camera.position.x += 0.2; camera.lookAt(0, 0.5, 0);
  await frames(10);
  telemetry.tests.push('updated live camera and instance poses');
  renderer.setSize(480, 300);
  for (let i = 0; i < 200 && !renderer.ready; i++) { renderer.renderSample(); await new Promise(resolve => setTimeout(resolve, 50)); }
  if (!renderer.ready) throw new Error('Resize did not settle.');
  await frames(10);
  telemetry.tests.push('resized renderer');
  renderer.dispose();
  renderer = await ThreeRTRenderer.create(canvas, studio, { width: 640, height: 400, palette: 'ldraw' });
  await frames(20);
  telemetry.tests.push('disposed and reopened the engine on the same canvas');
}
void run().catch(error => { telemetry.error = String(error?.stack ?? error); console.error(error); }).finally(() => {
  telemetry.ready = true;
  document.getElementById('status')!.textContent = JSON.stringify(telemetry, null, 2);
});
