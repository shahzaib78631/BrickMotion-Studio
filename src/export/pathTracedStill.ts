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
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { ENVIRONMENTS, sceneOf, type Materials } from '../render/looks';
import type { Studio } from '../render/studio';
import type { ExportDeps } from './exportVideo';
import { applyStillCamera, type TransparentStillOpts } from './capture';

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

export async function capturePathTracedStill(opts: PathTracedStillOpts, deps: Pick<ExportDeps, 'createStudio' | 'createCanvas'>): Promise<Blob> {
  const { width, height } = opts;
  const canvas = deps.createCanvas ? deps.createCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const studio = deps.createStudio(canvas, { preserveDrawingBuffer: true });
  const renderer = studio.renderer;
  const disposables: { dispose(): void }[] = [];
  try {
    renderer.setPixelRatio(1);
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
    const camera = studio.camera;
    camera.updateMatrixWorld();

    // 1. the backdrop and floor without bricks
    studio.bricks.root.visible = false;
    studio.render();
    const backdrop = readPixels(canvas, width, height);
    studio.bricks.root.visible = true;

    // 2. where the bricks are
    const mask = renderMask(studio, canvas, width, height);

    // 3 and 4. path traced, with and without bricks
    const look = sceneOf(opts.studioLook ?? 'soft');
    const environment = await environmentFor(renderer, opts.materials, disposables);
    const { scene: ptScene, bricks } = buildScene(studio, environment, look.floorColor, opts.groundY, disposables);
    const tracer = new WebGLPathTracer(renderer);
    disposables.push(tracer);
    Object.assign(tracer, { renderToCanvas: true, synchronizeRenderSize: true, dynamicLowRes: false, rasterizeScene: false, minSamples: 0, renderDelay: 0, fadeDuration: 0, bounces: 6, transmissiveBounces: 6, filterGlossyFactor: 0.5 });
    // Small tiles keep each draw short: one long draw trips the GPU watchdog, which
    // resets every WebGL context on the page, the live viewport's included.
    tracer.tiles.set(Math.ceil(width / TILE), Math.ceil(height / TILE));
    const floorSamples = Math.max(16, Math.round(opts.samples / 4));
    const total = opts.samples + floorSamples;
    const trace = async (samples: number, before: number) => {
      // builds the BVH on this thread (the async version needs a BVH worker set up first)
      tracer.setScene(ptScene, camera);
      await new Promise((r) => setTimeout(r, 0));
      while (tracer.samples < samples) {
        if (opts.signal?.aborted) throw new DOMException('Rendering was cancelled.', 'AbortError');
        if (renderer.getContext().isContextLost())
          throw new Error('The graphics card reset during the render. Try a lower quality or a smaller size.');
        tracer.renderSample();
        opts.onProgress?.(before + Math.min(samples, Math.floor(tracer.samples)), total);
        // one tile per call: hand the GPU back to the page between tiles
        await new Promise((r) => setTimeout(r, 0));
      }
      return readPixels(canvas, width, height);
    };
    const withBricks = await trace(opts.samples, 0);
    bricks.visible = false;
    const floorOnly = await trace(floorSamples, opts.samples);

    // 5. composite
    const out = composite(backdrop, mask, withBricks, floorOnly, !!opts.transparent, look.shadowColor);
    const final = makeCanvas2d(width, height);
    final.ctx.putImageData(out, 0, 0);
    return await toBlob(final.canvas, opts.type ?? 'image/png');
  } finally {
    for (const d of disposables) d.dispose();
    studio.dispose();
  }
}

/** The bricks in pure white on black, as the rasteriser covers them (anti-aliased). */
function renderMask(studio: Studio, canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number): ImageData {
  const renderer = studio.renderer;
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const stage = new THREE.Scene();
  stage.background = new THREE.Color(0x000000);
  stage.overrideMaterial = white;
  const root = studio.bricks.root;
  const parent = root.parent;
  stage.add(root);
  renderer.setRenderTarget(null);
  renderer.setViewport(0, 0, width, height);
  renderer.render(stage, studio.camera);
  parent?.add(root);
  white.dispose();
  return readPixels(canvas, width, height);
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

/** The studio's bricks, lights and floor as plain meshes the path tracer can read. */
function buildScene(studio: Studio, environment: THREE.Texture, floorColor: string, groundY: number, disposables: { dispose(): void }[]) {
  const scene = new THREE.Scene();
  scene.environment = environment;
  // the raster studio adds a hemisphere fill; a path tracer gets that from the environment's bounce
  let hemi = 0;
  studio.scene.traverse((o) => { if ((o as THREE.HemisphereLight).isHemisphereLight && o.visible) hemi += (o as THREE.HemisphereLight).intensity; });
  scene.environmentIntensity = studio.scene.environmentIntensity * (1 + hemi * 0.6);
  scene.background = null;

  // instanced bricks become one mesh per instance (the path tracer merges them into one BVH).
  // Its scene generator edits what it is given, so it gets copies: the geometry and
  // materials here are shared with the live viewport.
  const bricks = new THREE.Group();
  const m = new THREE.Matrix4();
  const copies = new Map<object, THREE.BufferGeometry | THREE.Material | THREE.Material[]>();
  const copy = <T extends THREE.BufferGeometry | THREE.Material | THREE.Material[]>(x: T): T => {
    let c = copies.get(x);
    if (!c) {
      c = Array.isArray(x) ? x.map((y) => y.clone()) : x.clone();
      copies.set(x, c);
      if (Array.isArray(c)) disposables.push(...c);
      else disposables.push(c);
    }
    return c as T;
  };
  studio.bricks.root.updateMatrixWorld(true);
  studio.bricks.root.traverseVisible((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) {
      const inst = o as THREE.InstancedMesh;
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m);
        if (Math.abs(m.determinant()) < 1e-9) continue; // hidden pieces are scaled to nothing
        const mesh = new THREE.Mesh(copy(inst.geometry), copy(inst.material));
        mesh.matrixAutoUpdate = false;
        mesh.matrix.multiplyMatrices(inst.matrixWorld, m);
        bricks.add(mesh);
      }
    } else if ((o as THREE.Mesh).isMesh) {
      const src = o as THREE.Mesh;
      const mesh = new THREE.Mesh(copy(src.geometry), copy(src.material));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(src.matrixWorld);
      bricks.add(mesh);
    }
  });
  scene.add(bricks);

  const floorMat = new THREE.MeshStandardMaterial({ color: floorColor, roughness: 0.95, metalness: 0 });
  const floorGeo = new THREE.PlaneGeometry(2000, 2000);
  disposables.push(floorMat, floorGeo);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = groundY;
  scene.add(floor);

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
  return { scene, bricks };
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
