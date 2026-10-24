import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clamp01, easeInOutCubic } from '../anim/easing';
import { modelSteps } from '../plan/ops';
import {
  OPPOSITE_VIEW,
  VIEW_DIRS,
  offsetOf,
  orbitOffset,
  oppositeOffset,
  orthoHalfHeight,
  sphericalOf,
  viewAt,
  wrapPi,
  type ViewName,
} from '../render/viewPresets';
import type { Projection, Studio } from '../render/studio';
import { useStudio } from '../state/store';
import { viewportApi } from './viewportApi';
import { useViewState } from './viewState';

/** The camera may not dip under the floor — unless it already did (a Top/Bottom
 * preset or a step below the horizon), so leaving a view never snaps the camera. */
const HORIZON = Math.PI * 0.49;
/** Blender's view snaps take about this long. */
const SNAP_S = 0.25;

type Deps = {
  studio: Studio;
  controls: OrbitControls;
  /** helper controls follow the render camera (TransformControls' picking) */
  onCameraChange?: (camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) => void;
};

export type ViewControls = {
  snapTo(view: ViewName): void;
  setProjection(p: Projection): void;
  toggleProjection(): void;
  /** Orbit by degrees around the target; up > 0 rises toward Top. */
  orbit(dAzDeg: number, dUpDeg: number): void;
  /** Numpad 9: the view from the opposite side. */
  flip(): void;
  /** Re-apply the stored projection when the Build view comes back. */
  applyProjection(): void;
  /** Per-frame transition step, driven by the viewport render loop. */
  update(dt: number): void;
  dispose(): void;
};

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export function createViewControls(deps: Deps): ViewControls {
  const { studio, controls } = deps;
  let anim: { from: { az: number; pol: number; dist: number }; dAz: number; toPol: number; t: number } | null = null;

  const offset = () => controls.object.position.clone().sub(controls.target);

  const syncPolarLimit = () => {
    const { pol } = sphericalOf(offset());
    controls.maxPolarAngle = useViewState.getState().view !== 'user' || pol > HORIZON + 0.02 ? Math.PI : HORIZON;
  };

  const renameView = () => useViewState.setState({ view: viewAt(offset()) });

  const stopAnim = () => {
    anim = null;
  };

  const snapTo = (view: ViewName) => {
    const from = sphericalOf(offset());
    const d = VIEW_DIRS[view];
    const pol = Math.acos(d[1]);
    // Top/Bottom keep the current azimuth so orbiting continues where it was
    const az = pol === 0 || pol === Math.PI ? from.az : Math.atan2(d[0], d[2]);
    anim = { from, dAz: wrapPi(az - from.az), toPol: pol, t: 0 };
    useViewState.setState({ view });
    controls.maxPolarAngle = Math.PI; // the transition may pass the floor horizon
  };

  const orbit = (dAzDeg: number, dUpDeg: number) => {
    stopAnim();
    const rad = Math.PI / 180;
    controls.object.position.copy(controls.target).add(orbitOffset(offset(), dAzDeg * rad, dUpDeg * rad, 0, Math.PI));
    controls.update();
    renameView();
    syncPolarLimit();
  };

  const flip = () => {
    const cur = useViewState.getState().view;
    if (cur !== 'user') return snapTo(OPPOSITE_VIEW[cur]);
    stopAnim();
    controls.object.position.copy(controls.target).add(oppositeOffset(offset()));
    controls.update();
    renameView();
    syncPolarLimit();
  };

  const activate = (p: Projection) => {
    if (studio.projection === p) {
      useViewState.setState({ projection: p });
      return;
    }
    if (p === 'ortho') {
      const dist = Math.max(studio.perspective.position.distanceTo(controls.target), 1);
      studio.setOrthoHeight(orthoHalfHeight(studio.perspective.fov, dist) * 2);
      studio.ortho.zoom = 1;
      studio.ortho.position.copy(studio.perspective.position);
      studio.ortho.quaternion.copy(studio.perspective.quaternion);
    } else {
      studio.perspective.position.copy(studio.ortho.position);
      studio.perspective.quaternion.copy(studio.ortho.quaternion);
    }
    studio.setProjection(p);
    controls.object = studio.camera;
    controls.update();
    deps.onCameraChange?.(studio.camera);
    useViewState.setState({ projection: p });
  };

  const toggleProjection = () => activate(useViewState.getState().projection === 'ortho' ? 'perspective' : 'ortho');

  const applyProjection = () => {
    if (studio.projection !== useViewState.getState().projection) activate(useViewState.getState().projection);
  };

  const update = (dt: number) => {
    if (!anim) return;
    anim.t += dt;
    const u = easeInOutCubic(clamp01(anim.t / SNAP_S));
    const az = anim.from.az + anim.dAz * u;
    const pol = THREE.MathUtils.lerp(anim.from.pol, anim.toPol, u);
    controls.object.position.copy(controls.target).add(offsetOf(az, pol, anim.from.dist));
    controls.update();
    if (anim && anim.t >= SNAP_S) {
      anim = null;
      syncPolarLimit();
    }
  };

  const frameSelection = () => {
    const s = useStudio.getState();
    if (s.selection.model === s.editingModel && s.selection.ids.length) s.requestFocus(s.selection.ids);
  };

  /** Local view: only the selected pieces (Numpad /). Leaving restores what was hidden. */
  const toggleLocalView = () => {
    const s = useStudio.getState();
    const vs = useViewState.getState();
    if (vs.local) {
      s.showAll();
      if (vs.savedModel === s.editingModel && vs.savedHidden.length) s.hide(vs.savedHidden);
      useViewState.setState({ local: false, savedHidden: [], savedModel: '' });
      return;
    }
    if (s.selection.model !== s.editingModel || !s.selection.ids.length) return;
    const all = modelSteps(s.plan, s.editingModel).flatMap((st) => st.pieces.map((p) => p.id).filter((x): x is string => !!x));
    useViewState.setState({ local: true, savedHidden: [...(s.hidden[s.editingModel] ?? [])], savedModel: s.editingModel });
    s.isolate(s.selection.ids, all);
  };

  const onKey = (e: KeyboardEvent) => {
    if (useStudio.getState().mode !== 'edit' || isTyping(e.target) || e.altKey) return;
    const take = () => {
      e.preventDefault();
      // handled here first: the app's own handler must not also see Numpad . and /
      e.stopImmediatePropagation();
    };
    // Blender's numpad views; the number row works too, with Ctrl for the opposites
    switch (e.key) {
      case '1':
        if (!e.metaKey) {
          take();
          snapTo(e.ctrlKey ? 'back' : 'front');
        }
        return;
      case '3':
        if (!e.metaKey) {
          take();
          snapTo(e.ctrlKey ? 'left' : 'right');
        }
        return;
      case '7':
        if (!e.metaKey) {
          take();
          snapTo(e.ctrlKey ? 'bottom' : 'top');
        }
        return;
      case '5':
        if (!e.ctrlKey && !e.metaKey) {
          take();
          toggleProjection();
        }
        return;
      case '4':
        if (!e.ctrlKey && !e.metaKey) {
          take();
          orbit(-15, 0);
        }
        return;
      case '6':
        if (!e.ctrlKey && !e.metaKey) {
          take();
          orbit(15, 0);
        }
        return;
      case '8':
        if (!e.ctrlKey && !e.metaKey) {
          take();
          orbit(0, 15);
        }
        return;
      case '2':
        if (!e.ctrlKey && !e.metaKey) {
          take();
          orbit(0, -15);
        }
        return;
      case '9':
        if (!e.ctrlKey && !e.metaKey) {
          take();
          flip();
        }
        return;
    }
    if (e.ctrlKey || e.metaKey) return; // the app's Cmd/Ctrl combos (undo, duplicate) stay untouched
    if (e.code === 'NumpadDecimal') {
      take();
      frameSelection();
      return;
    }
    if (e.code === 'NumpadSlash') {
      take();
      toggleLocalView();
      return;
    }
    if (e.key === 'Home') {
      take();
      viewportApi.fit();
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 1) return;
    // Shift+middle pans; plain and Ctrl+middle keep OrbitControls' zoom
    controls.mouseButtons.MIDDLE = e.shiftKey ? THREE.MOUSE.PAN : THREE.MOUSE.DOLLY;
  };

  const onStart = () => stopAnim();
  const onEnd = () => {
    renameView();
    syncPolarLimit();
  };

  window.addEventListener('keydown', onKey);
  // capture phase: the mapping must be set before OrbitControls reads its buttons
  window.addEventListener('pointerdown', onPointerDown, true);
  controls.addEventListener('start', onStart);
  controls.addEventListener('end', onEnd);
  // ortho zoom to 0 or ∞ degenerates the frustum
  controls.minZoom = 0.05;
  controls.maxZoom = 80;
  syncPolarLimit();

  return {
    snapTo,
    setProjection: activate,
    toggleProjection,
    orbit,
    flip,
    applyProjection,
    update,
    dispose() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown, true);
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('end', onEnd);
    },
  };
}
