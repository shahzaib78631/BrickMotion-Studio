import * as THREE from 'three';
import { WebGPURenderer, RectAreaLightNode } from 'three/webgpu';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { WebGPUPathTracer, OIDNDenoiser, RANDOM_BLUE_DITHER } from 'three-gpu-pathtracer/webgpu';
import { initUNetFromURL } from 'oidn-webgpu';
import { cyclesPrincipledDiffuse } from '../dev/cyclesDiffuse';
import { ShadowGround } from '../dev/shadowGround';
import { pathTraceColor, diskRadiance, EYESIGHT_BUILD_STRENGTHS } from '../dev/eyesightScene';
import { BUILD_FL_DIRECTIONS } from './referenceLighting';
import type { Studio } from './studio';
import type { Palette } from './looks';
import type { ColorDef } from '../ldraw/colors';
import { getColors } from '../state/partService';
import { PreviewRadianceCache } from './previewRadianceCache';

/** The reviewed preview preset. Both interactive display and MP4 use this transport. */
export const STUDIO_PATH_PROFILE = Object.freeze({ gain: 0.8, diameter: 0.8, roughness: 0.35, clearcoat: 0, albedo: 0.6, samples: 64 });
type Link = { source: THREE.InstancedMesh; index: number; mesh: THREE.Mesh };
const cancelled = () => new DOMException('Rendering was cancelled.', 'AbortError');

