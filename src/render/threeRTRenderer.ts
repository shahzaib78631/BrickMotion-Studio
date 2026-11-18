import * as THREE from 'three';
import type { Studio } from './studio';
import type { Palette } from './looks';
import { BUILD_FL_DIRECTIONS } from './referenceLighting';
import { acquireThreeRT, type ThreeRTEngine } from './threert/engine';
import { describeMaterial, instanceWorldMatrices, shown, uploadGeometry } from './threert/scene';

type Link = { source: THREE.InstancedMesh; id: number; matrices: Float32Array };
type Options = { width: number; height: number; palette: Palette };
const CAMERA = 1;

/** Genuine ThreeRT Rust/wgpu browser backend; opt-in, with its upstream material/post model. */
export class ThreeRTRenderer {
  private links: Link[] = [];
  private structure = -1;
  private materials = -1;
  private pose = -1;
  private cameraState = '';
  private palette: Palette;
  private size: [number, number];
  private generation = 0;
  private disposed = false;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure: unknown;
  private frame = 0;
  private gpuMs = 0;
  private scale = 1;
  private groundY = NaN;
  private floorColor: string | null = null;
  private _ready = false;
  get ready(): boolean { return this._ready; }
  get frameCount(): number { return this.frame; }
  get status(): string {
    return `ThreeRT · WebGPU software ray tracing · ${this.frame} frames · ${Math.round(this.scale * 100)}%${this.gpuMs ? ` · ${this.gpuMs.toFixed(1)} ms GPU` : ''} · experimental glass`;
  }

  private constructor(readonly canvas: HTMLCanvasElement, private studio: Studio, private engine: ThreeRTEngine, private release: () => void, options: Options) {
    this.palette = options.palette;
    this.size = [options.width, options.height];
  }

  static async create(canvas: HTMLCanvasElement, studio: Studio, options: Options): Promise<ThreeRTRenderer> {
    if (!navigator.gpu) throw new Error('ThreeRT needs a browser with WebGPU.');
    const lease = await acquireThreeRT();
    const result = new ThreeRTRenderer(canvas, studio, lease.engine, lease.release, options);
    try {
      result.pending = result.open();
      await result.pending;
      result.pending = null;
      return result;
    } catch (error) { result.pending = null; result.dispose(); throw error; }
  }

  private async open(): Promise<void> {
    this._ready = false;
    this.engine.resetEngine();
    this.links = []; this.cameraState = ''; this.pose = -1; this.frame = 0;
    const [width, height] = this.size;
    this.canvas.width = width; this.canvas.height = height;
    const engine = this.engine;
    let id = 10;
    const geometries = new Map<THREE.BufferGeometry, number>();
    const materials = new Map<THREE.Material, number>();
    const material = (source: THREE.Material) => {
      let handle = materials.get(source);
      if (handle !== undefined) return handle;
      handle = id++; materials.set(source, handle);
      const descriptor = describeMaterial(source);
      const physical = source as THREE.MeshPhysicalMaterial;
      if (physical.transmission > 0 && physical.attenuationColor) descriptor.color = physical.attenuationColor.toArray();
      engine.material(handle, JSON.stringify(descriptor));
      return handle;
    };
    this.studio.bricks.root.updateMatrixWorld(true);
    this.studio.bricks.root.traverse(object => {
      if (!(object as THREE.InstancedMesh).isInstancedMesh) return;
      const source = object as THREE.InstancedMesh;
      let geometry = geometries.get(source.geometry);
      if (geometry === undefined) { geometry = id++; uploadGeometry(engine, geometry, source.geometry); geometries.set(source.geometry, geometry); }
      const materialIds = (Array.isArray(source.material) ? source.material : [source.material]).map(material);
      const objectId = id++;
      engine.object(objectId, JSON.stringify({ kind: 'instanced', name: source.uuid, geometry, materials: materialIds, count: source.count, castShadow: true }));
      const matrices = instanceWorldMatrices(source);
      engine.instances(objectId, source.count, matrices);
      engine.visible(objectId, shown(source));
      this.links.push({ source, id: objectId, matrices });
    });
    // A neutral studio rig. ThreeRT's UE filmic post differs from the existing studio renderer.
    const forward = this.studio.camera.getWorldDirection(new THREE.Vector3()); forward.y = 0;
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    for (const [index, [x, y, z]] of BUILD_FL_DIRECTIONS.entries()) {
      const direction = right.clone().multiplyScalar(x).addScaledVector(forward, y).add(new THREE.Vector3(0, z, 0)).normalize();
      const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
      const light = id++;
      engine.object(light, JSON.stringify({ kind: 'light', name: `Studio ${index}`, light: { type: 'directional', color: [1, 1, 1], intensity: index ? 0.8 : 2.4, angularDiameter: 45.84, castShadow: true } }));
      engine.transform(light, new Float32Array([0, 0, 0, ...quaternion.toArray(), 1, 1, 1]));
    }
    const floor = new THREE.PlaneGeometry(10000, 10000); floor.rotateX(-Math.PI / 2);
    floor.translate(0, this.studio.groundY, 0);
    const floorGeometry = id++, floorMaterial = id++, floorObject = id++;
    try { uploadGeometry(engine, floorGeometry, floor); } finally { floor.dispose(); }
    engine.material(floorMaterial, JSON.stringify({ name: 'Floor', color: new THREE.Color(this.studio.floorColorOverride ?? '#ffffff').toArray(), roughness: 0.95, metalness: 0, opacity: 1, doubleSided: true, emissive: [0, 0, 0], emissiveIntensity: 0 }));
    engine.object(floorObject, JSON.stringify({ kind: 'mesh', name: 'Floor', geometry: floorGeometry, material: floorMaterial }));
    this.syncCamera(true);
    engine.environment(JSON.stringify({ sky: { type: 'color', color: [1, 1, 1], intensity: 0.05, skyLightIntensity: 1 }, background: [0.8, 0.8, 0.8], fog: null }));
    engine.settings(JSON.stringify({ name: 'BrickMotion Studio', preset: 'preview', camera: CAMERA, width, height, time: 0, overrides: { post: { bloom: { intensity: 0 }, vignette: 0, motionBlur: { amount: 0 } } } }));
    this.structure = this.studio.bricks.structureVersion; this.materials = this.studio.materialVersion ?? 0;
    this.groundY = this.studio.groundY; this.floorColor = this.studio.floorColorOverride ?? null;
    this.pose = this.studio.bricks.poseVersion;
    await engine.start(this.canvas, width, height, '{"frame":false,"on":[]}', 0, 30, 0);
    this._ready = !this.disposed;
  }

