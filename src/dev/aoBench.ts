/** Dev-only comparison harness. Models stay local; no persistence or project writes. */
import * as THREE from 'three';
import { importLDraw } from '../io/ldrawImport';
import { readStudioIo } from '../io/studioIo';
import { assemble } from '../model/assemble';
import { ensureParts, getColors, initPartService, metricsOf, registerInlineParts } from '../state/partService';
import { createStudio } from '../render/studio';
import { DEFAULT_MATERIALS } from '../render/looks';
import { CALIB_PIECES } from './calibScene';
import type { Plan } from '../plan/types';

const status = document.getElementById('status')!;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const qs = new URLSearchParams(location.search);
const width = Number(qs.get('w') ?? 960), height = Number(qs.get('h') ?? 600);
const telemetry = { ready: false, error: '', name: '', parts: 0, results: [] as unknown[], shaderErrors: [] as string[], gpu: '' };
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
let studio: ReturnType<typeof createStudio>;
let materials = { ...DEFAULT_MATERIALS, environment: 'room' as const, roundedEdges: false };
let center = new THREE.Vector3();
let distance = 20;
let instances: ReturnType<typeof assemble>['instances'] = [];
let busy = false;
const errors: string[] = telemetry.shaderErrors;
function pose(angle = 0.65) {
  studio.camera.position.copy(center).add(new THREE.Vector3(Math.sin(angle) * distance, distance * 0.65, Math.cos(angle) * distance));
  studio.camera.lookAt(center); studio.camera.updateMatrixWorld();
}
function method(algorithm: 'gtao' | 'cortao', enabled = true) {
  studio.setMaterials?.({ ...materials, ao: { algorithm, enabled, strength: 1, radius: 0.8 } });
}
async function load(plan: Plan) {
  status.textContent = 'Loading parts…';
  registerInlineParts(plan.parts);
  const ids = new Set<string>();
  for (const step of [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap(m => m.steps)])
    for (const item of step.pieces) if ('part' in item) ids.add(item.part);
  await ensureParts([...ids]);
  const asm = assemble(plan, metricsOf, getColors());
  instances = asm.instances;
  studio.bricks.setInstances(instances);
  const b = asm.bounds!;
  const box = new THREE.Box3(new THREE.Vector3(b.min[0] / 20, -b.max[1] / 20, -b.max[2] / 20),
    new THREE.Vector3(b.max[0] / 20, -b.min[1] / 20, -b.min[2] / 20));
  studio.fitTo(box, box.min.y);
  center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  distance = size.length() * 1.65;
  studio.setOrthoHeight(size.length() * 1.2);
  pose(); method('gtao'); await studio.ready?.(); studio.render();
  telemetry.name = plan.name; telemetry.parts = instances.length;
  status.textContent = `${plan.name} · ${instances.length} parts · ${width}×${height}`;
}
const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null;
async function measure(update: (frame: number) => void, count = 16) {
  const gl = studio.renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const cpu: number[] = [], gpu: number[] = [];
  let disjoint = false;
  // Warm shaders and textures outside the measured region.
  for (let frame = 0; frame < 5; frame++) { update(frame); studio.render(); await nextFrame(); }
  for (let frame = 0; frame < count; frame++) {
    await nextFrame(); update(frame);
    const query = ext ? gl.createQuery() : null;
    if (query) gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    const start = performance.now(); studio.render(); cpu.push(performance.now() - start);
    if (query) {
      gl.endQuery(ext.TIME_ELAPSED_EXT); gl.flush();
      for (let wait = 0; wait < 120 && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE); wait++) await nextFrame();
      const invalid = gl.getParameter(ext.GPU_DISJOINT_EXT);
      disjoint ||= invalid;
      if (!invalid && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(query);
    }
  }
  if (errors.length) throw Error(`Shader compilation failed: ${errors.join('\n')}`);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) throw Error(`WebGL error: ${error}`);
  return { width: canvas.width, height: canvas.height, cpuSubmissionMedianMs: median(cpu), gpuFrameMedianMs: median(gpu), gpuSamples: gpu.length, disjoint, timerSupported: !!ext };
}
async function compare(motion: 'static' | 'orbit' | 'parts' = 'static') {
  if (busy || !telemetry.ready) return;
  busy = true;
  try {
    document.getElementById('shots')!.replaceChildren();
    telemetry.results = [];
    for (const algorithm of ['off', 'gtao', 'cortao'] as const) {
      status.textContent = `Measuring ${algorithm} (${motion})…`;
      method(algorithm === 'off' ? 'gtao' : algorithm, algorithm !== 'off');
      const update = (frame: number) => {
        pose(motion === 'orbit' ? 0.65 + frame * 0.02 : 0.65);
        if (motion === 'parts') {
          const delta = new THREE.Matrix4().makeTranslation(0, -Math.sin(frame * 0.2) * 40, 0);
          const poses = new Map(instances.map((i, index) => [i.key, index % 10 === 0 ? delta.clone().multiply(i.world) : i.world]));
          studio.bricks.setMatrices(key => poses.get(key) ?? null);
        }
      };
      const result = { algorithm, motion, projection: studio.projection, ...await measure(update) };
      telemetry.results.push(result);
      if (motion === 'parts') studio.bricks.resetMatrices();
      pose(); studio.render();
      const figure = document.createElement('figure'), img = new Image(), caption = document.createElement('figcaption');
      img.src = canvas.toDataURL(); img.alt = `${algorithm} ${telemetry.name}`;
      caption.textContent = `${algorithm}: ${result.gpuFrameMedianMs?.toFixed(2) ?? 'unavailable'} ms GPU / ${result.cpuSubmissionMedianMs?.toFixed(2)} ms CPU submission`;
      figure.append(caption, img); document.getElementById('shots')!.append(figure);
    }
    document.getElementById('results')!.textContent = JSON.stringify(telemetry, null, 2);
    status.textContent = `${telemetry.name} · comparison complete`;
  } catch (error) {
    telemetry.error = String(error); status.textContent = telemetry.error; throw error;
  } finally { busy = false; }
  return telemetry;
}
Object.assign(window, { __aoBench: telemetry, aoBench: { compare, get studio() { return studio; }, pose, measure } });
document.getElementById('compare')!.onclick = () => { void compare(); };
document.getElementById('orbit')!.onclick = () => { void compare('orbit'); };
document.getElementById('moving')!.onclick = () => { void compare('parts'); };
document.getElementById('projection')!.onchange = e => {
  studio.setProjection((e.target as HTMLSelectElement).value === 'ortho' ? 'ortho' : 'perspective'); pose(); studio.render();
};
(document.getElementById('file') as HTMLInputElement).onchange = async e => {
  const file = (e.target as HTMLInputElement).files?.[0]; if (!file || busy) return;
  await load(importLDraw(file.name.endsWith('.io') ? await readStudioIo(await file.arrayBuffer()) : await file.text(), file.name));
};
async function main() {
  await initPartService();
  studio = createStudio(canvas, { preserveDrawingBuffer: true });
  studio.renderer.setPixelRatio(1); studio.setSize(width, height);
  const gl = studio.renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  telemetry.gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  studio.setLook?.('lavender');
  studio.setRenderOptions?.({ edges: false, linearColors: true });
  studio.renderer.debug.onShaderError = (gl, _program, vertex, fragment) => {
    const message = `${gl.getShaderInfoLog(vertex)}\n${gl.getShaderInfoLog(fragment)}`;
    errors.push(message); console.error(message);
  };

  const url = qs.get('model');
  if (url) {
    const res = await fetch(url); if (!res.ok) throw Error(`Model fetch failed: ${res.status}`);
    const text = url.endsWith('.io') ? await readStudioIo(await res.arrayBuffer()) : await res.text();
    await load(importLDraw(text, url.split('/').pop()!));
  } else {
    await load({ format: 'brickmotion-plan', version: 1, name: 'Calibration bricks', steps: [{ pieces: CALIB_PIECES.map(p => ({
      part: p.part, color: p.color, ldu: [p.x, p.y, p.z], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    })) }] });
  }
  telemetry.ready = true;
}
main().catch(error => { telemetry.error = String(error); status.textContent = telemetry.error; console.error(error); });
