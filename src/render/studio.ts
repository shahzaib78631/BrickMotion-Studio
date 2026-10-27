import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { geometryOf, getColors } from '../state/partService';
import { BrickRenderer } from './bricks';
import { studioGradientPixels } from './studioPalette';
import { SceneLighting } from './sceneLights';
import type { SceneSetup } from './sceneSetup';

import { DEFAULT_MATERIALS, floorFor, sceneOf, scenePixels, type Materials, type StudioLook } from './looks';
import { setBrickMaterials } from './materials';
import { concreteTexture, createFade, createReflection, fadingFloorMaterial, woodTexture } from './floorSurfaces';

/** A scene preset (see SCENES in looks.ts); 'soft' matches the supplied reference footage. */
export type { StudioLook, Materials } from './looks';

/** Which camera renders the editor viewport: Blender-style projection toggle. */
export type Projection = 'perspective' | 'ortho';

/**
 * Optional looks, each with its own switch:
 * - edges: faint LDraw outline edges, so neighbouring bricks and plates stay readable
 * - linearColors: plain linear tone mapping instead of filmic (ACES), which mutes
 *   saturated LEGO colours; exposure is lowered a little so whites don't clip
 */
export type RenderOptions = { edges: boolean; linearColors: boolean };
export const DEFAULT_RENDER: RenderOptions = { edges: true, linearColors: true };
const LINEAR_EXPOSURE = 0.85;
export const STUDIO_BG = '#EDEDEF';

export type Studio = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** the camera render() draws with: the perspective one, or its orthographic twin */
  readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  /** the perspective camera itself; the preview and MP4 export always drive this one */
  readonly perspective: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  /** which camera render() draws with */
  readonly projection: Projection;
  setProjection(p: Projection): void;
  /** Full ortho frustum height in world units at zoom 1; the width follows the aspect. */
  setOrthoHeight(h: number): void;
  bricks: BrickRenderer;
  lighting: SceneLighting;
  /** Apply custom lamps and toggle the traditional studio lighting. */
  setSceneSetup(setup?: SceneSetup, helpers?: boolean, selectedId?: string | null, frameAspect?: number): void;
  setSize(w: number, h: number): void;
  /** Switch the entire rendering setup; preview and MP4 export must agree. */
  setLook?(look: StudioLook): void;
  /** Edge lines and colour response; preview and MP4 export must agree. */
  setRenderOptions?(o: RenderOptions): void;
  /** Brick finish, surface texture and floor; preview and MP4 export must agree. */
  setMaterials?(m: Materials): void;
  /** Floor height and light/shadow framing for a world-space box (studs, +Y up). */
  fitTo(box: THREE.Box3, groundY: number): void;
  /** Optionally render only inside a camera frame (CSS pixel coordinates, top-left origin). */
  render(frame?: { x: number; y: number; width: number; height: number }): void;
  dispose(): void;
};

/** Screen-space studio backdrop, independent of camera angle, zoom or canvas
 * size. DataTexture also works on OffscreenCanvas during MP4 export. */