  private syncCamera(create = false): void {
    const camera = this.studio.camera;
    if (!(camera instanceof THREE.PerspectiveCamera)) throw new Error('ThreeRT currently requires perspective view.');
    camera.updateMatrixWorld(true);
    const descriptor = JSON.stringify({ fov: camera.getEffectiveFOV(), near: camera.near, far: camera.far, exposure: { mode: 'manual', ev100: 0 }, dof: null });
    const state = descriptor + camera.matrixWorld.elements.join(',');
    if (state === this.cameraState) return;
    if (create) this.engine.object(CAMERA, JSON.stringify({ kind: 'camera', name: 'Editor', camera: JSON.parse(descriptor) }));
    else this.engine.camera(CAMERA, descriptor);
    const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
    camera.matrixWorld.decompose(position, rotation, scale);
    this.engine.transform(CAMERA, new Float32Array([...position.toArray(), ...rotation.toArray(), 1, 1, 1]));
    this.cameraState = state;
  }

  private reopen(): void {
    this._ready = false;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const previous = this.pending ?? Promise.resolve();
      this.pending = previous.then(async () => {
        if (this.disposed || generation !== this.generation) return;
        await this.open();
      }).catch(error => { this.failure = error; }).finally(() => {
        // A later restart may already be queued behind this one.
        if (generation === this.generation) this.pending = null;
      });
    }, 150);
  }
  setSize(width: number, height: number): void {
    if (this.size[0] === width && this.size[1] === height) return;
    this.size = [width, height]; this.reopen();
  }
  setPalette(palette: Palette): void { if (this.palette !== palette) { this.palette = palette; this.reopen(); } }
  setHybrid(_enabled: boolean): void { /* Its own temporal denoiser is upstream's. */ }
  renderSample(): boolean {
    if (this.failure) throw this.failure;
    if (this.disposed) return false;
    if (this._ready && (this.structure !== this.studio.bricks.structureVersion || this.materials !== (this.studio.materialVersion ?? 0) || this.groundY !== this.studio.groundY || this.floorColor !== (this.studio.floorColorOverride ?? null))) this.reopen();
    if (!this._ready) return false;
    if (this.frame > 0 && !this.engine.frameIdle()) return true;
    const dt = 1 / 30;
    this.engine.frameBegin(dt);
    if (this.pose !== this.studio.bricks.poseVersion) {
      this.studio.bricks.root.updateMatrixWorld(true);
      for (const link of this.links) {
        instanceWorldMatrices(link.source, link.matrices);
        this.engine.instances(link.id, link.source.count, link.matrices);
        this.engine.visible(link.id, shown(link.source));
      }
      this.pose = this.studio.bricks.poseVersion;
    }
    this.syncCamera();
    const stats = JSON.parse(this.engine.frameEnd(dt));
    this.engine.markSubmitted();
    if (stats.guard_trips) throw new Error('ThreeRT stopped a ray traversal; showing the current viewport.');
    this.frame = stats.frame; this.gpuMs = stats.gpu_ms; this.scale = stats.scale;
    return true;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this._ready = false; this.generation++;
    clearTimeout(this.timer); this.links = [];
    // start() owns an async GPU request: release the singleton only after it settles.
    if (this.pending) void this.pending.finally(this.release); else this.release();
  }
}
