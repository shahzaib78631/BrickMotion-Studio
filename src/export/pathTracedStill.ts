/**
 * A final-quality still, path traced (three-gpu-pathtracer): real bounce light, soft
 * area-light shadows, glossy reflections of the environment and colour bleeding between
 * parts, like an offline renderer. It takes seconds rather than a frame.
 *
 * The studio's backdrop and its shadow-only floor have no path-traced equivalent, so the
 * picture is put together from five renders:
 *   1. the normal studio with the bricks hidden: the backdrop and floor as the viewport has them
 *   2. a mask of where the bricks are
 *   3. the path-traced scene: bricks on a matte floor in the same environment and lights
 *   4. the same with the bricks removed, the floor alone
 *   5. composite: bricks from (3); the floor is (1) times (3) ÷ (4), which is exactly the
 *      shadow and bounce light the bricks add to that floor.
 * Depth of field (Materials → Camera lens) blurs the finished picture (see depthOfField.ts).
 *
 * A PathTraceSession keeps the path-traced scene between pictures, so an MP4 can be path
 * traced frame by frame: moved pieces only refit the ray-tracing tree.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { ENVIRONMENTS, floorColorOf, floorFor, sceneOf, takesFloorColor, type Materials, type StudioLook } from '../render/looks';
import { LensPass } from '../render/depthOfField';
import type { ColorDef } from '../ldraw/colors';
import type { Studio } from '../render/studio';
import type { ExportDeps } from './exportVideo';
import { applyStillCamera, type TransparentStillOpts } from './capture';
import { disposeOffscreenStudio } from '../render/studio';

export type PathTracedStillOpts = TransparentStillOpts & {
  /** samples per pixel: more is cleaner and slower */
  samples: number;
  /** keep an alpha background: bricks and their floor shadow only */
  transparent?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
};

/** Area lights stand in for the studio's directional lights: their size gives soft shadows. */
const SOFTBOX = 0.55;
/** Path-traced tile edge in pixels. */
const TILE = 384;
/** Glowing parts are brighter in the path tracer than in the viewport: they light what is around them. */
const PT_GLOW_GAIN = 3;
/** Where pieces that are not on screen yet wait: tiny and far under the floor. Hiding
 * them instead would rebuild the ray-tracing tree whenever one appears. */
const PARKED = new THREE.Matrix4().makeTranslation(0, -1e4, 0).multiply(new THREE.Matrix4().makeScale(1e-4, 1e-4, 1e-4));

export async function capturePathTracedStill(opts: PathTracedStillOpts, deps: Pick<ExportDeps, 'createStudio' | 'createCanvas'>): Promise<Blob> {
  const { width, height } = opts;
  const canvas = deps.createCanvas ? deps.createCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const studio = deps.createStudio(canvas, { preserveDrawingBuffer: true });
  let session: PathTraceSession | null = null;
  let lens: LensPass | null = null;
  try {
    studio.renderer.setPixelRatio(1);
    studio.setLook?.(opts.studioLook ?? 'soft');
    if (opts.render) studio.setRenderOptions?.(opts.render);
    if (opts.materials) studio.setMaterials?.(opts.materials);
    await studio.ready?.();
    studio.setSceneSetup(opts.sceneSetup, false, null, width / height);
    studio.setSize(width, height);
    studio.bricks.setInstances(opts.instances);
    studio.bricks.setMatrices((key) => opts.pose.get(key) ?? null);
    studio.fitTo(opts.box, opts.groundY);
    applyStillCamera(studio, opts.camera);
    session = await PathTraceSession.create(studio, { materials: opts.materials, studioLook: opts.studioLook, groundY: opts.groundY });
    let out = await session.render(opts.samples, { transparent: opts.transparent, signal: opts.signal, onProgress: opts.onProgress });
    // depth of field on the finished picture (not with an alpha background: nothing to blur into)
    const lensChoice = opts.materials?.lens;
    if (lensChoice && lensChoice.blur !== 'off' && !opts.transparent) {
      lens = new LensPass(studio.renderer);
      lens.apply(out, { lens: lensChoice, camera: studio.camera, root: studio.bricks.root, box: opts.box, groundY: groundOf(opts.materials, opts.groundY) });
      out = readPixels(canvas, width, height);
    }
    const final = makeCanvas2d(width, height);
    final.ctx.putImageData(out, 0, 0);
    return await toBlob(final.canvas, opts.type ?? 'image/png');
  } finally {
    lens?.dispose();
    session?.dispose();
    disposeOffscreenStudio(studio);
  }
}

