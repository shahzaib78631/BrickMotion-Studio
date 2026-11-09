/**
 * Dev-only: draws a crop of a training scene with the viewport renderer, with and without the learned
 * shader, next to EyeSight's render:  /neural-live.html?scene=scene_01004&x=1200&y=900&size=1024&model=shadenet_v1
 * Left: viewport. Middle: viewport + ShadeNet. Right: EyeSight.
 */
import * as THREE from 'three';
import { initPartService, ensureParts } from '../state/partService';
import { createStudio } from '../render/studio';
import { DEFAULT_MATERIALS } from '../render/looks';
import type { Instance } from '../model/assemble';
import { NeuralShade } from '../render/neuralShade';

const st = document.getElementById('st')!;
type SceneFile = { width: number; height: number; camera: { position: number[]; target: number[]; fov: number; near: number; far: number }; pieces: { key: string; part: string; color: number; world: number[] }[] };

async function main() {
  const q = new URLSearchParams(location.search);
  const id = q.get('scene') ?? 'scene_01004', X = Number(q.get('x') ?? 1100), Y = Number(q.get('y') ?? 800), S = Number(q.get('size') ?? 1024);
  const model = q.get('model') ?? 'shadenet_v1';
  const dir = `data/neuralshade/${id}`;
  const sc = (await (await fetch(`/${dir}/scene.json`)).json()) as SceneFile;
  const W = sc.width, H = sc.height;
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  canvas.width = S; canvas.height = S;
  await initPartService();
  await ensureParts([...new Set(sc.pieces.map((p) => p.part))]);
  const instances = sc.pieces.map((p) => ({ key: p.key, itemId: p.key, model: '', part: p.part, color: p.color, placeholder: false, grid: false, world: new THREE.Matrix4().fromArray(p.world) })) as unknown as Instance[];
  const mats = new Map(instances.map((i) => [i.key, i.world] as const));
  const studio = createStudio(canvas, { preserveDrawingBuffer: true });
  studio.setRenderOptions?.({ edges: false, linearColors: true });
  studio.setLook?.('bricklink-white');
  studio.setMaterials?.({ ...DEFAULT_MATERIALS });
  await studio.ready?.();
  studio.setSize(S, S);
  studio.renderer.setPixelRatio(1);
  studio.setSceneSetup(undefined, false, null, 1);
  studio.bricks.setInstances(instances);
  studio.bricks.setMatrices((k: string) => mats.get(k) ?? null);
  const box = new THREE.Box3();
  for (const i of instances) box.expandByPoint(new THREE.Vector3(i.world.elements[12] / 20, -i.world.elements[13] / 20, -i.world.elements[14] / 20));
  box.expandByScalar(12); box.min.y = 0;
  studio.fitTo(box, 0);
  const p = studio.perspective;
  p.position.set(...(sc.camera.position as [number, number, number])); p.up.set(0, 1, 0); p.lookAt(new THREE.Vector3(...(sc.camera.target as [number, number, number])));
  p.fov = sc.camera.fov; p.near = sc.camera.near; p.far = sc.camera.far;
  p.aspect = W / H;
  // draw only the S×S window at (X, Y) of the full W×H frame, pixel for pixel
  p.setViewOffset(W, H, X, Y, S, S);
  p.updateProjectionMatrix(); p.updateMatrixWorld(true);

  (window as unknown as Record<string, unknown>).nl = { studio, canvas, THREE };
  const copyTo = (id: string) => (document.getElementById(id) as HTMLCanvasElement).getContext('2d')!.drawImage(canvas, 0, 0);
  studio.render();
  copyTo('a');
  const t0 = performance.now();
  await studio.setNeural?.(`/models/${model}`);
  const load = performance.now() - t0;
  studio.render(); // first run: allocates and compiles
  const t1 = performance.now();
  studio.render();
  studio.renderer.getContext().finish();
  const ms = performance.now() - t1;
  copyTo('b');
  let extraLines = '';
  // compare the live buffers with what training saw (dumped from the exported files, same window)
  if (q.get('compare')) {
    const gb = (globalThis as unknown as { __gbuf: { albedo: THREE.WebGLRenderTarget; normal: THREE.WebGLRenderTarget; pos: THREE.WebGLRenderTarget } }).__gbuf;
    const get = async (n: string) => new Uint8Array(await (await fetch(`/data/neuralshade/nstest/${n}.bin`)).arrayBuffer());
    const lines: string[] = [];
    for (const [name, rt] of [['albedo', gb.albedo], ['normal', gb.normal]] as const) {
      const live = new Uint8Array(S * S * 4); studio.renderer.readRenderTargetPixels(rt, 0, 0, S, S, live);
      const saved = await get(name);
      let d = 0, big = 0; for (let i = 0; i < live.length; i++) { const e = Math.abs(live[i] - saved[i]); d += e; if (e > 20) big++; }
      lines.push(`${name}: mean diff ${(d / live.length).toFixed(2)}, >20: ${(100 * big / live.length).toFixed(2)}%`);
    }
    const livePos = new Uint16Array(S * S * 4); studio.renderer.readRenderTargetPixels(gb.pos, 0, 0, S, S, livePos);
    const savedPos = new Uint16Array((await get('pos')).buffer);
    const h2f = (h: number) => { const sg = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; return e === 0 ? sg * m * 2 ** -24 : sg * (1 + m / 1024) * 2 ** (e - 15); };
    let dd = 0, dh = 0; for (let i = 0; i < S * S; i++) { dd += Math.abs(h2f(livePos[i * 4]) - h2f(savedPos[i * 4])); dh += Math.abs(h2f(livePos[i * 4 + 1]) - h2f(savedPos[i * 4 + 1])); }
    lines.push(`pos depth mean diff ${(dd / (S * S) * 2000).toFixed(3)} studs, height ${(dh / (S * S) * 64).toFixed(3)} studs`);
    const frameSaved = await get('frame');
    studio.setNeural?.(null);
    studio.render();
    const gl = studio.renderer.getContext() as WebGL2RenderingContext; const fr = new Uint8Array(S * S * 4); gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, fr);
    let df = 0; for (let i = 0; i < fr.length; i++) if (i % 4 < 3) df += Math.abs(fr[i] - frameSaved[i]);
    lines.push(`frame: mean diff ${(df / (S * S * 3)).toFixed(2)}`);
    extraLines = `\n${lines.join('\n')}`;
  }
  if (q.get('swap')) {
    const gl = studio.renderer.getContext() as WebGL2RenderingContext;
    const gb = (globalThis as unknown as { __gbuf: { albedo: THREE.WebGLRenderTarget; normal: THREE.WebGLRenderTarget; pos: THREE.WebGLRenderTarget } }).__gbuf;
    const live = (rt: THREE.WebGLRenderTarget) => (studio.renderer.properties.get(rt.texture) as { __webglTexture: WebGLTexture }).__webglTexture;
    const bytes = async (n: string) => new Uint8Array(await (await fetch(`/data/neuralshade/nstest/${n}.bin`)).arrayBuffer());
    const up = (data: Uint8Array, half = false) => {
      const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
      if (half) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, S, S, 0, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(data.buffer));
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    };
    const saved = { frame: up(await bytes('frame')), albedo: up(await bytes('albedo')), normal: up(await bytes('normal')), pos: up(await bytes('pos'), true) };
    const expected = new Float32Array((await (await fetch('/data/neuralshade/nstest/expected.f32')).arrayBuffer()));
    // live frame
    const lf = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, lf); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    studio.setNeural?.(null); studio.render(); studio.renderer.setRenderTarget(null); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, S, S);
    const net = await NeuralShade.load(gl, `/models/${model}`); net.resize(S, S);
    const out2 = document.createElement('canvas'); void out2;
    const score = (): number => {
      const px = new Uint8Array(S * S * 4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let d = 0; for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) for (let c = 0; c < 3; c++) d += Math.abs(px[((S - 1 - y) * S + x) * 4 + c] / 255 - expected[(c * S + y) * S + x]);
      return (d / (S * S * 3)) * 255;
    };
    const res: string[] = [];
    for (const [name, use] of Object.entries({ 'all saved': {}, 'live frame': { frame: lf }, 'live albedo(raw)': { albedo: live(gb.albedo) }, 'live normal': { normal: live(gb.normal) }, 'live pos': { pos: live(gb.pos) } })) {
      const t = { ...saved, ...use } as typeof saved;
      net.run(t.frame, t.albedo, t.normal, t.pos, null, false);
      res.push(`${name}: ${score().toFixed(2)}/255`);
    }
    net.run(saved.frame, live(gb.albedo), saved.normal, saved.pos, null, true);
    res.push(`live albedo (sRGB-decoded): ${score().toFixed(2)}/255`);
    extraLines += `\nvs PyTorch — ${res.join(' | ')}`;
  }
  const img = new Image();
  img.src = `/${dir}/target.png`;
  await img.decode();
  (document.getElementById('t') as HTMLCanvasElement).getContext('2d')!.drawImage(img, X, Y, S, S, 0, 0, S, S);
  st.textContent = `${id} crop ${X},${Y} ${S}px · load ${load.toFixed(0)} ms · neural frame ${ms.toFixed(0)} ms\nleft: viewport · middle: viewport + ShadeNet (${model}) · right: EyeSight${extraLines}`;
}
main().catch((e) => { st.textContent = `ERROR ${e?.stack ?? e}`; });
