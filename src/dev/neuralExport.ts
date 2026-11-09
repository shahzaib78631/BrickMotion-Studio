/**
 * Dev-only: draws one training scene (data/neuralshade/<id>/scene.json) with the viewport renderer
 * and saves the buffers the learned shader reads, next to EyeSight's target.png:
 *   frame   the viewport's own render, as the app shows it            RGBA8
 *   albedo  EyeSight's colour of every brick, unlit                    RGBA8
 *   normal  world-space normal ×½+½ (alpha 255 where a brick is)       RGBA8
 *   pos     r: view distance ÷ far, g: height above floor ÷ 64 studs      RGBA16F (raw half floats)
 * Each is raw RGBA, bottom row first, gzipped (.bin.gz).
 *
 *   /neural.html?scene=scene_01000          one scene
 */
import * as THREE from 'three';
import { initPartService, ensureParts } from '../state/partService';
import { createStudio } from '../render/studio';
import { DEFAULT_MATERIALS } from '../render/looks';
import { GBuffer } from '../render/gbuffer';
import { DomeVisibility } from '../render/domeVisibility';
import type { Instance } from '../model/assemble';

const st = document.getElementById('st')!;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const log = (m: string) => { st.textContent += `\n${m}`; };

type SceneFile = { id: string; width: number; height: number; camera: { position: number[]; target: number[]; fov: number; near: number; far: number }; pieces: { key: string; part: string; color: number; world: number[] }[] };

async function gzip(buf: Uint8Array): Promise<Blob> {
  const cs = new Blob([buf as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(cs).blob();
}
async function save(path: string, bytes: Uint8Array) {
  const r = await fetch(`/__neural/save?path=${encodeURIComponent(path)}`, { method: 'POST', body: await gzip(bytes) });
  if (!r.ok) throw new Error(`save ${path}: ${await r.text()}`);
}

async function main() {
  const params = new URLSearchParams(location.search);
  // ?queue=a,b,c exports a, then reloads itself for b, and so on
  const queue = (params.get('queue') ?? '').split(',').filter(Boolean);
  const id = params.get('scene') ?? queue.shift();
  const specOnly = params.get('speconly') === '1'; // only the shine buffer (everything else is already saved)
  const visOnly = params.get('visonly') === '1' || specOnly; // only the extra buffers, skipping frame/albedo/normal/pos
  if (!id) throw new Error('add ?scene=scene_01000 or ?queue=scene_01000,scene_01001');
  const dir = `data/neuralshade/${id}`;
  const sc = (await (await fetch(`/${dir}/scene.json`)).json()) as SceneFile;
  const W = sc.width, H = sc.height;
  canvas.width = W; canvas.height = H;
  await initPartService();
  await ensureParts([...new Set(sc.pieces.map((p) => p.part))]);
  const instances = sc.pieces.map((p) => ({ key: p.key, itemId: p.key, model: '', part: p.part, color: p.color, placeholder: false, grid: false, world: new THREE.Matrix4().fromArray(p.world) })) as unknown as Instance[];
  const mats = new Map(instances.map((i) => [i.key, i.world] as const));

  const studio = createStudio(canvas, { preserveDrawingBuffer: true });
  studio.setRenderOptions?.({ edges: false, linearColors: true });
  studio.setLook?.('bricklink-white');
  studio.setMaterials?.({ ...DEFAULT_MATERIALS });
  await studio.ready?.();
  studio.setSize(W, H);
  studio.renderer.setPixelRatio(1);
  studio.setSceneSetup(undefined, false, null, W / H);
  studio.bricks.setInstances(instances);
  studio.bricks.setMatrices((k: string) => mats.get(k) ?? null);
  const box = new THREE.Box3();
  for (const i of instances) box.expandByPoint(new THREE.Vector3(i.world.elements[12] / 20, -i.world.elements[13] / 20, -i.world.elements[14] / 20));
  box.expandByScalar(12); box.min.y = 0;
  studio.fitTo(box, 0);
  const p = studio.perspective;
  p.position.set(...(sc.camera.position as [number, number, number])); p.up.set(0, 1, 0); p.lookAt(new THREE.Vector3(...(sc.camera.target as [number, number, number])));
  p.fov = sc.camera.fov; p.aspect = W / H; p.near = sc.camera.near; p.far = sc.camera.far; p.updateProjectionMatrix();
  p.updateMatrixWorld(true);

  const gl = studio.renderer.getContext() as WebGL2RenderingContext;
  const readFrame = () => {
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  if (!visOnly || specOnly) {
  // 1. the viewport's own frame
  if (!specOnly) {
    studio.render();
    await save(`${dir}/frame.bin.gz`, readFrame());
    log('frame ✓');
  }

  // 2. G-buffers (shared with the live viewport): every brick drawn with a flat-colour material
  const gb = new GBuffer(studio.renderer, W, H);
  gb.render(studio.scene, studio.bricks.root, p, sc.camera.far);
  for (const [name, target] of [['albedo', gb.albedo], ['normal', gb.normal], ['pos', gb.pos], ['spec', gb.spec]] as const) {
    if (specOnly && name !== 'spec') continue;
    const half = name === 'pos';
    const out = half ? new Uint16Array(W * H * 4) : new Uint8Array(W * H * 4);
    studio.renderer.readRenderTargetPixels(target, 0, 0, W, H, out);
    await save(`${dir}/${name}.bin.gz`, new Uint8Array(out.buffer));
    log(`${name} ✓`);
  }
  }
  // 3. dome visibility: how much of the sky each pixel sees, converged (rays against a BVH of the model)
  if (!specOnly) {
  const dome = new DomeVisibility(studio.renderer, { groundY: 0, scale: 1, rays: 4, maxFrames: 64 });
  dome.setSize(W, H);
  dome.setScene(studio.bricks.root);
  let tex = dome.render(p);
  for (let i = 1; i < 24; i++) tex = dome.render(p);
  const half = new Uint16Array(W * H * 4);
  studio.renderer.readRenderTargetPixels((dome as unknown as { out: THREE.WebGLRenderTarget }).out, 0, 0, W, H, half);
  const h2f = (h: number) => { const e = (h >> 10) & 31, m = h & 1023; return e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15); };
  const vis = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) vis[i] = Math.max(0, Math.min(255, Math.round(h2f(half[i * 4]) * 255)));
  void tex;
  await save(`${dir}/vis.bin.gz`, vis);
  dome.dispose();
  log('vis ✓');
  }
  st.textContent += `\nDONE ${id}`;
  (window as unknown as Record<string, unknown>).neuralDone = true;
  if (queue.length) setTimeout(() => { location.search = `?${specOnly ? 'speconly=1&' : visOnly ? 'visonly=1&' : ''}queue=${queue.join(',')}`; }, 500);
}
main().catch((e) => { st.textContent += `\nERROR ${e?.stack ?? e}`; console.error(e); (window as unknown as Record<string, unknown>).neuralError = String(e); });