/** The floor height the lens should see, or null when there is no floor. */
export const groundOf = (materials: Materials | undefined, groundY: number) => (materials?.floor === 'none' ? null : groundY);

/**
 * The studio's current bricks, lights and camera, path traced. Create it once the studio
 * is set up (look, materials, instances, fitTo); then pose the bricks and the camera and
 * call render() for each picture.
 */
export class PathTraceSession {
  private disposables: { dispose(): void }[] = [];
  private links: { inst: THREE.InstancedMesh; index: number; mesh: THREE.Mesh }[] = [];
  private constructor(
    private studio: Studio,
    private look: ReturnType<typeof sceneOf>,
    private bricksScene: THREE.Scene,
    private floorScene: THREE.Scene,
    private bricksTracer: WebGLPathTracer,
    private floorTracer: WebGLPathTracer,
  ) {}

  static async create(studio: Studio, opts: { materials?: Materials; studioLook?: StudioLook; groundY: number }): Promise<PathTraceSession> {
    const disposables: { dispose(): void }[] = [];
    const renderer = studio.renderer;
    const look = sceneOf(opts.studioLook ?? 'soft');
    const environment = await environmentFor(renderer, opts.materials, disposables);
    // the picked floor colour applies to the sweep and the matte table; other floors keep the scene's
    const kind = floorFor(opts.studioLook ?? 'soft', opts.materials?.floor ?? 'auto');
    const floorColor = takesFloorColor(kind) ? floorColorOf(opts.studioLook, opts.materials) : look.floorColor;
    const bricksScene = baseScene(studio, environment, floorColor, opts.groundY, disposables);
    const floorScene = baseScene(studio, environment, floorColor, opts.groundY, disposables);
    const tracer = () => {
      const t = new WebGLPathTracer(renderer);
      Object.assign(t, { renderToCanvas: true, synchronizeRenderSize: true, dynamicLowRes: false, rasterizeScene: false, minSamples: 0, renderDelay: 0, fadeDuration: 0, bounces: 6, transmissiveBounces: 8, filterGlossyFactor: 0.5 });
      disposables.push(t);
      return t;
    };
    const session = new PathTraceSession(studio, look, bricksScene, floorScene, tracer(), tracer());
    session.disposables = disposables;
    session.addBricks(opts.materials);
    return session;
  }

