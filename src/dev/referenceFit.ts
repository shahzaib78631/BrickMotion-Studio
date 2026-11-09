import * as THREE from 'three';
import type { Studio } from '../render/studio';
import { DEFAULT_REFERENCE_LIGHTING, type ReferenceLightingOptions } from '../render/referenceLighting';
import { solveLighting, linearChannel, displayChannel, fitTone, toneAt } from './referenceFitMath';

type Calib = { studio: Studio; draw: (options?: unknown) => Promise<void> };
type View = { id: string; frame: HTMLIFrameElement; api: Calib; width: number; height: number; fullWidth: number; fullHeight: number;
  target: Uint8ClampedArray; mask: Uint8Array; samples: { offset: number; target: number[]; weight: number }[]; rt: THREE.WebGLRenderTarget };
const status = document.getElementById('status')!;
const output = document.getElementById('result')!;
const fitButton = document.getElementById('fit') as HTMLButtonElement;
const applyButton = document.getElementById('apply') as HTMLButtonElement;
const benchButton = document.getElementById('bench') as HTMLButtonElement;
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const views: View[] = [];
let best: ReferenceLightingOptions | null = null;
let lastReport: Record<string, unknown> = {};

async function load(id: string): Promise<View> {
  const frame = document.getElementById(id) as HTMLIFrameElement;
  let api: Calib | undefined;
  for (let tries = 0; tries < 1200; tries++) {
    const win = frame.contentWindow as unknown as { calib?: Calib } | null;
    const text = frame.contentDocument?.getElementById('st')?.textContent ?? '';
    if (win?.calib && /^(ok|calib scene)/.test(text)) { api = win.calib; break; }
    if (/Error|ERROR/.test(text)) throw new Error(`${id}: ${text}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!api) throw new Error(`Scene ${id} did not finish loading`);
  api.studio.renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
    throw new Error(`${id}: shader compilation failed\n${gl.getProgramInfoLog(program)}\n${gl.getShaderInfoLog(vertex)}\n${gl.getShaderInfoLog(fragment)}`);
  };
  const canvas = api.studio.renderer.domElement;
  const fullWidth = canvas.width, fullHeight = canvas.height;
  const width = Math.round(fullWidth / 3), height = Math.round(fullHeight / 3);
  const ref = frame.contentDocument!.getElementById('ref') as HTMLImageElement;
  await ref.decode();
  const temp = document.createElement('canvas'); temp.width = width; temp.height = height;
  const context = temp.getContext('2d')!; context.drawImage(ref, 0, 0, width, height);
  const target = context.getImageData(0, 0, width, height).data;
  const rt = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, colorSpace: THREE.NoColorSpace });
  api.studio.renderer.setPixelRatio(1); api.studio.setSize(width, height);
  api.studio.setReferenceLighting?.(null);
  await api.draw();
  const originalPixels = new Uint8Array(width * height * 4);
  const gl = api.studio.renderer.getContext();
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, originalPixels);
  const mask = maskOf(api.studio, rt, width, height);
  const samples: View['samples'] = [], classes = new Uint8Array(width * height);
  const counts = [0, 0, 0, 0];
  for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
    let interior = true;
    for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) if (!mask[(y + yy) * width + x + xx]) interior = false;
    if (!interior) continue;
    const p = (y * width + x) * 4, r = target[p], g = target[p + 1], b = target[p + 2];
    const group = Math.max(r, g, b) < 90 ? 0 : r > g * 1.6 && r > b * 1.6 ? 1 : r - b > 20 && g > 90 ? 2 : 3;
    classes[y * width + x] = group + 1; counts[group]++;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const group = classes[y * width + x] - 1;
    if (group < 0) continue;
    const p = (y * width + x) * 4;
    samples.push({ offset: ((height - 1 - y) * width + x) * 4,
      target: [linearChannel(target[p] / 255), linearChannel(target[p + 1] / 255), linearChannel(target[p + 2] / 255)],
      weight: 1 / Math.max(1, counts[group]) });
  }
  const view = { id, frame, api, width, height, fullWidth, fullHeight, target, mask, samples, rt };
  const baseline = new Float32Array(originalPixels.length);
  for (let i = 0; i < baseline.length; i++) baseline[i] = linearChannel(originalPixels[i] / 255);
  baselines.set(id, scorePixels(view, baseline));
  return view;
}

const baselines = new Map<string, ReturnType<typeof scorePixels>>();

function maskOf(studio: Studio, rt: THREE.WebGLRenderTarget, width: number, height: number): Uint8Array {
  const r = studio.renderer, scene = studio.scene;
  const hidden = scene.children.filter((o) => o !== studio.bricks.root && o.visible);
  const previous = { bg: scene.background, material: scene.overrideMaterial, rt: r.getRenderTarget(), color: r.getClearColor(new THREE.Color()), alpha: r.getClearAlpha(), shadow: r.shadowMap.enabled };
  const material = new THREE.MeshBasicMaterial({ color: 'white', side: THREE.DoubleSide });
  try {
    for (const object of hidden) object.visible = false;
    scene.background = null; scene.overrideMaterial = material;
    r.shadowMap.enabled = false; r.setRenderTarget(rt); r.setClearColor(0, 0); r.clear(); r.render(scene, studio.camera);
    const pixels = new Float32Array(width * height * 4); r.readRenderTargetPixels(rt, 0, 0, width, height, pixels);
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) mask[y * width + x] = pixels[((height - 1 - y) * width + x) * 4 + 3] > 0.99 ? 1 : 0;
    return mask;
  } finally {
    for (const object of hidden) object.visible = true;
    scene.background = previous.bg; scene.overrideMaterial = previous.material;
    r.shadowMap.enabled = previous.shadow; r.setRenderTarget(previous.rt); r.setClearColor(previous.color, previous.alpha); material.dispose();
  }
}

function linearFrame(view: View, options: ReferenceLightingOptions): Float32Array {
  const studio = view.api.studio, r = studio.renderer;
  studio.setRenderOptions?.({ edges: false, linearColors: true, ao: false });
  // Both AO and simulated bevel lighting must be disabled for a linear basis.
  const all = view.frame.contentWindow as unknown as { calib: { setup: { materials: import('../render/looks').Materials } } };
  studio.setMaterials?.({ ...all.calib.setup.materials, roundedEdges: false, ao: { enabled: false, strength: null, radius: null } });
  studio.setReferenceLighting?.(options);
  r.toneMapping = THREE.NoToneMapping;
  r.setRenderTarget(view.rt);
  studio.render();
  const pixels = new Float32Array(view.width * view.height * 4);
  r.readRenderTargetPixels(view.rt, 0, 0, view.width, view.height, pixels);
  r.setRenderTarget(null);
  return pixels;
}

function statistics(view: View, basis: Float32Array[]): { gram: number[][]; cross: number[]; constant: number; weight: number } {
  const n = basis.length, gram = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const cross = new Array<number>(n).fill(0); let constant = 0, weight = 0;
  for (const sample of view.samples) for (let c = 0; c < 3; c++) {
    const target = sample.target[c], w = sample.weight;
    constant += w * target * target; weight += w;
    for (let i = 0; i < n; i++) {
      const a = basis[i][sample.offset + c]; cross[i] += w * a * target;
      for (let j = 0; j < n; j++) gram[i][j] += w * a * basis[j][sample.offset + c];
    }
  }
  return { gram, cross, constant, weight };
}

async function fit() {
  fitButton.disabled = true;
  for (const view of views) view.api.studio.setSize(view.width, view.height);
  const started = performance.now(); let score = Infinity, tested = 0;
  const records: { options: ReferenceLightingOptions; loss: number }[] = [];
  // Coarse physical search followed by a local refinement. Every candidate solves
  // the five linear radiance coefficients jointly across both training scenes.
  const evaluate = async (roughness: number, clearcoat: number, coatRoughness: number, diameter: number, mold = 0, cameraRelative = true, specularVisibility = false, burleyDiffuse = true, darkRoughness = roughness, cameraTilt = false) => {
    const candidate: ReferenceLightingOptions = { ...DEFAULT_REFERENCE_LIGHTING, strengths: [0, 0, 0, 0], environment: 0,
      roughness, clearcoat, coatRoughness, diameter, mold, cameraRelative, specularVisibility, burleyDiffuse, darkRoughness, cameraTilt };
    const gram = Array.from({ length: 5 }, () => new Array<number>(5).fill(0)), cross = new Array<number>(5).fill(0);
    let constant = 0, weight = 0;
    for (const view of views.slice(0, 2)) {
      const basis: Float32Array[] = [];
      for (let i = 0; i < 5; i++) {
        const strengths: ReferenceLightingOptions['strengths'] = [0, 0, 0, 0]; if (i < 4) strengths[i] = 1;
        basis.push(linearFrame(view, { ...candidate, strengths, environment: i === 4 ? 1 : 0 }));
      }
      if (tested === 0) {
        const weights = [0.2, 0.3, 0.4, 0.5, 0.25];
        const actual = linearFrame(view, { ...candidate, strengths: weights.slice(0, 4) as ReferenceLightingOptions['strengths'], environment: weights[4] });
        let discrepancy = 0, count = 0;
        for (const sample of view.samples) for (let c = 0; c < 3; c++) {
          const predicted = basis.reduce((sum, image, i) => sum + image[sample.offset + c] * weights[i], 0);
          discrepancy += Math.abs(predicted - actual[sample.offset + c]); count++;
        }
        if (discrepancy / count > 0.003) throw new Error(`${view.id}: radiance basis is not linear (${discrepancy / count}); refusing an invalid fit`);
      }
      const s = statistics(view, basis); constant += s.constant; weight += s.weight;
      for (let i = 0; i < 5; i++) { cross[i] += s.cross[i]; for (let j = 0; j < 5; j++) gram[i][j] += s.gram[i][j]; }
    }
    const coefficients = solveLighting(gram, cross, [12, 12, 12, 12, 3]);
    let error = constant;
    for (let i = 0; i < 5; i++) {
      error -= 2 * coefficients[i] * cross[i];
      for (let j = 0; j < 5; j++) error += coefficients[i] * gram[i][j] * coefficients[j];
    }
    const loss = Math.sqrt(Math.max(0, error / weight));
    const options = { ...candidate, strengths: coefficients.slice(0, 4) as ReferenceLightingOptions['strengths'], environment: coefficients[4] };
    records.push({ options, loss }); tested++;
    if (loss < score) { score = loss; best = options; }
    status.textContent = `${tested} material candidates · best balanced linear RMSE ${score.toFixed(5)}\nroughness ${roughness.toFixed(2)}, coat ${clearcoat.toFixed(2)}, coat roughness ${coatRoughness.toFixed(2)}, diameter ${diameter.toFixed(2)}\n${((performance.now() - started) / 1000).toFixed(1)} s`;
    await pause();
  };
  try {
    for (const relative of [true, false]) for (const roughness of [0.12, 0.28, 0.45, 0.62]) for (const coat of [0, 0.25, 1]) await evaluate(roughness, coat, 0.08, 1, 0, relative);
    const center = best!;
    for (const roughness of [Math.max(0.06, center.roughness - 0.08), center.roughness + 0.08])
      for (const diameter of [0.65, 1.35]) await evaluate(roughness, center.clearcoat, 0.08, diameter, 0, center.cameraRelative);
    const smooth = best!;
    for (const mold of [0.0025, 0.01, 0.025]) await evaluate(smooth.roughness, smooth.clearcoat, smooth.coatRoughness, smooth.diameter, mold, smooth.cameraRelative);
    const glossy = best!;
    await evaluate(glossy.roughness, glossy.clearcoat, glossy.coatRoughness, glossy.diameter, glossy.mold, glossy.cameraRelative, true);
    const diffuse = best!;
    await evaluate(diffuse.roughness, diffuse.clearcoat, diffuse.coatRoughness, diffuse.diameter, diffuse.mold, diffuse.cameraRelative, diffuse.specularVisibility, false);
    const color = best!;
    for (const dark of [0.12, 0.28, 0.45, 0.7, 0.9]) await evaluate(color.roughness, color.clearcoat, color.coatRoughness, color.diameter, color.mold, color.cameraRelative, color.specularVisibility, color.burleyDiffuse, dark);
    const dark = best!;
    for (const roughness of [0.35, 0.45, 0.65, 0.8]) await evaluate(roughness, dark.clearcoat, dark.coatRoughness, dark.diameter, dark.mold, dark.cameraRelative, dark.specularVisibility, dark.burleyDiffuse, dark.darkRoughness);
    const tilt = best!;
    await evaluate(tilt.roughness, tilt.clearcoat, tilt.coatRoughness, tilt.diameter, tilt.mold, tilt.cameraRelative, tilt.specularVisibility, tilt.burleyDiffuse, tilt.darkRoughness, true);
    const toneObservations: { x: number; y: number; weight: number }[] = [];
    for (const view of views.slice(0, 2)) {
      const image = linearFrame(view, best!);
      for (const sample of view.samples) for (let c = 0; c < 3; c++) toneObservations.push({ x: image[sample.offset + c], y: sample.target[c], weight: sample.weight });
    }
    const toneCandidate = { ...best!, toneCurve: fitTone(toneObservations) };
    // Retain a shared curve only when it improves every fitted scene.
    if (views.slice(0, 2).every((view) => report(view, toneCandidate).balancedDisplayRMSE255 < report(view, best!).balancedDisplayRMSE255)) best = toneCandidate;
    const validation = [];
    for (const view of views) {
      const coarse = { ...report(view, best!), baseline: baselines.get(view.id) };
      validation.push({ ...coarse, fullResolution: await fullReport(view, best!) });
    }
    lastReport = { best, balancedLinearRMSE: score, seconds: (performance.now() - started) / 1000, validation, candidates: records };
    output.textContent = JSON.stringify(lastReport, null, 2);
    applyButton.disabled = false;
    benchButton.disabled = false;
    showBest();
    status.textContent += '\nFit complete. Third camera was excluded from optimization. Error is measured on eroded brick interiors, not the white background.';
  } finally { fitButton.disabled = false; }
}

function report(view: View, options: ReferenceLightingOptions) {
  const values = linearFrame(view, options);
  if (options.toneCurve) for (let i = 0; i < values.length; i++) if (i % 4 !== 3) values[i] = toneAt(values[i], options.toneCurve);
  return { scene: view.id, heldOut: view.id === 'held', ...scorePixels(view, values) };
}

async function fullReport(view: View, options: ReferenceLightingOptions) {
  const api = view.frame.contentWindow as unknown as { metrics: () => Promise<Record<string, unknown>>; calib: { setup: { materials: import('../render/looks').Materials } } };
  const studio = view.api.studio;
  studio.setSize(view.fullWidth, view.fullHeight);
  studio.setReferenceLighting?.(null);
  await view.api.draw();
  const baseline = await api.metrics();
  studio.setRenderOptions?.({ edges: false, linearColors: true, ao: false });
  studio.setMaterials?.({ ...api.calib.setup.materials, roundedEdges: false, ao: { enabled: false, strength: null, radius: null } });
  studio.setReferenceLighting?.(options); studio.render();
  const fitted = await api.metrics();
  return { width: view.fullWidth, height: view.fullHeight, baseline, fitted };
}
function scorePixels(view: View, values: Float32Array) {
  let linear = 0, display = 0, weight = 0;
  for (const sample of view.samples) for (let c = 0; c < 3; c++) {
    const predicted = values[sample.offset + c], target = sample.target[c], w = sample.weight;
    linear += w * (predicted - target) ** 2;
    display += w * (displayChannel(Math.min(1, predicted)) - displayChannel(target)) ** 2;
    weight += w;
  }
  return { balancedLinearRMSE: Math.sqrt(linear / weight), balancedDisplayRMSE255: 255 * Math.sqrt(display / weight), samples: view.samples.length };
}

function showBest() {
  if (!best) return;
  for (const view of views) {
    const studio = view.api.studio;
    studio.setSize(view.fullWidth, view.fullHeight);
    studio.setReferenceLighting?.(best); studio.render();
    view.frame.contentDocument!.getElementById('st')!.textContent = `${view.id}: fitted area lighting (AO off)`;
  }
}

async function benchmark() {
  if (!best) throw new Error('Fit lighting first');
  benchButton.disabled = true; fitButton.disabled = true;
  const view = views[0], studio = view.api.studio, renderer = studio.renderer, camera = studio.perspective;
  const gl = renderer.getContext();
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  const hardware = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unavailable';
  const initial = camera.position.clone(), rotation = camera.quaternion.clone();
  const target = (view.frame.contentWindow as unknown as { calib: { shot: { target: THREE.Vector3 } } }).calib.shot.target;
  const rows: { width: number; height: number; motion: string; mode: string; ms: number; batches: number[] }[] = [];
  try {
    for (const [width, height] of [[540, 960], [1080, 1920]]) for (const motion of ['static', 'orbit']) {
      const samples = { base: [] as number[], reference: [] as number[] };
      for (let batch = 0; batch < 5; batch++) for (const mode of (batch % 2 ? ['reference', 'base'] : ['base', 'reference'])) {
        camera.position.copy(initial); camera.quaternion.copy(rotation);
        studio.setReferenceLighting?.(null); await view.api.draw();
        studio.setSize(width, height);
        if (mode === 'reference') {
          const setup = (view.frame.contentWindow as unknown as { calib: { setup: { materials: import('../render/looks').Materials } } }).calib.setup;
          studio.setRenderOptions?.({ edges: false, linearColors: true, ao: false });
          studio.setMaterials?.({ ...setup.materials, roundedEdges: false, ao: { enabled: false, strength: null, radius: null } });
          studio.setReferenceLighting?.(best);
        }
        for (let i = 0; i < 3; i++) studio.render();
        gl.finish(); await pause();
        const started = performance.now(), frames = 8;
        for (let i = 0; i < frames; i++) {
          if (motion === 'orbit') {
            camera.position.copy(initial).sub(target).applyAxisAngle(new THREE.Vector3(0, 1, 0), (i + 1) * 0.01).add(target);
            camera.lookAt(target);
          }
          studio.render();
        }
        gl.finish();
        const readback = new Uint8Array(4);
        gl.readPixels(Math.floor(width / 2), Math.floor(height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, readback);
        if (renderer.info.render.triangles === 0 || gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height || gl.getError() !== gl.NO_ERROR) throw new Error(`Invalid benchmark frame: ${width}×${height}`);
        samples[mode as 'base' | 'reference'].push((performance.now() - started) / frames);
        status.textContent = `Measuring ${width}×${height} · ${motion} · ${mode} · batch ${batch + 1}/5`;
        await pause();
      }
      for (const mode of ['base', 'reference'] as const) {
        const values = [...samples[mode]].sort((a, b) => a - b);
        rows.push({ width, height, motion, mode, ms: values[2], batches: samples[mode] });
      }
    }
    lastReport.timings = { hardware, method: 'Median of five alternating eight-frame batches with GPU completion sync; includes renderer CPU work, excludes browser presentation/UI', rows };
    output.textContent = JSON.stringify(lastReport, null, 2);
    status.textContent = 'Measured static and moving-camera rendering at both resolutions. Report includes every batch.';
  } finally {
    camera.position.copy(initial); camera.quaternion.copy(rotation);
    showBest(); benchButton.disabled = false; fitButton.disabled = false;
  }
}

async function main() {
  // Avoid competing shader compilation and four shadow-map builds on one GPU.
  for (const id of ['hero', 'calib', 'held']) views.push(await load(id));
  fitButton.disabled = false;
  fitButton.onclick = () => { void fit().catch((error) => { status.textContent = String(error instanceof Error ? error.stack : error); }); };
  applyButton.onclick = showBest;
  benchButton.onclick = () => { void benchmark().catch((error) => { status.textContent = String(error); }); };
  status.textContent = 'Ready: 2 scenes for fitting, 1 held-out camera. All lighting is analytic; no neural inference.';
  const query = new URLSearchParams(location.search);
  if (query.has('auto')) await fit();
  if (query.has('bench')) await benchmark();
}
main().catch((error) => { status.textContent = String(error instanceof Error ? error.stack : error); });
