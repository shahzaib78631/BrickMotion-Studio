import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { findItem, moveItems } from '../plan/ops';
import { shiftOnFloor } from '../plan/pieceActions';
import { aroundPivot, transformPlanItems } from '../plan/gizmo';
import type { ANode } from '../model/assemble';
import { dragDelta } from '../state/drag';
import { isSub } from '../plan/types';
import { markers, sameSpot, sceneSpot, storedSpot, sceneOffset, planOffset, spotOfRef, type SpotRef } from '../plan/assemblySpots';
import { SPOT_DRAG_TYPE, draggedSpot } from './AssemblyPanel';
import { SpotMarkers } from './spotMarkers';
import { createStudio, worldBox } from '../render/studio';
import { transformBox } from '../model/assemble';
import { selectionForHit } from '../plan/groups';
import { createSubmodel } from '../plan/createSubmodel';
import { modelPlacement, sourceEditDelta, viewPlacement } from './modelPlacement';
import { NewSubmodelDialog } from './NewSubmodelDialog';
import { runCommand } from '../state/editing';
import { commandForKey } from '../state/keymap';
import { useStudio } from '../state/store';
import { metricsOf } from '../state/partService';
import { modelSteps } from '../plan/ops';
import { posedBounds, stepPoses, timelineStep } from '../model/stepLayout';
import { poseAt, spotTransform, type Timeline } from '../anim/timeline';
import { worldBox3 } from '../anim/camera';
import { stepAt } from '../anim/partClips';
import { advancePlayback, usePlayback } from '../state/playback';
import { soundSnaps } from '../audio/snapSound';
import { useAppSettings } from '../state/appSettings';
import type { ModelState } from '../state/useModel';
import { viewportApi } from './viewportApi';
import { ContextMenu, type ContextItem } from './ContextMenu';
import { emptyMenuItems, pieceMenuItems } from './PieceMenu';
import { NavGizmo } from './NavGizmo';
import { ViewLabel, ViewMenu } from './ViewMenu';
import { createViewControls } from './viewControls';
import { frameBox } from '../render/viewPresets';
import { Ic } from './icons';

/** Whether the camera sees all of `box` (its eight corners inside the view). */
function inView(camera: THREE.Camera, box: THREE.Box3): boolean {
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    if (!frustum.containsPoint(p)) return false;
  }
  return true;
}

