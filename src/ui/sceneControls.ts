import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { perspectiveEquivalent, type Projection, type Studio } from '../render/studio';
import { activeSceneCamera, createCamera, sceneObject, sceneSetupOf, updateObject, type SceneCamera, type SceneSetup, type XYZ } from '../render/sceneSetup';
import { useStudio } from '../state/store';
import { useViewState } from './viewState';
import { shouldFollowSceneCamera, useSceneView } from './sceneViewState';
import { viewportApi } from './viewportApi';

export type SceneController = {
  sync(setup?: SceneSetup): void;
  enterCameraView(on?: boolean): void;
  alignCamera(): void;
  setTransformMode(mode: 'translate' | 'rotate'): void;
  pick(ray: THREE.Raycaster): string | null;
  prepareRender(): { x: number; y: number; width: number; height: number } | undefined;
  isHandlingPointer(): boolean;
  /**
   * In camera view, writes the view into the scene camera, so a zoom or fit made there
   * changes the shot the video and captures use, not just the editor's picture of it.
   */
  saveViewToCamera(): void;
  /** Runs `fn` (a camera move the Camera track makes) without saving the view into the scene camera. */
  quietly(fn: () => void): void;
  dispose(): void;
};

export function createSceneControls(studio: Studio, orbit: OrbitControls, canvas: HTMLCanvasElement): SceneController {
  const proxy = new THREE.Object3D();
  studio.scene.add(proxy);
  const transform = new TransformControls(studio.camera, canvas);
  transform.setSize(0.72);
  transform.setSpace('world');
  transform.setMode('translate');
  studio.scene.add(transform.getHelper());
  transform.enabled = false;
  let dragging = false;
  let syncingView = false;
  let remembered: { projection: Projection; position: THREE.Vector3; target: THREE.Vector3; fov: number; near: number; far: number; zoom: number } | null = null;
  let activeSetup: SceneSetup | undefined;
  let mode: 'translate' | 'rotate' = 'translate';

  const selected = () => sceneObject(sceneSetupOf(activeSetup), useSceneView.getState().selectedId);
  const commit = (setup: SceneSetup) => useStudio.getState().apply((plan) => ({ ...plan, sceneSetup: setup }));
  const updateSelection = (patch: { position?: XYZ; target?: XYZ }) => {
    const selectedId = useSceneView.getState().selectedId;
    if (!activeSetup || !selectedId) return;
    const current = sceneSetupOf(useStudio.getState().plan.sceneSetup);
    commit(updateObject(current, selectedId, (value) => ({ ...value, ...patch })));
  };
  const attachSelection = () => {
    if (dragging) return;
    const obj = selected();
    if (!obj || useStudio.getState().mode !== 'edit' || useSceneView.getState().cameraView) {
      transform.detach(); transform.enabled = false; return;
    }
    proxy.position.fromArray(obj.position);
    const direction = new THREE.Vector3(...obj.target).sub(new THREE.Vector3(...obj.position));
    if (direction.lengthSq() < 0.001) direction.set(0, 0, -1);
    proxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction.normalize());
    proxy.scale.setScalar(1);
    transform.setMode(mode);
    transform.enabled = true;
    transform.attach(proxy);
  };
  transform.addEventListener('dragging-changed', (e) => {
    dragging = !!e.value;
    orbit.enabled = !dragging && (!useSceneView.getState().cameraView || useSceneView.getState().lockCamera);
    if (dragging) useStudio.getState().beginGesture();
    else { useStudio.getState().endGesture(); attachSelection(); }
  });
  transform.addEventListener('objectChange', () => {
    const obj = selected();
    if (!dragging || !obj) return;
    const position = proxy.position.toArray() as XYZ;
    if (mode === 'translate') {
      const offset = new THREE.Vector3(...obj.target).sub(new THREE.Vector3(...obj.position));
      const target = new THREE.Vector3(...position).add(offset).toArray() as XYZ;
      updateSelection({ position, target });
    } else {
      const length = Math.max(0.1, new THREE.Vector3(...obj.target).sub(new THREE.Vector3(...obj.position)).length());
      const target = proxy.localToWorld(new THREE.Vector3(0, 0, -length)).toArray() as XYZ;
      updateSelection({ position, target });
    }
  });

  const snapCamera = () => {
    const camera = activeSceneCamera(activeSetup);
    const view = useSceneView.getState();
    if (!camera || !shouldFollowSceneCamera(view)) return;
    // "Lock camera to view" means viewport navigation edits the scene camera.
    // It must NOT block saved-camera updates (especially Fit/Auto-fit on Play).
    // Skipping an identical pose avoids fighting the user's orbit gestures.
    const samePosition = camera.position.every((n, i) => Math.abs(studio.perspective.position.getComponent(i) - n) < 1e-5);
    const sameTarget = camera.target.every((n, i) => Math.abs(orbit.target.getComponent(i) - n) < 1e-5);
    if (samePosition && sameTarget && Math.abs(studio.perspective.fov - camera.fov) < 1e-5
      && studio.perspective.near === camera.near && studio.perspective.far === camera.far) return;
    syncingView = true;
    try {
      studio.perspective.position.fromArray(camera.position);
      orbit.target.fromArray(camera.target);
      studio.perspective.fov = camera.fov;
      studio.perspective.near = camera.near;
      studio.perspective.far = camera.far;
      studio.perspective.clearViewOffset();
      studio.perspective.updateProjectionMatrix();
      orbit.update();
    } finally {
      // The programmatic OrbitControls update must never be treated as a user
      // gesture and written back over the newly fitted scene camera.
      syncingView = false;
    }
  };
  const sync = (setup?: SceneSetup) => {
    activeSetup = setup;
    const state = useSceneView.getState();
    const visible = useStudio.getState().mode === 'edit' && state.showHelpers && !state.cameraView;
    studio.setSceneSetup(setup, visible, state.selectedId, viewportApi.frameAspect?.() ?? 16 / 9);
    if (state.selectedId && !sceneObject(sceneSetupOf(setup), state.selectedId)) useSceneView.setState({ selectedId: null });
    if (state.cameraView && !activeSceneCamera(setup)) enterCameraView(false);
    orbit.enabled = !state.cameraView || state.lockCamera;
    attachSelection();
    snapCamera();
  };

  const enterCameraView = (on = !useSceneView.getState().cameraView) => {
    const current = useSceneView.getState();
    if (on === current.cameraView) return;
    const active = activeSceneCamera(activeSetup);
    if (on && !active) return;
    syncingView = true;
    if (on) {
      remembered = {
        projection: studio.projection, position: studio.camera.position.clone(),
        target: orbit.target.clone(), fov: studio.perspective.fov,
        near: studio.perspective.near, far: studio.perspective.far, zoom: studio.ortho.zoom,
      };
      studio.setProjection('perspective');
      orbit.object = studio.perspective;
      useViewState.setState({ projection: 'perspective', view: 'user' });
    } else if (remembered) {
      studio.setProjection(remembered.projection);
      orbit.object = studio.camera;
      studio.camera.position.copy(remembered.position);
      studio.perspective.fov = remembered.fov;
      studio.perspective.near = remembered.near;
      studio.perspective.far = remembered.far;
      studio.perspective.clearViewOffset();
      studio.perspective.updateProjectionMatrix();
      studio.ortho.zoom = remembered.zoom;
      studio.ortho.updateProjectionMatrix();
      orbit.target.copy(remembered.target);
      useViewState.setState({ projection: remembered.projection, view: 'user' });
    }
    if (!on) {
      // Camera view draws through the output frame's aspect (prepareRender); the
      // editor view must go back to the canvas's own shape or everything stretches.
      const { width, height } = useSceneView.getState();
      studio.perspective.aspect = Math.max(1, width) / Math.max(1, height);
      studio.perspective.clearViewOffset();
      studio.perspective.updateProjectionMatrix();
    }
    transform.camera = studio.camera;
    useSceneView.setState({ cameraView: on, regionTool: false });
    orbit.enabled = !on || current.lockCamera;
    orbit.update();
    syncingView = false;
    if (on) snapCamera();
    attachSelection();
    sync(activeSetup);
  };
  const alignCamera = () => {
    // Numpad Ctrl+Alt+0: align active camera to current editor orbit view.
    if (useSceneView.getState().cameraView) return;
    const setup = sceneSetupOf(activeSetup);
    const camera = activeSceneCamera(setup);
    // an ortho view's zoom is not a camera move: turn it into the matching distance
    const view = perspectiveEquivalent(studio, orbit.target);
    const position = view.position.toArray() as XYZ;
    const target = orbit.target.toArray() as XYZ;
    const fov = view.fov;
    if (!camera) {
      const created = createCamera(view.position, orbit.target, fov, setup.cameras.length + 1);
      commit({ ...setup, cameras: [...setup.cameras, created], activeCameraId: created.id });
      useSceneView.setState({ selectedId: created.id });
    } else commit(updateObject<SceneCamera>(setup, camera.id, (c) => ({ ...c, position, target, fov })));
  };
  const onOrbitChanged = () => {
    if (!useSceneView.getState().lockCamera) return;
    saveViewToCamera();
  };
  const saveViewToCamera = () => {
    if (syncingView || !useSceneView.getState().cameraView || !activeSetup) return;
    const camera = activeSceneCamera(activeSetup);
    if (!camera) return;
    const position = studio.perspective.position.toArray() as XYZ;
    const target = orbit.target.toArray() as XYZ;
    if ([...position, ...target].every((x, i) => Math.abs(x - [...camera.position, ...camera.target][i]) < 0.0001)) return;
    commit(updateObject<SceneCamera>(activeSetup, camera.id, (c) => ({ ...c, position, target })));
  };
  orbit.addEventListener('change', onOrbitChanged);
  return {
    sync,
    enterCameraView,
    alignCamera,
    setTransformMode(next) { mode = next; attachSelection(); },
    pick(ray) { return studio.lighting.pick(ray); },
    isHandlingPointer() { return dragging || !!transform.axis; },
    saveViewToCamera,
    quietly(fn) {
      const was = syncingView;
      syncingView = true;
      try { fn(); } finally { syncingView = was; }
    },
    prepareRender() {
      if (!useSceneView.getState().cameraView || useStudio.getState().mode !== 'edit') return undefined;
      const { width, height } = useSceneView.getState();
      const aspect = (viewportApi.frameAspect?.() ?? 1.7778);
      const frameWidth = Math.min(width * 0.88, height * 0.88 * aspect);
      const frameHeight = frameWidth / aspect;
      studio.perspective.aspect = aspect;
      studio.perspective.updateProjectionMatrix();
      studio.perspective.clearViewOffset();
      return { x: (width - frameWidth) / 2, y: (height - frameHeight) / 2, width: frameWidth, height: frameHeight };
    },
    dispose() {
      orbit.removeEventListener('change', onOrbitChanged);
      transform.detach();
      studio.scene.remove(transform.getHelper());
      transform.dispose();
      studio.scene.remove(proxy);
    },
  };
}