export function studioBackground(): THREE.DataTexture {
  const height = 256;
  const texture = new THREE.DataTexture(studioGradientPixels(height), 2, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export function createStudio(canvas: HTMLCanvasElement | OffscreenCanvas, opts: { preserveDrawingBuffer?: boolean; transparent?: boolean } = {}): Studio {
  const transparent = !!opts.transparent;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: !!opts.preserveDrawingBuffer, alpha: transparent });
  if (transparent) renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(typeof window !== 'undefined' && canvas instanceof HTMLCanvasElement ? Math.min(window.devicePixelRatio, 1.5) : 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const gradient = studioBackground();
  let backdrop: THREE.DataTexture | null = null;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;

  // An ordinary lit floor washed the background almost white and made the
  // reference-style contact shadows imperceptible. A transparent shadow-only
  // receiver keeps the studio gradient intact while still catching the REAL
  // brick shadow silhouettes (not a fake ellipse baked into the video).
  // Lit floors (matte, wood, concrete) fade into the backdrop around the model, and
  // the reflective floor is a faded mirror under the same shadow catcher.
  const fade = createFade();
  const litFloor = fadingFloorMaterial(fade, { color: STUDIO_BG, roughness: 0.92, metalness: 0 });
  let woodMap: THREE.DataTexture | null = null;
  let concreteMap: THREE.DataTexture | null = null;
  const shadowFloor = new THREE.ShadowMaterial({ color: new THREE.Color('#262630'), opacity: 0.42 });
  shadowFloor.depthWrite = false;
  const floor = new THREE.Mesh<THREE.PlaneGeometry, THREE.Material>(new THREE.PlaneGeometry(1000, 1000), shadowFloor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  // transparent floors draw in order: lit floor or mirror, then the shadow catcher
  floor.renderOrder = -3;
  scene.add(floor);
  let groundLevel = 0;
  // the shadow catcher drawn over a lit or mirrored floor
  const shadowOver = new THREE.Mesh(floor.geometry, shadowFloor);
  shadowOver.rotation.x = -Math.PI / 2;
  shadowOver.receiveShadow = true;
  shadowOver.renderOrder = -1;
  shadowOver.visible = false;
  scene.add(shadowOver);
  let reflection: ReturnType<typeof createReflection> | null = null;
  let look: StudioLook = 'soft';
  let materials: Materials = { ...DEFAULT_MATERIALS };

  const hemi = new THREE.HemisphereLight(0xffffff, 0xc5c6ce, 0.85);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 2.35);
  key.castShadow = true;
  // 1024 for full-HD MP4 to avoid the previous export hitching, 1536 for the editor.
  const shadowSize = opts.preserveDrawingBuffer ? 1024 : 1536;
  key.shadow.mapSize.set(shadowSize, shadowSize);
  key.shadow.radius = 4;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.016;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xf3f5ff, 0.38);
  fill.position.set(15, 24, -18);
  scene.add(fill);

  const camera = new THREE.PerspectiveCamera(30, 9 / 16, 0.1, 2000);
  camera.position.set(20, 25, 40);

  // Orthographic twin for Blender-style ortho views. The pose is copied from the
  // perspective camera when switched, the view height comes from that framing,
  // and OrbitControls' dolly becomes a zoom.
  const ortho = new THREE.OrthographicCamera(-9, 9, 16, -16, 0.1, 4000);
  let aspect = 9 / 16;
  let orthoH = 32;
  const applyOrtho = () => {
    ortho.left = (-orthoH / 2) * aspect;
    ortho.right = (orthoH / 2) * aspect;
    ortho.top = orthoH / 2;
    ortho.bottom = -orthoH / 2;
    ortho.updateProjectionMatrix();
  };
  applyOrtho();
  let active: THREE.PerspectiveCamera | THREE.OrthographicCamera = camera;

  const bricks = new BrickRenderer(geometryOf, getColors());
  scene.add(bricks.root);
  const lighting = new SceneLighting(scene, typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement);
  let sceneSetup: SceneSetup | undefined;
  let lightBounds: THREE.Box3 | null = null;
  let sizeW = 1;
  let sizeH = 1;

  let exposure = 1;
  let lookEnv = 0.75;
  let render: RenderOptions = { ...DEFAULT_RENDER };
  const applyExposure = () => {
    renderer.toneMapping = render.linearColors ? THREE.LinearToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = exposure * (sceneSetup?.exposure ?? 1) * (render.linearColors ? LINEAR_EXPOSURE : 1);
  };
  const setRenderOptions = (o: RenderOptions) => {
    render = { ...o };
    bricks.setEdges(o.edges);
    applyExposure();
  };
  /** The floor for the current scene and material choice. */
  const applyFloor = () => {
    const preset = sceneOf(look);
    const kind = floorFor(look, materials.floor);
    shadowFloor.color.set(preset.shadowColor);
    shadowFloor.opacity = preset.shadowOpacity;
    litFloor.color.set(kind === 'wood' || kind === 'concrete' ? '#ffffff' : preset.floorColor);
    litFloor.roughness = kind === 'concrete' ? 0.85 : kind === 'wood' ? 0.6 : 0.92;
    if (kind === 'wood') litFloor.map = (woodMap ??= woodTexture());
    else if (kind === 'concrete') litFloor.map = (concreteMap ??= concreteTexture());
    else litFloor.map = null;
    litFloor.needsUpdate = true;
    const lit = kind === 'matte' || kind === 'wood' || kind === 'concrete';
    floor.material = lit ? litFloor : shadowFloor;
    floor.visible = !transparent && kind !== 'none' && kind !== 'reflective';
    // a lit floor or a mirror still gets the real contact shadows on top
    shadowOver.visible = !transparent && (lit || kind === 'reflective') && preset.shadowOpacity > 0;
    if (kind === 'reflective' && !transparent) {
      if (!reflection) {
        reflection = createReflection(fade, opts.preserveDrawingBuffer ? 1024 : 768);
        reflection.position.y = groundLevel - 0.002;
        scene.add(reflection);
      }
      const mat = reflection.material as THREE.ShaderMaterial;
      mat.uniforms.strength.value = preset.reflection;
      // the mirror shows the backdrop's floor colour through its faded edge
      reflection.visible = true;
    } else if (reflection) reflection.visible = false;
  };
  const setLook = (next: StudioLook) => {
    look = sceneOf(next).id;
    const preset = sceneOf(look);
    // A transparent studio keeps an empty background and no shadow floor, so an
    // exported still has no studio backdrop baked into its alpha channel.
    if (!transparent) {
      if (look === 'soft') scene.background = gradient;
      else {
        backdrop?.dispose();
        backdrop = new THREE.DataTexture(scenePixels(preset), 64, 128, THREE.RGBAFormat);
        backdrop.colorSpace = THREE.SRGBColorSpace;
        backdrop.minFilter = THREE.LinearFilter;
        backdrop.magFilter = THREE.LinearFilter;
        backdrop.generateMipmaps = false;
        backdrop.needsUpdate = true;
        scene.background = backdrop;
      }
    }
    exposure = preset.exposure;
    lookEnv = preset.env;
    hemi.intensity = preset.hemi;
    hemi.groundColor.set(preset.hemiGround);
    key.intensity = preset.key;
    key.color.set(preset.keyColor);
    fill.intensity = preset.fill;
    applyFloor();
    applyExposure();
    syncStudioLights();
  };
  const setMaterials = (m: Materials) => {
    materials = { ...m };
    setBrickMaterials(m);
    applyFloor();
  };
  const syncStudioLights = () => {
    const enabled = !sceneSetup?.lights.length || !sceneSetup.useLightsForVideo || sceneSetup.includeStudioLights;
    hemi.visible = enabled;
    key.visible = enabled;
    fill.visible = enabled;
    // Keep just a small environment fill when the authored scene lights replace the studio.
    scene.environmentIntensity = enabled ? lookEnv : 0.12;
  };
  setLook('soft');
  setRenderOptions(DEFAULT_RENDER);

  return {
    renderer,
    scene,
    get camera() {
      return active;
    },
    perspective: camera,
    ortho,
    get projection(): Projection {
      return active === ortho ? 'ortho' : 'perspective';
    },
    setProjection(p) {
      active = p === 'ortho' ? ortho : camera;
    },
    setOrthoHeight(h) {
      orthoH = Math.max(h, 1e-3);
      applyOrtho();
    },
    bricks,
    lighting,
    setSceneSetup(setup, helpers = false, selectedId = null, frameAspect = aspect) {
      sceneSetup = setup;
      lighting.apply(setup, helpers, selectedId, frameAspect);
      if (lightBounds) lighting.fitTo(lightBounds);
      syncStudioLights();
      applyExposure();
    },
    setLook,
    setRenderOptions,
    setMaterials,
    setSize(w, h) {
      renderer.setSize(w, h, false);
      sizeW = w; sizeH = h;
      aspect = w / h;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      applyOrtho();
    },
    fitTo(box, groundY) {
      groundLevel = groundY;
      floor.position.y = groundY - 0.001;
      shadowOver.position.y = groundY - 0.0005;
      if (reflection) reflection.position.y = groundY - 0.002;
      fade.center.value.copy(box.getCenter(new THREE.Vector3()));
      fade.radius.value = Math.max(24, box.getSize(new THREE.Vector3()).length() * 1.6);
      const c = box.getCenter(new THREE.Vector3());
      const r = Math.max(8, box.getSize(new THREE.Vector3()).length() / 2);
      key.target.position.copy(c);
      key.position.copy(c).add(new THREE.Vector3(-0.5, 1.2, 0.7).normalize().multiplyScalar(r * 3));
      const s = key.shadow.camera;
      s.left = s.bottom = -r * 1.3;
      s.right = s.top = r * 1.3;
      s.near = 0.1;
      s.far = r * 6;
      s.updateProjectionMatrix();
      lightBounds = box.clone();
      lighting.fitTo(box);
    },
    render(frame) {
      if (frame) {
        // Render to the true output aspect ratio, not a squeezed full-width canvas.
        // Scissor coordinates are bottom-left in Three.js, CSS coordinates top-left.
        const x = Math.round(frame.x);
        const y = Math.round(sizeH - frame.y - frame.height);
        const w = Math.max(1, Math.round(frame.width));
        const h = Math.max(1, Math.round(frame.height));
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, sizeW, sizeH);
        renderer.setClearColor(0x1b1c22, 1);
        renderer.clear(true, true, true);
        renderer.setViewport(x, y, w, h);
        renderer.setScissor(x, y, w, h);
        renderer.setScissorTest(true);
        renderer.render(scene, active);
        renderer.setScissorTest(false);
        renderer.setViewport(0, 0, sizeW, sizeH);
      } else {
        renderer.setViewport(0, 0, sizeW, sizeH);
        renderer.setScissorTest(false);
        // A previous letterboxed render may have left an opaque clear colour behind.
        if (transparent) renderer.setClearColor(0x000000, 0);
        renderer.render(scene, active);
      }
    },
    dispose() {
      lighting.dispose();
      bricks.dispose();
      gradient.dispose();
      backdrop?.dispose();
      litFloor.dispose();
      woodMap?.dispose();
      concreteMap?.dispose();
      if (reflection) {
        reflection.getRenderTarget().dispose();
        (reflection.material as THREE.Material).dispose();
      }
      shadowFloor.dispose();
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}

/** Converts an LDU box to world units (studs, +Y up). */
export function worldBox(b: { min: number[]; max: number[] }): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(b.min[0] / 20, -b.max[1] / 20, -b.max[2] / 20), new THREE.Vector3(b.max[0] / 20, -b.min[1] / 20, -b.min[2] / 20));
}

/** The perspective pose that shows what the editor is showing. In an ortho view the
 * camera never moves when zooming (the zoom scales the frustum), so its position
 * alone is far too distant: the ortho zoom becomes a camera distance instead. */
export function perspectiveEquivalent(studio: Pick<Studio, 'projection' | 'perspective' | 'ortho'>, target: THREE.Vector3): { position: THREE.Vector3; fov: number } {
  const fov = studio.perspective.fov;
  if (studio.projection !== 'ortho') return { position: studio.perspective.position.clone(), fov };
  const o = studio.ortho;
  const halfHeight = (o.top - o.bottom) / 2 / Math.max(o.zoom, 1e-6);
  const dist = Math.max(halfHeight / Math.tan(THREE.MathUtils.degToRad(fov) / 2), 0.5);
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
  return { position: target.clone().addScaledVector(back, dist), fov };
}