  /** One mesh per brick instance (the path tracer merges them into one tree). Its scene
   * generator edits what it is given, so it gets copies: the geometry and materials here
   * are shared with the live viewport. */
  private addBricks(materials: Materials | undefined) {
    const copies = new Map<object, THREE.BufferGeometry | THREE.Material | THREE.Material[]>();
    const copy = <T extends THREE.BufferGeometry | THREE.Material | THREE.Material[]>(x: T): T => {
      let c = copies.get(x);
      if (!c) {
        c = Array.isArray(x) ? x.map((y) => tracedMaterial(y, materials)) : (x as THREE.Material).isMaterial ? tracedMaterial(x as THREE.Material, materials) : (x as THREE.BufferGeometry).clone();
        copies.set(x, c);
        if (Array.isArray(c)) this.disposables.push(...c);
        else this.disposables.push(c);
      }
      return c as T;
    };
    const bricks = new THREE.Group();
    this.studio.bricks.root.updateMatrixWorld(true);
    this.studio.bricks.root.traverseVisible((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) {
        const inst = o as THREE.InstancedMesh;
        for (let i = 0; i < inst.count; i++) {
          const mesh = new THREE.Mesh(copy(inst.geometry), copy(inst.material));
          mesh.matrixAutoUpdate = false;
          bricks.add(mesh);
          this.links.push({ inst, index: i, mesh });
        }
      } else if ((o as THREE.Mesh).isMesh) {
        const src = o as THREE.Mesh;
        const mesh = new THREE.Mesh(copy(src.geometry), copy(src.material));
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(src.matrixWorld);
        bricks.add(mesh);
      }
    });
    this.bricksScene.add(bricks);
  }

  /** Copies the bricks' current matrices (the studio's pose) onto the traced meshes. */
  private syncPose() {
    const m = new THREE.Matrix4();
    this.studio.bricks.root.updateMatrixWorld(true);
    for (const { inst, index, mesh } of this.links) {
      inst.getMatrixAt(index, m);
      if (Math.abs(m.determinant()) < 1e-12) mesh.matrix.copy(PARKED);
      else mesh.matrix.multiplyMatrices(inst.matrixWorld, m);
    }
  }

  /** The finished picture of the studio as posed now. */
  async render(samples: number, opts: { transparent?: boolean; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<ImageData> {
    const studio = this.studio;
    const renderer = studio.renderer;
    const canvas = renderer.domElement as HTMLCanvasElement | OffscreenCanvas;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const width = size.x, height = size.y;
    const camera = studio.camera;
    camera.updateMatrixWorld();

    // 1. the backdrop and floor without bricks
    studio.bricks.root.visible = false;
    studio.render();
    const backdrop = readPixels(canvas, width, height);
    studio.bricks.root.visible = true;

    // 2. where the bricks are
    const mask = renderMask(studio, width, height);

    // 3 and 4. path traced, with and without bricks
    this.syncPose();
    // the studio render above turned the sweep to face this camera
    syncSweep(studio, this.bricksScene);
    syncSweep(studio, this.floorScene);
    const floorSamples = Math.max(16, Math.round(samples / 4));
    const total = samples + floorSamples;
    const trace = async (tracer: WebGLPathTracer, scene: THREE.Scene, count: number, before: number) => {
      // Small tiles keep each draw short: one long draw trips the GPU watchdog, which
      // resets every WebGL context on the page, the live viewport's included.
      tracer.tiles.set(Math.ceil(width / TILE), Math.ceil(height / TILE));
      // builds (or, when only poses changed, refits) the ray-tracing tree on this thread
      tracer.setScene(scene, camera);
      await new Promise((r) => setTimeout(r, 0));
      while (tracer.samples < count) {
        if (opts.signal?.aborted) throw new DOMException('Rendering was cancelled.', 'AbortError');
        if (renderer.getContext().isContextLost())
          throw new Error('The graphics card reset during the render. Try a lower quality or a smaller size.');
        tracer.renderSample();
        opts.onProgress?.(before + Math.min(count, Math.floor(tracer.samples)), total);
        // one tile per call: hand the GPU back to the page between tiles
        await new Promise((r) => setTimeout(r, 0));
      }
      return readPixels(canvas, width, height);
    };
    const withBricks = await trace(this.bricksTracer, this.bricksScene, samples, 0);
    const floorOnly = await trace(this.floorTracer, this.floorScene, floorSamples, samples);

    // 5. composite
    return composite(backdrop, mask, withBricks, floorOnly, !!opts.transparent, this.look.shadowColor);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}

/** A brick material as the path tracer should see it: clear glass refracts, glowing colours light the scene. */
export function tracedMaterial(source: THREE.Material, materials: Materials | undefined): THREE.Material {
  const m = source.clone() as THREE.MeshPhysicalMaterial;
  const color = m.userData?.bmColor as ColorDef | undefined;
  if (m.isMeshPhysicalMaterial && color?.finish === 'trans' && materials?.glass === 'clear') {
    const tint = new THREE.Color(color.hex);
    // tinted through its depth like coloured glass; a light tint on each surface
    Object.assign(m, { transparent: false, opacity: 1, depthWrite: true, transmission: 1, ior: 1.52, roughness: 0.02, metalness: 0, thickness: 1, attenuationDistance: 2.5 });
    m.attenuationColor.copy(tint);
    m.color.copy(tint).lerp(new THREE.Color('#ffffff'), 0.55);
  }
  const glow = (m.userData?.bmGlow as number) ?? 0;
  if (glow > 0 && 'emissiveIntensity' in m) m.emissiveIntensity = glow * PT_GLOW_GAIN;
  return m;
}

/** The bricks in pure white on black, as the rasteriser covers them (anti-aliased). */
function renderMask(studio: Studio, width: number, height: number): ImageData {
  const renderer = studio.renderer;
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const stage = new THREE.Scene();
  stage.background = new THREE.Color(0x000000);
  stage.overrideMaterial = white;
  const root = studio.bricks.root;
  const parent = root.parent;
  stage.add(root);
  renderer.setRenderTarget(null);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, width / renderer.getPixelRatio(), height / renderer.getPixelRatio());
  renderer.render(stage, studio.camera);
  parent?.add(root);
  white.dispose();
  return readPixels(renderer.domElement as HTMLCanvasElement | OffscreenCanvas, width, height);
}

/** What the path tracer lights the scene with: the chosen HDR photo, or the studio room as a cube map. */
async function environmentFor(renderer: THREE.WebGLRenderer, materials: Materials | undefined, disposables: { dispose(): void }[]): Promise<THREE.Texture> {
  const choice = ENVIRONMENTS.find((e) => e.id === materials?.environment) ?? ENVIRONMENTS[0];
  if (choice.file) {
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    const loader = new HDRLoader();
    loader.setDataType(THREE.FloatType);
    const hdr = await loader.loadAsync(`${base}hdri/${choice.file}`).catch(() => null);
    if (hdr) {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      disposables.push(hdr);
      return hdr;
    }
  }
  const target = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const room = new RoomEnvironment();
  new THREE.CubeCamera(0.1, 100, target).update(renderer, room);
  room.dispose();
  disposables.push(target);
  return target.texture;
}

const TRACED_SWEEP = 'traced-sweep';
/** Turns the traced sweep the way the studio's sweep faces now (it follows the camera round the model). */
function syncSweep(studio: Studio, scene: THREE.Scene) {
  const live = studio.scene.getObjectByName('studio-sweep');
  const traced = scene.getObjectByName(TRACED_SWEEP);
  if (!live || !traced) return;
  live.updateMatrixWorld(true);
  traced.matrix.copy(live.matrixWorld);
  traced.updateMatrixWorld(true);
}

/** The environment, a matte floor and the studio's lights, without bricks. */
function baseScene(studio: Studio, environment: THREE.Texture, floorColor: string, groundY: number, disposables: { dispose(): void }[]): THREE.Scene {
  const scene = new THREE.Scene();
  scene.environment = environment;
  // the raster studio adds a hemisphere fill; a path tracer gets that from the environment's bounce
  let hemi = 0;
  studio.scene.traverse((o) => { if ((o as THREE.HemisphereLight).isHemisphereLight && o.visible) hemi += (o as THREE.HemisphereLight).intensity; });
  scene.environmentIntensity = studio.scene.environmentIntensity * (1 + hemi * 0.6);
  scene.background = null;

  const floorMat = new THREE.MeshStandardMaterial({ color: floorColor, roughness: 0.95, metalness: 0 });
  // the curved sweep, when the studio shows one: its wall then catches traced shadow and bounce light too
  const sweep = studio.scene.getObjectByName('studio-sweep') as THREE.Mesh | undefined;
  if (sweep?.visible) {
    const geo = sweep.geometry.clone();
    disposables.push(floorMat, geo);
    const traced = new THREE.Mesh(geo, floorMat);
    traced.name = TRACED_SWEEP;
    traced.matrixAutoUpdate = false;
    scene.add(traced);
    syncSweep(studio, scene);
  } else {
    const floorGeo = new THREE.PlaneGeometry(2000, 2000);
    disposables.push(floorMat, floorGeo);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = groundY;
    scene.add(floor);
  }

  // the studio's lights: directional ones become softboxes, others are used as they are
  studio.scene.traverseVisible((o) => {
    const light = o as THREE.Light;
    if (!light.isLight || light.intensity <= 0 || (light as THREE.HemisphereLight).isHemisphereLight || (light as THREE.AmbientLight).isAmbientLight) return;
    if ((light as THREE.DirectionalLight).isDirectionalLight) {
      const dir = light as THREE.DirectionalLight;
      const from = dir.getWorldPosition(new THREE.Vector3());
      const to = dir.target.getWorldPosition(new THREE.Vector3());
      const dist = from.distanceTo(to);
      const side = dist * SOFTBOX;
      // same irradiance at the target as the directional light: E ≈ L · A / d²
      const area = new THREE.RectAreaLight(dir.color, (dir.intensity * dist * dist) / (side * side), side, side);
      area.position.copy(from);
      area.lookAt(to);
      scene.add(area);
    } else {
      const copy = light.clone();
      light.getWorldPosition(copy.position);
      scene.add(copy);
      const target = (light as THREE.SpotLight).target;
      if (target) {
        const t = new THREE.Object3D();
        target.getWorldPosition(t.position);
        scene.add(t);
        (copy as THREE.SpotLight).target = t;
      }
    }
  });
  scene.updateMatrixWorld(true);
  return scene;
}

const toLinear = (c: number) => Math.pow(c / 255, 2.2);
const toSrgb = (c: number) => Math.round(255 * Math.pow(Math.min(1, Math.max(0, c)), 1 / 2.2));

/** Bricks from the path tracer; the floor is the backdrop darkened (or lit) by what the bricks did to it. */
export function composite(backdrop: ImageData, mask: ImageData, withBricks: ImageData, floorOnly: ImageData, transparent: boolean, shadowColor: string): ImageData {
  const { width, height } = backdrop;
  const out = new ImageData(width, height);
  const b = backdrop.data, k = mask.data, a = withBricks.data, f = floorOnly.data, o = out.data;
  const shadow = new THREE.Color(shadowColor);
  const sh = [shadow.r, shadow.g, shadow.b].map((v) => toSrgb(v));
  for (let i = 0; i < o.length; i += 4) {
    const m = k[i] / 255;
    let r = 1, g = 1, bl = 1;
    // the ratio only where the floor was hit in both renders
    if (f[i + 3] > 0 && a[i + 3] > 0) {
      const ratio = (j: number) => {
        const lf = toLinear(f[i + j]);
        return lf > 1e-4 ? Math.min(1.5, toLinear(a[i + j]) / lf) : 1;
      };
      r = ratio(0); g = ratio(1); bl = ratio(2);
    }
    if (transparent) {
      const dark = Math.max(0, 1 - (0.2126 * r + 0.7152 * g + 0.0722 * bl));
      const alpha = m + (1 - m) * Math.min(1, dark);
      for (let j = 0; j < 3; j++) o[i + j] = alpha > 0 ? Math.round((a[i + j] * m + sh[j] * (alpha - m)) / alpha) : 0;
      o[i + 3] = Math.round(alpha * 255);
    } else {
      const rs = [r, g, bl];
      for (let j = 0; j < 3; j++) {
        const floor = toSrgb(toLinear(b[i + j]) * rs[j]);
        o[i + j] = Math.round(a[i + j] * m + floor * (1 - m));
      }
      o[i + 3] = 255;
    }
  }
  return out;
}

function makeCanvas2d(width: number, height: number) {
  const canvas: HTMLCanvasElement | OffscreenCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Could not create a 2D canvas for the path-traced still.');
  return { canvas, ctx };
}

function readPixels(source: HTMLCanvasElement | OffscreenCanvas, width: number, height: number): ImageData {
  const { ctx } = makeCanvas2d(width, height);
  ctx.drawImage(source as CanvasImageSource, 0, 0);
  return ctx.getImageData(0, 0, width, height);
}

function toBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type: string): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality: 0.95 });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the still.'))), type, 0.95));
}