function frame(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, controls: OrbitControls, box: THREE.Box3) {
  frameBox(camera, controls, box, (h) => viewportApi.studio?.setOrthoHeight(h));
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export function Viewport({ model, timeline = null }: { model: ModelState; timeline?: Timeline | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const framed = useRef(false);
  const lastShownPlacement = useRef('');
  /** the model the Build view is following the timeline of (null: not following) */
  const followFor = useRef<string | null>(null);
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const currentStep = useStudio((s) => s.currentStep);
  const selection = useStudio((s) => s.selection);
  const focus = useStudio((s) => s.focus);
  const mode = useStudio((s) => s.mode);
  const tool = useStudio((s) => s.tool);
  const spotSel = useStudio((s) => s.spot);
  const gizmoEnabled = useStudio((s) => s.gizmoEnabled);
  const gizmoMode = useStudio((s) => s.gizmoMode);
  const stepView = useStudio((s) => s.stepView);
  const hiddenIds = useStudio((s) => s.hidden[s.editingModel]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[]; label: string } | null>(null);
  const [submodelDialog, setSubmodelDialog] = useState<{ model: string; ids: string[] } | null>(null);
  const follow = usePlayback((s) => s.follow);
  /**
   * Placing pieces (the Move tool, or the gizmo with something selected): show every
   * piece where it really is, so the handles sit on the piece they move. The animation
   * pose at the playhead has pieces waiting elsewhere on the staging table.
   */
  const placing = mode === 'edit' && (tool === 'move' || (gizmoEnabled && selection.model === editingModel && selection.ids.length > 0));
  /** the Build view shows the build animation at the playhead, with the editor's own camera */
  const engaged = mode === 'edit' && follow && !!timeline && !placing;
  /** what the render loop needs while engaged: the timeline and the pose at a time */
  const live = useRef<{ tl: Timeline; pose: (t: number) => (key: string) => THREE.Matrix4 | null; dirty: boolean; override?: Map<string, THREE.Matrix4> } | null>(null);
  const studioLook = useAppSettings((s) => s.studioLook);
  const edgeLines = useAppSettings((s) => s.edgeLines);
  const linearColors = useAppSettings((s) => s.linearColors);
  const gizmoRef = useRef<{ controls: TransformControls; proxy: THREE.Object3D } | null>(null);
  const draggingGizmo = useRef(false);
  const readoutRef = useRef<HTMLDivElement>(null);
  const origin = useRef(new THREE.Vector3());
  const gizmoPress = useRef(false);
  /** the floor markers of the Assembly tab (Build view only) */
  const markersRef = useRef<SpotMarkers | null>(null);
  /** the spot a marker drag started on, and its facing, kept while dragging */
  const spotDrag = useRef<{ ref: SpotRef; angle: number; pending: import('../plan/types').AssemblySpot | null } | null>(null);
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const initialNodes = useRef<ANode[]>([]);
  const initialIds = useRef<string[]>([]);
  const initialModel = useRef('');
  const modelRef = useRef(model);
  modelRef.current = model;

  /** Draw a live, editor-only ghost without editing the plan or starting a worker.
   * The result is persisted once, at pointer release. */
  const previewSpot = (ref: SpotRef, candidate: import('../plan/types').AssemblySpot) => {
    const state = useStudio.getState();
    const assembled = modelRef.current.assembly;
    const spot = sceneSpot(state.plan, assembled.bounds, ref, candidate);
    const data = markers(state.plan, assembled, timelineRef.current).map((m) =>
      sameSpot(m.ref, ref) ? { ...m, centre: [spot.x * 20, spot.z * 20] as [number, number], angle: spot.angle, placed: true } : m);
    const ground = timelineRef.current?.ground ?? assembled.bounds?.max[1] ?? 0;
    markersRef.current?.update(data, ref, -ground / 20);
  };

  // mount: studio, controls, render loop, resize
  useEffect(() => {
    const canvas = canvasRef.current!;
    const studio = createStudio(canvas);
    const controls = new OrbitControls(studio.camera, canvas);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.target.set(0, 0, 0);
    studio.camera.position.set(18, 22, 30);
    viewportApi.studio = studio;
    viewportApi.controls = controls;

    // TransformControls' helper is not a brick. Its proxy is never exported.
    const proxy = new THREE.Object3D();
    studio.scene.add(proxy);
    // Assembly-spot markers live in the editor scene only, never in preview or export.
    const spotMarkers = new SpotMarkers();
    studio.scene.add(spotMarkers.group);
    markersRef.current = spotMarkers;
    const transform = new TransformControls(studio.camera, canvas);
    transform.setSize(0.86);
    transform.setSpace('world');
    // 15° steps (90° is a few steps away, not one twitch of the mouse); hold Shift to turn freely
    const ROT_SNAP = THREE.MathUtils.degToRad(15);
    transform.setRotationSnap(ROT_SNAP);
    const onShift = (e: KeyboardEvent) => {
      if (e.key === 'Shift') transform.setRotationSnap(e.type === 'keydown' ? null : ROT_SNAP);
    };
    window.addEventListener('keydown', onShift);
    window.addEventListener('keyup', onShift);
    transform.setScaleSnap(0.1);
    transform.setTranslationSnap(null); // X/Z studs and Y plates have different snap units
    studio.scene.add(transform.getHelper());
    transform.enabled = false;
    gizmoRef.current = { controls: transform, proxy };
    // Blender-style view presets: the keyboard handler, ortho toggle and the
    // camera the nav gizmo and view menu drive. It must exist before the
    // editor's own key handler so Numpad . and / never double-fire.
    viewportApi.views = createViewControls({
      studio,
      controls,
      onCameraChange: (cam) => {
        transform.camera = cam;
      },
    });
    let lastTransform = '';
    transform.addEventListener('dragging-changed', (ev) => {
      const active = !!ev.value;
      draggingGizmo.current = active;
      controls.enabled = !active && useStudio.getState().mode === 'edit';
      if (active) {
        lastTransform = '';
        const current = useStudio.getState();
        origin.current.copy(proxy.position);
        if (current.selection.model === current.editingModel && current.selection.ids.length) {
          initialNodes.current = modelRef.current.view.nodes;
          initialIds.current = [...current.selection.ids];
          initialModel.current = current.editingModel;
        } else if (current.spot) {
          // the gizmo drives a floor marker, not bricks
          initialNodes.current = [];
          initialIds.current = [];
          const chosen = spotOfRef(current.plan, current.spot);
          const shown = chosen && sceneSpot(current.plan, modelRef.current.assembly.bounds, current.spot, chosen);
          spotDrag.current = { ref: current.spot, angle: shown?.angle ?? 0, pending: null };
        } else return;
        if (!spotDrag.current) current.beginGesture();
      } else {
        if (readoutRef.current) readoutRef.current.hidden = true;
        // A spot drag is a single undoable commit. No replanning during motion.
        if (spotDrag.current?.pending) {
          const { ref, pending } = spotDrag.current;
          const state = useStudio.getState();
          state.setSpot(ref, storedSpot(state.plan, modelRef.current.assembly.bounds, ref, pending));
        }
        spotDrag.current = null;
        useStudio.getState().endGesture();
        // A snapped placement may differ from a raw drag by a fraction of a stud.
        // Recenter the handles on the saved piece positions after release.
        const current = useStudio.getState();
        const ids = new Set(current.selection.ids);
        const boxes = modelRef.current.view.instances.filter((inst) => ids.has(inst.key.split('/')[0]));
        if (boxes.length) {
          const bounds = new THREE.Box3();
          const shown = modelPlacement(current.plan, current.editingModel, modelRef.current.assembly);
          boxes.forEach((inst) => bounds.union(worldBox(shown ? transformBox(inst.worldBox, shown) : inst.worldBox)));
          bounds.getCenter(proxy.position);
          proxy.quaternion.identity();
          proxy.scale.setScalar(1);
        }
      }
    });
    transform.addEventListener('objectChange', () => {
      const state = useStudio.getState();
      const original = state.gesture;
      if (!draggingGizmo.current) return;
      if (spotDrag.current) {
        // A marker stays on the floor: translate is X/Z in whole studs, rotate is about Y only.
        const ref = spotDrag.current.ref;
        if (state.gizmoMode === 'rotate') {
          const deg = Math.round(-THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(proxy.quaternion, 'YXZ').y) * 100) / 100;
          const sig = `r${deg}`;
          if (sig === lastTransform) return;
          lastTransform = sig;
          const prev = spotDrag.current.pending ?? sceneSpot(state.plan, modelRef.current.assembly.bounds, ref, spotOfRef(state.plan, ref)!);
          spotDrag.current.pending = { ...prev, angle: deg };
          previewSpot(ref, storedSpot(state.plan, modelRef.current.assembly.bounds, ref, spotDrag.current.pending));
          if (readoutRef.current) {
            readoutRef.current.textContent = `Rotate Y  ${deg < 0 ? '−' : ''}${Math.abs(deg)}°`;
            readoutRef.current.hidden = false;
          }
        } else {
          const x = Math.round(proxy.position.x), z = Math.round(-proxy.position.z);
          const sig = `t${x},${z}`;
          if (sig === lastTransform) return;
          lastTransform = sig;
          spotDrag.current.pending = { x, z, angle: spotDrag.current.angle };
          previewSpot(ref, storedSpot(state.plan, modelRef.current.assembly.bounds, ref, spotDrag.current.pending));
        }
        return;
      }
      if (!original || !initialNodes.current.length) return;
      const currentMode = state.gizmoMode;
      let delta: THREE.Matrix4;
      if (currentMode === 'translate') {
        const move = proxy.position.clone().sub(origin.current);
        // World units: 1 stud = 1; one plate is 8/20 of a world unit.
        const dx = Math.round(move.x), dy = Math.round(move.y / 0.4) * 0.4, dz = Math.round(move.z);
        delta = new THREE.Matrix4().makeTranslation(dx, dy, dz);
      } else if (currentMode === 'rotate') {
        // round off float noise so 90° steps land exactly square
        const q = proxy.quaternion;
        const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
        const axis = new THREE.Vector3(q.x, q.y, q.z);
        if (axis.lengthSq() > 1e-12) axis.normalize().multiplyScalar(Math.sign(q.w) || 1);
        const deg = Math.round(THREE.MathUtils.radToDeg(angle) * 100) / 100;
        const rot = axis.lengthSq() > 1e-12 ? new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(deg)) : new THREE.Matrix4();
        delta = aroundPivot(rot, origin.current);
        const main = Math.abs(axis.x) > Math.abs(axis.y) && Math.abs(axis.x) > Math.abs(axis.z) ? ['X', axis.x] as const : Math.abs(axis.z) > Math.abs(axis.y) ? ['Z', axis.z] as const : ['Y', axis.y] as const;
        if (readoutRef.current) {
          readoutRef.current.textContent = `Rotate ${main[0]}  ${main[1] < 0 ? '−' : ''}${Math.round(deg)}°`;
          readoutRef.current.hidden = false;
        }
      } else {
        // Free scaling stores an LDraw matrix. This changes LEGO part dimensions,
        // so the UI requires an explicit switch to Scale mode.
        const scale = new THREE.Vector3(
          THREE.MathUtils.clamp(proxy.scale.x, 0.25, 4),
          THREE.MathUtils.clamp(proxy.scale.y, 0.25, 4),
          THREE.MathUtils.clamp(proxy.scale.z, 0.25, 4),
        );
        delta = aroundPivot(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z), origin.current);
      }
      const signature = delta.elements.map((n) => Math.round(n * 10000)).join(',');
      if (signature === lastTransform) return;
      lastTransform = signature;
      const shown = modelPlacement(state.plan, initialModel.current, modelRef.current.assembly);
      const next = transformPlanItems(original, initialModel.current, initialIds.current, initialNodes.current, sourceEditDelta(delta, shown));
      useStudio.getState().apply(() => next);
    });
    let raf = 0;
    let last = performance.now();
    let shownT = -1;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (useStudio.getState().mode === 'edit') {
        const run = live.current;
        if (run) {
          // play / scrub in the Build view: the same animation as the preview, our camera
          const wasPlaying = usePlayback.getState().playing;
          const t = advancePlayback(dt, run.tl.duration);
          soundSnaps(run.tl, t, wasPlaying, useAppSettings.getState().snapSound);
          if (t !== shownT || run.dirty) {
            const at = run.pose(t);
            const over = run.override;
            studio.bricks.setMatrices(over?.size ? (k) => over.get(k) ?? at(k) : at);
            shownT = t;
            run.dirty = false;
            // the step card and Steps panel follow the step being built
            const step = stepAt(run.tl, t);
            if (step !== null && useStudio.getState().currentStep !== step) useStudio.setState({ currentStep: step });
          }
        }
        viewportApi.views?.update(dt);
        controls.update();
        studio.render();
      }
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(() => {
      const r = wrapRef.current!.getBoundingClientRect();
      studio.setSize(Math.max(1, r.width), Math.max(1, r.height));
    });
    ro.observe(wrapRef.current!);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onShift);
      window.removeEventListener('keyup', onShift);
      transform.detach();
      studio.scene.remove(transform.getHelper());
      transform.dispose();
      studio.scene.remove(proxy);
      spotMarkers.dispose();
      studio.scene.remove(spotMarkers.group);
      markersRef.current = null;
      gizmoRef.current = null;
      viewportApi.views?.dispose();
      viewportApi.views = null;
      controls.dispose();
      studio.dispose();
      viewportApi.studio = null;
      viewportApi.controls = null;
    };
  }, []);

  // Video and live viewer use the same lighting preset. A changed preset is
  // applied to the EXISTING WebGL scene, never recreating the renderer.
  useEffect(() => {
    viewportApi.studio?.setLook?.(studioLook);
  }, [studioLook]);
  useEffect(() => {
    viewportApi.studio?.setRenderOptions?.({ edges: edgeLines, linearColors });
  }, [edgeLines, linearColors]);

  // Attach / hide the gizmo when selection or mode changes. Do not reset it
  // midway through a drag, even though the plan re-renders on every snap.
  useEffect(() => {
    const entry = gizmoRef.current;
    if (!entry || draggingGizmo.current) return;
    const { controls: transform, proxy } = entry;
    const ids = new Set(selection.model === editingModel ? selection.ids : []);
    const boxes = model.view.instances.filter((inst) => ids.has(inst.key.split('/')[0]));
    const chosen = spotSel && !editingModel ? spotOfRef(plan, spotSel) : null;
    const spot = chosen && spotSel ? sceneSpot(plan, model.assembly.bounds, spotSel, chosen) : null;
    if (mode === 'edit' && gizmoEnabled && spot && !boxes.length) {
      // A selected spot is a planar X/Z object; rotate exposes only the Y ring.
      const y = -(timeline?.ground ?? model.assembly.bounds?.max[1] ?? 0) / 20;
      proxy.position.set(spot.x, y, -spot.z);
      proxy.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -THREE.MathUtils.degToRad(spot.angle));
      proxy.scale.setScalar(1);
      transform.setMode(gizmoMode === 'rotate' ? 'rotate' : 'translate');
      transform.showX = gizmoMode !== 'rotate';
      transform.showZ = gizmoMode !== 'rotate';
      transform.showY = gizmoMode === 'rotate';
      transform.enabled = true;
      transform.attach(proxy);
      return;
    }
    transform.showX = true;
    transform.showY = true;
    transform.showZ = true;
    if (mode !== 'edit' || !gizmoEnabled || !boxes.length) {
      transform.enabled = false;
      transform.detach();
      return;
    }
    const bounds = new THREE.Box3();
    const shown = modelPlacement(plan, editingModel, model.assembly);
    boxes.forEach((inst) => bounds.union(worldBox(shown ? transformBox(inst.worldBox, shown) : inst.worldBox)));
    bounds.getCenter(proxy.position);
    proxy.quaternion.identity();
    proxy.scale.setScalar(1);
    transform.setMode(gizmoMode);
    transform.enabled = true;
    transform.attach(proxy);
  }, [selection, editingModel, model.view, gizmoEnabled, gizmoMode, mode, spotSel, plan, timeline]);

  // Assembly-spot markers: Build view only, for the whole set (never in preview or export).
  useEffect(() => {
    const spotMarkers = markersRef.current;
    if (!spotMarkers) return;
    if (mode !== 'edit' || editingModel !== '' || !model.ready) spotMarkers.clear();
    else spotMarkers.update(markers(plan, model.assembly, timeline), spotSel, -(timeline?.ground ?? model.assembly.bounds?.max[1] ?? 0) / 20);
  }, [plan, model.assembly, model.ready, timeline, mode, editingModel, spotSel]);

  // which top-level step each top-level item belongs to
  const topStep = useMemo(() => new Map(model.view.nodes.map((n) => [n.itemId, n.step])), [model.view]);
  const hiddenSet = useMemo(() => new Set(hiddenIds ?? []), [hiddenIds]);
  /** every piece the Build view draws: hidden pieces left out */
  const drawn = useMemo(
    () => (hiddenSet.size ? model.view.instances.filter((i) => !hiddenSet.has(i.key.split('/')[0])) : model.view.instances),
    [model.view, hiddenSet],
  );
  const visible = useMemo(
    () => (currentStep === null ? drawn : drawn.filter((i) => (topStep.get(i.key.split('/')[0]) ?? 0) <= currentStep)),
    [drawn, currentStep, topStep],
  );

  // a new project or submodel gets re-framed (declared before the instances
  // effect so the reset happens first in the same commit)
  useEffect(() => {
    framed.current = false;
  }, [plan.name, editingModel]);

  // While a step is selected its new parts can be shown separated from the model
  // (laid out on the floor, as the video stages them) or exploded above it.
  // Once the build animation is planned, the step uses it: parts wait where the video
  // stages them and fly in along the same collision-safe paths as the Preview.
  const planned = useMemo(
    () => (currentStep === null || !timeline ? null : timelineStep(model.view, currentStep, timeline)),
    [model.view, currentStep, timeline],
  );
  const laidOut = useStudio((s) => s.laidOut);
  const poses = useMemo(() => {
    if (placing) return new Map<string, THREE.Matrix4>();
    if (currentStep === null) return laidOut ? stepPoses(model.view, 'all', 'laidout') : new Map<string, THREE.Matrix4>();
    if (stepView === 'separated' && planned) return planned.poses;
    return stepPoses(model.view, currentStep, stepView);
  }, [model.view, currentStep, stepView, planned, placing, laidOut]);

  // Placement only affects the editor's *static* view. Animation tracks have already
  // had their root transform applied by the planner, and must never receive it twice.
  const editorPlacement = useMemo(() => modelPlacement(plan, editingModel, model.assembly),
    [plan.showModelAtSpot, plan.assemblySpot, editingModel, model.assembly]);
  const alreadyPlanned = !!(currentStep !== null && stepView === 'separated' && planned && !placing);
  const shownPoses = useMemo(() => {
    if (!editorPlacement) return poses;
    const positioned = new Map<string, THREE.Matrix4>();
    for (const inst of visible) {
      const prior = poses.get(inst.key);
      // A separated-step timeline pose already includes the main-spot transform.
      positioned.set(inst.key, prior && alreadyPlanned ? prior : editorPlacement.clone().multiply(prior ?? inst.world));
    }
    return positioned;
  }, [poses, visible, editorPlacement, alreadyPlanned]);

  // Following the timeline: every piece, posed as the animation has it at the playhead.
  // Pieces edited since the timeline was planned show where they are now (a move shows
  // at once; the replanned animation takes over a moment later).
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio || !engaged || !timeline) {
      live.current = null;
      followFor.current = null;
      return;
    }
    // only when following starts (or another model opens) — never after an edit
    const starting = followFor.current !== editingModel;
    followFor.current = editingModel;
    const tl = timeline;
    const byKey = new Map(model.view.instances.map((i) => [i.key, i]));
    const changed = new Set<string>();
    // Root assembly spots move the finished model without editing the LDraw
    // source matrices. Compare against that *expected* final pose, otherwise
    // every brick is mistaken for a live edit and drawn at its old position.
    const S = !editingModel && plan.assemblySpot && model.assembly.bounds
      ? spotTransform(plan.assemblySpot, model.assembly.bounds) : null;
    const expected = (inst: (typeof model.view.instances)[number]) => S ? S.clone().multiply(inst.world) : inst.world;
    for (const inst of model.view.instances) {
      const tr = tl.tracks.get(inst.key);
      const final = expected(inst);
      if (!tr || tr.final.elements.some((v, k) => Math.abs(v - final.elements[k]) > 1e-3)) changed.add(inst.key);
    }
    const pose = (t: number) => {
      const at = poseAt(tl, t);
      return (key: string) => {
        const inst = byKey.get(key);
        if (!inst) return null;
        if (!changed.has(key)) return at(key);
        // new since the plan: show it placed; edited: placed once the animation has it built
        if (!tl.tracks.has(key)) return expected(inst);
        return at(key) ? expected(inst) : null;
      };
    };
    studio.bricks.setInstances(drawn);
    const scene = worldBox3(tl.sceneBox);
    if (model.view.bounds) scene.union(worldBox(model.view.bounds));
    studio.fitTo(scene, -tl.ground / 20);
    // Keep the user's camera, unless it can't see where this build happens (e.g. it was
    // close in on the assembled model, with the waiting pieces out of frame).
    if (viewportApi.controls && (!framed.current || (starting && !inView(studio.camera, scene)))) {
      frame(studio.camera, viewportApi.controls, scene);
      framed.current = true;
    }
    live.current = { tl, pose, dirty: true };
  }, [engaged, timeline, model.view, model.assembly.bounds, plan.assemblySpot, editingModel, drawn]);

  // instances
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio || mode !== 'edit' || engaged) return;
    studio.bricks.setInstances(visible);
    // setInstances resets the GPU matrices; always supply the visible pose when
    // the preview is enabled, including with no step or animation selected.
    if (shownPoses.size) {
      const originals = new Map(visible.map((i) => [i.key, i.world]));
      studio.bricks.setMatrices((k) => shownPoses.get(k) ?? originals.get(k) ?? null);
    }
    const b = shownPoses.size ? posedBounds(visible, shownPoses, (p) => metricsOf(p).body) : model.view.bounds;
    const box = b ? worldBox(b) : new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 1, 5));
    // Include the installed model when staging a step for consistent lighting.
    const built = poses.size ? (editorPlacement && model.view.bounds
      ? transformBox(model.view.bounds, editorPlacement)
      : posedBounds(visible, new Map(), (p) => metricsOf(p).body)) : null;
    const lit = built ? box.clone().union(worldBox(built)) : box;
    studio.fitTo(lit, b ? -b.max[1] / 20 : 0);
    const placementKey = editorPlacement?.elements.map(n => n.toFixed(4)).join(',') ?? '';
    const placementChanged = placementKey !== lastShownPlacement.current;
    lastShownPlacement.current = placementKey;
    if (b && viewportApi.controls && (!framed.current ||
      (placementChanged && editorPlacement && !inView(studio.camera, box)))) {
      // A newly dropped spot may be well outside the current camera. Only
      // refit on a *placement change*, never as the user intentionally zooms.
      frame(studio.camera, viewportApi.controls, box);
      framed.current = true;
    }
  }, [visible, model.view, mode, poses, shownPoses, editorPlacement, engaged]);

  // the preview drives the camera itself
  useEffect(() => {
    if (viewportApi.controls) viewportApi.controls.enabled = mode === 'edit';
    // the preview renders through the perspective camera; restore the editor's own projection
    if (mode === 'edit') viewportApi.views?.applyProjection();
  }, [mode]);

  // highlights
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio || mode !== 'edit') return;
    const shown = engaged ? drawn : visible;
    const sel = new Set(selection.model === editingModel ? selection.ids : []);
    studio.bricks.setHighlight(new Set(shown.filter((i) => sel.has(i.key.split('/')[0])).map((i) => i.key)), 'select');
    const warnIds = new Set(model.warnings.flatMap((w) => w.itemIds));
    studio.bricks.setHighlight(new Set(shown.filter((i) => warnIds.has(i.itemId) || warnIds.has(i.key.split('/')[0])).map((i) => i.key)), 'warn');
  }, [selection, model.warnings, visible, editingModel, mode, engaged, model.view, drawn]);

  // focus requests
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio || !viewportApi.controls || !focus.ids.length) return;
    const ids = new Set(focus.ids);
    const boxes = model.view.instances.filter((i) => ids.has(i.itemId) || ids.has(i.key.split('/')[0]));
    if (!boxes.length) return;
    const box = new THREE.Box3();
    const shown = modelPlacement(useStudio.getState().plan, useStudio.getState().editingModel, model.assembly);
    for (const i of boxes) box.union(worldBox(shown ? transformBox(i.worldBox, shown) : i.worldBox));
    frame(studio.camera, viewportApi.controls, box);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.tick]);

  // keyboard
  const fitAll = () => fitAllRef.current();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || useStudio.getState().mode !== 'edit') return;
      if (e.key.toLowerCase() === 'g' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const state = useStudio.getState();
        state.setGizmo(!state.gizmoEnabled);
        return;
      }
      if (e.key === 'Escape') return useStudio.getState().select([]);
      // H hides the selection, Shift+H shows every hidden piece again
      if (e.key.toLowerCase() === 'h' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const state = useStudio.getState();
        if (e.shiftKey) return state.showAll();
        if (state.selection.model === state.editingModel && state.selection.ids.length) state.hide(state.selection.ids);
        return;
      }
      // , and . step through the build (like Previous / Next step); / shows every step
      if ((e.key === ',' || e.key === '.' || e.key === '/') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const st = useStudio.getState();
        const count = modelSteps(st.plan, st.editingModel).length;
        if (!count || e.key === '/') return st.setCurrentStep(null);
        const cur = st.currentStep;
        if (e.key === ',') st.setCurrentStep(cur === null ? count - 1 : Math.max(0, cur - 1));
        else st.setCurrentStep(cur === null ? 0 : Math.min(count - 1, cur + 1));
        return;
      }
      if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) return fitAll();
      // A selects every piece you can see (hidden ones stay out); Alt+A clears, like Blender
      if ((e.code === 'KeyA' || e.key.toLowerCase() === 'a') && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        e.preventDefault();
        const st = useStudio.getState();
        if (e.altKey) return st.select([]);
        const hidden = new Set(st.hidden[st.editingModel] ?? []);
        st.select(modelSteps(st.plan, st.editingModel).flatMap((step) => step.pieces.flatMap((i) => (i.id && !hidden.has(i.id) ? [i.id] : []))));
        return;
      }
      const az = viewportApi.controls ? (viewportApi.controls.getAzimuthalAngle() * 180) / Math.PI : 0;
      const cmd = commandForKey(e, az);
      if (!cmd) return;
      e.preventDefault();
      runCommand(cmd);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const fitAllRef = useRef(() => {});
  viewportApi.fit = () => fitAllRef.current();
  fitAllRef.current = () => {
    // frame what is on screen: a step's parts laid out on the floor and where they end up
    const b = shownPoses.size ? posedBounds(visible, shownPoses, (p) => metricsOf(p).body) : model.view.bounds;
    if (!b || !viewportApi.studio || !viewportApi.controls) return;
    const box = worldBox(b);
    const built = poses.size ? (editorPlacement && model.view.bounds
      ? transformBox(model.view.bounds, editorPlacement)
      : posedBounds(visible, new Map(), (p) => metricsOf(p).body)) : null;
    if (built) box.union(worldBox(built));
    frame(viewportApi.studio.camera, viewportApi.controls, box);
  };

  const rayAt = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, viewportApi.studio!.camera);
    return ray;
  };
  const pickAt = (e: { clientX: number; clientY: number }): string | null => (viewportApi.studio ? viewportApi.studio.bricks.pick(rayAt(e)) : null);
  /** The assembly marker under the pointer, if the Build view draws them. */
  const pickSpotAt = (e: { clientX: number; clientY: number }): SpotRef | null => (markersRef.current && viewportApi.studio ? markersRef.current.pick(rayAt(e)) : null);
  /** The floor plane the viewport currently uses (world Y), for dropping and dragging markers. */
  const floorPlane = () => new THREE.Plane(new THREE.Vector3(0, 1, 0), (timeline?.ground ?? model.assembly.bounds?.max[1] ?? 0) / 20);

  // Assembly markers (Build view, main model): dragging one slides it on X/Z, in whole studs.
  const startSpotDrag = (e: React.PointerEvent, ref: SpotRef): boolean => {
    const s = st();
    if (s.mode !== 'edit' || e.button !== 0 || !viewportApi.studio) return false;
    const spot = spotOfRef(s.plan, ref);
    const shown = markers(s.plan, model.assembly, timeline).find((m) => sameSpot(m.ref, ref));
    const angle = spot?.angle ?? 0;
    const plane = floorPlane();
    const hit = (ev: { clientX: number; clientY: number }) => rayAt(ev).ray.intersectPlane(plane, new THREE.Vector3());
    const start = hit(e);
    if (!start) return false;
    if (!sameSpot(s.spot, ref)) s.selectSpot(ref);
    if (viewportApi.controls) viewportApi.controls.enabled = false;
    const originalX = (shown?.centre[0] ?? start.x * 20) / 20;
    const originalZ = (shown?.centre[1] ?? -start.z * 20) / 20;
    let pending: import('../plan/types').AssemblySpot | null = null;
    const move = (ev: PointerEvent) => {
      const p = hit(ev);
      if (!p) return;
      const moved = { x: originalX + p.x - start.x, z: originalZ - (p.z - start.z), angle: shown?.angle ?? angle };
      const local = storedSpot(st().plan, modelRef.current.assembly.bounds, ref, moved);
      const next = { x: Math.round(local.x), z: Math.round(local.z), angle };
      if (pending && pending.x === next.x && pending.z === next.z) return;
      pending = next;
      previewSpot(ref, next);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (commit && pending) st().setSpot(ref, pending);
      else markersRef.current?.update(markers(st().plan, modelRef.current.assembly, timelineRef.current), st().spot,
        -(timelineRef.current?.ground ?? modelRef.current.assembly.bounds?.max[1] ?? 0) / 20);
      if (viewportApi.controls) viewportApi.controls.enabled = st().mode === 'edit';
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return true;
  };

  // Move tool: dragging a piece slides the selection over the floor in whole studs (one undo step).
  // Runs in the capture phase so the orbit controls are switched off before they see the press.
  const startDrag = (e: React.PointerEvent) => {
    // overlay UI (menus, the nav gizmo) must never pick or drag a brick behind it
    if (e.target !== canvasRef.current) return;
    // a marker under the pointer wins over the bricks behind it (a gizmo handle still has priority)
    if (!(gizmoEnabled && gizmoRef.current?.controls.axis)) {
      const ref = pickSpotAt(e);
      if (ref && startSpotDrag(e, ref)) return;
    }
    if (startFloorDrag(e)) return;
    const s = st();
    if (s.mode !== 'edit' || s.tool !== 'move' || (s.gizmoEnabled && s.selection.ids.length > 0) || e.button !== 0 || !viewportApi.studio) return;
    const key = pickAt(e);
    if (!key) return;
    const id = key.split('/')[0];
    const ids = s.selection.model === s.editingModel && s.selection.ids.includes(id)
      ? s.selection.ids : selectionForHit(s.plan, s.editingModel, id, e.altKey);
    if (!(s.selection.model === s.editingModel && ids.every(i => s.selection.ids.includes(i)))) s.select(ids);
    const inst = model.view.instances.find((i) => i.key === key);
    const placement = modelPlacement(s.plan, s.editingModel, model.assembly);
    const top = inst ? -(placement ? transformBox(inst.worldBox, placement) : inst.worldBox).min[1] / 20 : 0;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -top);
    const hit = (ev: { clientX: number; clientY: number }) => rayAt(ev).ray.intersectPlane(plane, new THREE.Vector3());
    const start = hit(e);
    if (!start) return;
    if (viewportApi.controls) viewportApi.controls.enabled = false;
    s.beginGesture();
    const model0 = s.editingModel;
    let last = '0,0,0';
    const move = (ev: PointerEvent) => {
      const p = hit(ev);
      const base = st().gesture;
      if (!p || !base) return;
      const displayed = placement ? viewPlacement(placement).clone().invert() : null;
      const d = dragDelta(displayed ? start.clone().applyMatrix4(displayed) : start,
        displayed ? p.clone().applyMatrix4(displayed) : p);
      const sig = `${d.x},${d.y},${d.z}`;
      if (sig === last) return;
      last = sig;
      st().apply(() => moveItems(base, model0, ids, d));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      st().endGesture();
      if (viewportApi.controls) viewportApi.controls.enabled = st().mode === 'edit';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /**
   * Build view, following the animation: dragging a piece that is still waiting on
   * the floor moves where it waits, in whole studs. A wheel waiting with its tyre on
   * moves as one. Letting go saves the offset on the piece and the animation is
   * planned again.
   */
  const startFloorDrag = (e: React.PointerEvent): boolean => {
    const run = live.current;
    const s = st();
    if (!run || s.mode !== 'edit' || s.tool === 'move' || e.button !== 0 || e.shiftKey || !viewportApi.studio) return false;
    const key = pickAt(e);
    const tl = run.tl;
    const tr = key ? tl.tracks.get(key) : undefined;
    const t = usePlayback.getState().t;
    if (!key || !tr?.moves.length || t < tr.appear || t >= tl.units[tr.moves[0].unit].start) return false;
    const unit = tr.moves[0].unit;
    const root = tl.units[unit].keys[0] ?? key;
    const group = [...tl.tracks].filter(([, o]) => o.moves[0]?.unit === unit).map(([k, o]) => [k, o.floor] as const);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), tl.ground / 20);
    const hit = (ev: { clientX: number; clientY: number }) => rayAt(ev).ray.intersectPlane(plane, new THREE.Vector3());
    const start = hit(e);
    if (!start) return false;
    if (viewportApi.controls) viewportApi.controls.enabled = false;
    const model0 = s.editingModel;
    let d: [number, number] = [0, 0];
    const move = (ev: PointerEvent) => {
      const p = hit(ev);
      if (!p || !live.current) return;
      // studs along LDraw x and z (world z is LDraw −z)
      const worldDelta: [number, number] = [p.x - start.x, -(p.z - start.z)];
      // Drag in the visible scene but store in the unrotated model frame.
      // Otherwise a waiting brick jumps to another location on replanning.
      const local = model0 === '' ? planOffset(st().plan, worldDelta) : worldDelta;
      const next: [number, number] = [Math.round(local[0]) || 0, Math.round(local[1]) || 0];
      if (next[0] === d[0] && next[1] === d[1]) return;
      d = next;
      const world = model0 === '' ? sceneOffset(st().plan, d) : d;
      const shift = new THREE.Matrix4().makeTranslation(world[0] * 20, 0, world[1] * 20);
      live.current.override = new Map(group.map(([k, floor]) => [k, shift.clone().multiply(floor)]));
      live.current.dirty = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (viewportApi.controls) viewportApi.controls.enabled = st().mode === 'edit';
      if (!d[0] && !d[1]) {
        if (live.current) ((live.current.override = undefined), (live.current.dirty = true));
        return;
      }
      const next = shiftOnFloor(st().plan, model0, root, d);
      if (next) st().apply(() => next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return true;
  };

  const down = useRef({ x: 0, y: 0 });
  const closeMenu = useRef(() => setMenu(null)).current;
  const rightDown = useRef<{ x: number; y: number } | null>(null);
  const st = useStudio.getState;
  /** Right-click without dragging (a right-drag pans the view): the piece's menu, or the floor's. */
  const openMenu = (e: { clientX: number; clientY: number }) => {
    const s = st();
    if (s.mode !== 'edit') return;
    const ref = pickSpotAt(e);
    if (ref) {
      const placed = !!spotOfRef(s.plan, ref);
      s.selectSpot(ref);
      setMenu({
        x: e.clientX, y: e.clientY, label: 'Assembly spot',
        items: [
          { icon: 'spot', label: placed ? 'Reset to auto' : 'Placed automatically', disabled: !placed, onClick: () => st().setSpot(ref, null) },
        ],
      });
      return;
    }
    const key = pickAt(e);
    if (!key) return setMenu({ x: e.clientX, y: e.clientY, items: emptyMenuItems((ids) => setSubmodelDialog({ model: s.editingModel, ids })), label: 'View' });
    const id = key.split('/')[0];
    const ids = s.selection.model === s.editingModel && s.selection.ids.includes(id)
      ? s.selection.ids : selectionForHit(s.plan, s.editingModel, id);
    if (!(s.selection.model === s.editingModel && ids.every(i => s.selection.ids.includes(i)))) s.select(ids);
    const items = pieceMenuItems(ids, (chosen) => setSubmodelDialog({ model: s.editingModel, ids: chosen }));
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items, label: 'Piece' });
  };
  return (
    <div
      className={`viewport ${tool === 'move' && mode === 'edit' ? 'bm-move' : ''}`}
      ref={wrapRef}
      onPointerDownCapture={startDrag}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(SPOT_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        const ref = draggedSpot(e);
        if (!ref || !viewportApi.studio) return;
        e.preventDefault();
        const p = rayAt(e).ray.intersectPlane(floorPlane(), new THREE.Vector3());
        if (!p) return;
        const prev = spotOfRef(st().plan, ref);
        st().selectSpot(ref);
        // snap to the stud grid; keep the facing from the previous drop (0° on the first)
        const local = storedSpot(st().plan, modelRef.current.assembly.bounds, ref, { x: p.x, z: -p.z, angle: 0 });
        st().setSpot(ref, { x: Math.round(local.x), z: Math.round(local.z), angle: prev?.angle ?? 0 });
      }}
    >
      <canvas
        ref={canvasRef}
        onContextMenu={(e) => e.preventDefault()}
        onPointerUp={(e) => {
          const start = rightDown.current;
          rightDown.current = null;
          if (e.button === 2 && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) <= 4) openMenu(e);
        }}
        onPointerDown={(e) => {
          if (e.button === 2) rightDown.current = { x: e.clientX, y: e.clientY };
          down.current = { x: e.clientX, y: e.clientY };
          // TransformControls can clear its hovered axis on pointer-up.
          // Remember whether this press began on a handle so the subsequent
          // canvas click cannot accidentally deselect the transformed brick.
          gizmoPress.current = !!(st().gizmoEnabled && gizmoRef.current?.controls.axis);
        }}
        onClick={(e) => {
          if (gizmoPress.current) { gizmoPress.current = false; return; }
          if (st().mode !== 'edit') return;
          if (Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) > 4) return;
          // Clicking an axis must not clear the selection because a brick ray missed.
          if (gizmoRef.current?.controls.axis && st().gizmoEnabled) return;
          const mark = pickSpotAt(e);
          if (mark) { st().selectSpot(mark); return; }
          const key = pickAt(e);
          if (key) {
            const state = st();
            st().select(selectionForHit(state.plan, state.editingModel, key.split('/')[0], e.altKey), e.shiftKey);
          }
          else if (!e.shiftKey) st().select([]);
        }}
        onDoubleClick={(e) => {
          if (st().mode !== 'edit') return;
          const key = pickAt(e);
          if (!key) return;
          const found = findItem(st().plan, st().editingModel, key.split('/')[0]);
          if (found && isSub(found.item)) st().setEditingModel(found.item.submodel);
        }}
      />
      {!model.ready && <div className="overlay-note">Loading parts…</div>}
      {mode === 'edit' && hiddenSet.size > 0 && (
        <div className="bm-hidden-chip" role="status">
          <Ic name="eyeOff" />
          {hiddenSet.size} hidden
          <button onClick={() => st().showAll()} title="Show every hidden piece (⇧H)">Show all</button>
        </div>
      )}
      {mode === 'edit' && laidOut && currentStep === null && (
        <div className="bm-hidden-chip bm-laidout-chip" role="status">
          <Ic name="steps" />
          All parts laid out
          <button onClick={() => st().setLaidOut(false)} title="Put every piece back in the model">Put back</button>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} label={menu.label} onClose={closeMenu} />}
      {submodelDialog && <NewSubmodelDialog plan={plan} count={submodelDialog.ids.length}
        onClose={() => setSubmodelDialog(null)}
        onCreate={(name) => {
          const state = st();
          if (state.editingModel !== submodelDialog.model || !model.ready) return false;
          const result = createSubmodel(state.plan, submodelDialog.model, submodelDialog.ids, model.view.nodes, name);
          if (!result) return false;
          state.apply(() => result.plan);
          state.select([result.referenceId]);
          state.setCurrentStep(null);
          return true;
        }} />}

      <ViewMenu />
      <NavGizmo />
      <div className="bm-gizmo-readout" ref={readoutRef} hidden aria-live="polite" />
      <ViewLabel />
      {model.ready && placing && follow && !!timeline && (
        <div className="overlay-note">Showing the model as built while you place pieces. {tool === 'move' ? 'Switch to the Select tool' : 'Press Esc'} to go back to the animation.</div>
      )}
      {model.ready && model.view.instances.length === 0 && mode === 'edit' && (
        <div className="overlay-note">Empty floor — add parts from the left, import a file, or generate a set with AI.</div>
      )}
    </div>
  );
}