export class StudioPathRenderer {
  readonly renderer: WebGPURenderer;
  readonly scene = new THREE.Scene();
  private model = new THREE.Group();
  private floor = new THREE.Mesh(new THREE.PlaneGeometry(10000, 10000), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }));
  private tracer: WebGPUPathTracer | null = null;
  private denoiser: OIDNDenoiser | null = null;
  private ground: ShadowGround | null = null;
  private links: Link[] = [];
  private resources: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  private structure = -1;
  private materialVersion = -1;
  private camera: THREE.Camera | null = null;
  private cameraState: number[] = [];
  private palette: Palette;
  private size: [number, number];
  private disposed = false;
  private failure: Error | null = null;
  private lights: THREE.RectAreaLight[] = [];
  private samples = 64;
  private counts = { min: 0, avg: 0 };
  private queryPending = false;
  private tick = 0;
  private epoch = 0;
  private groundY = NaN;
  private floorColor: string | null = null;
  private rigForward: THREE.Vector3 | null = null;
  private modelBounds = new THREE.Box3();
  private hybridRequested = false;
  private hybrid: PreviewRadianceCache | null = null;
  private hybridAttempted = false;
  private hybridError = '';
  private cameraChangedAt = -Infinity;
  private interactive: boolean;

  private constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas, private studio: Studio, options: { width: number; height: number; palette: Palette; interactive: boolean; samples: number }) {
    this.palette = options.palette; this.samples = options.samples;
    this.interactive = options.interactive;
    this.size = [options.width, options.height];
    this.renderer = new WebGPURenderer({ canvas });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(...this.size, false);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.floor.rotation.x = -Math.PI / 2;
    this.scene.add(this.model, this.floor);
  }

  static async create(canvas: HTMLCanvasElement | OffscreenCanvas, studio: Studio, options: { width: number; height: number; palette: Palette; interactive: boolean; samples: number }): Promise<StudioPathRenderer> {
    if (!navigator.gpu) throw new Error('Studio path rendering needs a browser with WebGPU.');
    const result = new StudioPathRenderer(canvas, studio, options);
    try {
      await result.renderer.init();
      RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
      const base = import.meta.env.BASE_URL;
      const backdrop = await new HDRLoader().loadAsync(`${base}hdri/studio_backdrop.hdr`);
      backdrop.mapping = THREE.EquirectangularReflectionMapping;
      result.resources.push(backdrop);
      result.scene.background = backdrop;
      result.scene.environmentIntensity = 0;
      result.tracer = new WebGPUPathTracer(result.renderer);
      const material = result.tracer.getMaterial(); material.diffuseBrdf = cyclesPrincipledDiffuse;
      result.tracer.setMaterial(material); result.tracer.setRandom(RANDOM_BLUE_DITHER);
      result.tracer.maxBounces = 8; result.tracer.filterGlossyFactor = 1;
      result.tracer.maxSamples = options.samples;
      result.tracer.dynamicLowRes = options.interactive; result.tracer.lowResScale = 0.25;
      result.tracer.renderDelay = options.interactive ? 300 : 0;
      result.tracer.fadeDuration = options.interactive ? 400 : 0; result.tracer.minSamples = 1;
      result.denoiser = new OIDNDenoiser({ initUNetFromURL, auxWeightsUrl: `${base}weights/rt_hdr_alb_nrm.tza`, colorWeightsUrl: `${base}weights/rt_hdr.tza`, useAuxiliaryBuffers: false });
      result.tracer.setDenoiser(result.denoiser);
      result.sync();
      return result;
    } catch (error) { result.dispose(); throw error; }
  }

  private rebuild(): void {
    this.dropHybrid();
    this.ground?.dispose(); this.ground = null;
    for (const item of this.resources.splice(1)) item.dispose();
    this.model.clear(); this.links = [];
    const geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
    const materials = new Map<string, THREE.Material>();
    const copyMaterial = (source: THREE.Material, inherited: number): THREE.Material => {
      const key = `${source.uuid}:${inherited}`;
      let value = materials.get(key);
      if (value) return value;
      // Never copy viewport shader hooks, textures or selection tint into transport.
      const original = source as THREE.MeshPhysicalMaterial;
      const definition = source.userData.bmColor as ColorDef | undefined;
      const def = definition?.code === 16 ? getColors().get(inherited) ?? definition : definition;
      const solid = !def || def.finish === 'solid';
      const glass = def?.finish === 'trans';
      const color = glass ? original.color.clone() : def ? pathTraceColor(def, this.palette === 'studio' ? 'studio' : 'ldraw') : original.color?.clone() ?? new THREE.Color(0xcccccc);
      if (!glass) color.multiplyScalar(STUDIO_PATH_PROFILE.albedo);
      value = new THREE.MeshPhysicalMaterial({ color, roughness: solid ? STUDIO_PATH_PROFILE.roughness : original.roughness, clearcoat: 0, ior: glass ? original.ior : 1.45, metalness: original.metalness ?? 0, transparent: original.transparent, opacity: original.opacity, transmission: original.transmission ?? 0, thickness: original.thickness ?? 0, attenuationColor: original.attenuationColor, attenuationDistance: original.attenuationDistance, side: original.side, emissive: original.emissive, emissiveIntensity: original.emissiveIntensity ?? 1 });
      materials.set(key, value); this.resources.push(value); return value;
    };
    this.studio.bricks.root.updateMatrixWorld(true);
    this.studio.bricks.root.traverse((object) => {
      if (!(object as THREE.InstancedMesh).isInstancedMesh) return;
      const source = object as THREE.InstancedMesh;
      let geometry = geometries.get(source.geometry);
      if (!geometry) { geometry = source.geometry.clone(); geometries.set(source.geometry, geometry); this.resources.push(geometry); }
      const inherited = source.userData.brickColor as number;
      const material = Array.isArray(source.material) ? source.material.map((material) => copyMaterial(material, inherited)) : copyMaterial(source.material, inherited);
      for (let index = 0; index < source.count; index++) {
        const mesh = new THREE.Mesh(geometry, material); mesh.matrixAutoUpdate = false;
        this.model.add(mesh); this.links.push({ source, index, mesh });
      }
    });
    this.syncPose();
    const box = new THREE.Box3().setFromObject(this.studio.bricks.root);
    if (box.isEmpty()) box.set(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 8, 4));
    this.modelBounds.copy(box);
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    this.scene.remove(...this.lights);
    const forward = this.rigForward?.clone() ?? this.studio.camera.getWorldDirection(new THREE.Vector3()); forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1); forward.normalize();
    this.rigForward ??= forward.clone();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const distance = radius * 1000, diameter = STUDIO_PATH_PROFILE.diameter;
    this.lights = BUILD_FL_DIRECTIONS.map(([x, y, z], index) => {
      const light = new THREE.RectAreaLight(0xffffff, diskRadiance(EYESIGHT_BUILD_STRENGTHS[index] * STUDIO_PATH_PROFILE.gain, diameter), 2 * distance * Math.tan(diameter / 2), 2 * distance * Math.tan(diameter / 2));
      Object.assign(light, { isCircular: true });
      light.position.copy(center).addScaledVector(right.clone().multiplyScalar(x).addScaledVector(forward, y).add(new THREE.Vector3(0, z, 0)).normalize(), distance);
      light.lookAt(center); this.scene.add(light); return light;
    });
    this.floorColor = this.studio.floorColorOverride ?? null;
    this.floor.material.color.set(this.floorColor ?? '#ffffff');
    this.floor.position.y = this.studio.groundY;
    this.groundY = this.studio.groundY;
    this.camera = this.studio.camera;
    this.tracer!.setScene(this.scene, this.camera);
    this.ground = new ShadowGround(this.renderer, this.scene, this.model, this.floor, this.lights, this.camera, ...this.size, this.tracer!.getMaterial(), box);
    this.structure = this.studio.bricks.structureVersion;
    this.materialVersion = this.studio.materialVersion ?? 0;
    this.cameraState = []; this.restartCounts();
  }

  private restartCounts(): void { this.epoch++; this.counts = { min: 0, avg: 0 }; }
  private syncPose(): boolean {
    let changed = false;
    const local = new THREE.Matrix4(), world = new THREE.Matrix4();
    this.studio.bricks.root.updateMatrixWorld(true);
    for (const { source, index, mesh } of this.links) {
      source.getMatrixAt(index, local);
      if (Math.abs(local.determinant()) < 1e-15) world.makeScale(1e-8, 1e-8, 1e-8).setPosition(0, -100000, 0);
      else world.multiplyMatrices(source.matrixWorld, local);
      if (!mesh.matrix.equals(world)) { mesh.matrix.copy(world); changed = true; }
    }
    return changed;
  }

  private sync(): void {
    if (this.materialVersion !== (this.studio.materialVersion ?? 0) || this.structure !== this.studio.bricks.structureVersion || this.floorColor !== (this.studio.floorColorOverride ?? null)) this.rebuild();
    if (this.syncPose()) { this.dropHybrid(); this.tracer!.updateTransforms(); this.ground?.invalidateModel(); this.restartCounts(); }
    const camera = this.studio.camera; camera.updateMatrixWorld();
    const state = [...camera.matrixWorld.elements, ...camera.projectionMatrix.elements];
    if (camera !== this.camera) {
      // The floor cache owns the camera object too (perspective ↔ orthographic).
      this.rebuild();
    }
    if (state.some((value, index) => Math.abs(value - (this.cameraState[index] ?? Infinity)) > 1e-8)) {
      this.cameraChangedAt = performance.now();
      this.cameraState = state; this.tracer!.updateCamera(); this.ground?.invalidate(); this.restartCounts();
    }
    if (this.groundY !== this.studio.groundY) {
      this.dropHybrid();
      this.groundY = this.studio.groundY; this.floor.position.y = this.groundY;
      this.tracer!.updateTransforms(); this.ground?.invalidate(); this.restartCounts();
    }
  }

  setSize(width: number, height: number): void {
    if (this.size[0] === width && this.size[1] === height) return;
    this.size = [width, height]; this.renderer.setSize(width, height, false);
    this.tracer!.setSize(width, height); this.structure = -1;
  }
  setPalette(palette: Palette): void { if (this.palette !== palette) { this.palette = palette; this.structure = -1; } }
  private dropHybrid(): void {
    this.hybrid?.dispose(); this.hybrid = null; this.hybridAttempted = false; this.hybridError = '';
    if (this.tracer) this.tracer.renderDelay = this.interactive ? 300 : 0;
  }
  setHybrid(enabled: boolean): void {
    if (enabled === this.hybridRequested) return;
    const wasActive = this.hybrid?.active;
    this.hybridRequested = enabled;
    if (!enabled) this.dropHybrid();
    if (wasActive) { this.tracer!.reset(); this.restartCounts(); }
  }
  get hybridStats() { return { ready: this.hybrid?.ready ?? false, active: this.hybrid?.active ?? false, points: this.hybrid?.points.count ?? 0, bakeMs: this.hybrid?.elapsedMs ?? 0, error: this.hybridError || this.hybrid?.error?.message || null }; }
  get status(): string {
    const name = this.hybridRequested ? 'Studio hybrid' : 'Studio path';
    if (this.hybrid?.active) return `${name} · cached diffuse + live glossy preview`;
    const state = this.tracer?.lowResMode ? 'moving preview' : `${Math.floor(this.counts.min)}/${this.samples} samples${this.denoiser?.complete && this.ground?.ready ? ' · ready' : ' · refining'}`;
    return `${name} · ${state}${this.hybridRequested ? ` · ${this.hybrid?.status ?? (this.hybridError || 'cache waits for settled image')}` : ''}`;
  }

  renderSample(review?: { cachedPreview: boolean }): void {
    if (this.disposed || !this.tracer) return;
    if (this.failure) throw this.failure;
    this.sync();
    if (this.hybridRequested && !this.hybridAttempted && this.counts.min >= this.samples && this.denoiser?.complete && this.ground?.ready && performance.now() - this.cameraChangedAt > 500) {
      this.hybridAttempted = true;
      try { this.hybrid = new PreviewRadianceCache(this.renderer, this.tracer, this.scene, this.model, this.modelBounds); }
      catch (error) { this.hybridError = `cache unavailable: ${String(error)}`; }
    }
    if (this.hybrid && performance.now() - this.cameraChangedAt > 500) {
      try { this.hybrid.update(); }
      catch (error) { this.dropHybrid(); this.hybridAttempted = true; this.hybridError = `cache unavailable: ${String(error)}`; }
    }
    const active = review?.cachedPreview ?? (this.hybridRequested && performance.now() - this.cameraChangedAt < 300);
    if (this.hybrid?.setActive(active)) {
      this.tracer.renderDelay = active ? 300 : 0;
      this.tracer.reset(); this.restartCounts();
    }
    if (review) this.tracer.renderDelay = 0;
    if (!this.tracer.lowResMode) this.ground?.update();
    this.tracer.renderSample();
    const image = (this.denoiser?.complete ? this.denoiser.texture : null) ?? this.tracer.target;
    if (image && !this.tracer.lowResMode) this.ground?.render(image as THREE.Texture);
    if (++this.tick % 8 === 0 && !this.queryPending) {
      this.queryPending = true; const epoch = this.epoch;
      void this.tracer.getSampleCountsAsync().then((counts) => { if (epoch === this.epoch) this.counts = counts; }).catch((error) => {
        if (!this.disposed) this.failure = new Error(`Studio path GPU query failed: ${String(error)}`);
      }).finally(() => { this.queryPending = false; });
    }
  }

  /** Wait for this pose's full samples, denoise and floor cache; never encode a moving preview. */
  async renderFrame(signal: AbortSignal, progress?: (done: number, total: number) => void): Promise<void> {
    const started = performance.now();
    while (true) {
      if (signal.aborted) throw cancelled();
      if (this.disposed) throw new Error('Studio path renderer has been disposed.');
      this.renderSample();
      progress?.(Math.min(this.counts.min, this.samples), this.samples);
      if (this.counts.min >= this.samples && this.denoiser?.complete && this.ground?.ready) return;
      if (performance.now() - started > 300000) throw new Error('Studio path frame did not finish within five minutes. Try a smaller export size.');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  /** Developer review only: same camera/resolution/sample budget, GPU-completed
   * batches in alternating order. The normal viewport never performs readbacks. */
  async reviewHybrid(signal: AbortSignal) {
    if (!this.hybrid?.ready || !this.tracer) throw new Error('Wait for the lighting cache to finish');
    const tracer = this.tracer;
    const saved = { maxSamples: tracer.maxSamples, lowRes: tracer.dynamicLowRes, delay: tracer.renderDelay, stable: tracer.stableNoise };
    const rows: { cached: boolean; ms: number }[] = [];
    const snapshots: { full?: ImageData; cached?: ImageData } = {};
    const copy = document.createElement('canvas'); copy.width = this.canvas.width; copy.height = this.canvas.height;
    const context = copy.getContext('2d')!;
    try {
      tracer.setDenoiser(null); tracer.dynamicLowRes = false; tracer.renderDelay = 0; tracer.maxSamples = 16; tracer.stableNoise = true;
      // First pair warms the additional shader/bindings and is excluded.
      for (const [index, cached] of [false, true, false, true, true, false, false, true, true, false].entries()) {
        tracer.reset(); this.restartCounts(); const start = performance.now();
        while (true) {
          if (signal.aborted) throw cancelled();
          this.renderSample({ cachedPreview: cached });
          if (this.counts.min >= 16) break;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        if (index >= 2) rows.push({ cached, ms: performance.now() - start });
        context.drawImage(this.canvas as CanvasImageSource, 0, 0);
        snapshots[cached ? 'cached' : 'full'] = context.getImageData(0, 0, copy.width, copy.height);
      }
      const median = (cached: boolean) => { const group = rows.filter((row) => row.cached === cached).map((row) => row.ms).sort((a,b) => a-b); return (group[1]+group[2])/2; };
      return { report: { width: copy.width, height: copy.height, samples: 16, statistic: 'median of four GPU-completed batches per mode; first pair excluded', fullMs: median(false), cachedMs: median(true), speedup: median(false) / median(true), cache: this.hybridStats, rows }, snapshots };
    } finally {
      this.hybrid?.setActive(false);
      tracer.maxSamples = saved.maxSamples; tracer.dynamicLowRes = saved.lowRes; tracer.renderDelay = saved.delay; tracer.stableNoise = saved.stable;
      tracer.setDenoiser(this.denoiser); tracer.reset(); this.restartCounts();
    }
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    this.dropHybrid(); this.ground?.dispose(); this.tracer?.dispose();
    this.floor.geometry.dispose(); this.floor.material.dispose();
    for (const resource of this.resources) resource.dispose();
    this.renderer.dispose();
  }
}
