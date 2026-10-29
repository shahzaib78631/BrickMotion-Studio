import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { findItem, moveItems } from '../plan/ops';
import { setAssemblySpot, setSubmodelBuildSpot, shiftOnFloor } from '../plan/pieceActions';
import { aroundPivot, transformPlanItems } from '../plan/gizmo';
import type { ANode, Instance } from '../model/assemble';
import { dragDelta } from '../state/drag';
import { studSnapper, type SnapPart, type StudSnapper } from '../plan/studSnap';
import { isSub } from '../plan/types';
import { isMainSpot, markers, sameSpot, sceneSpot, storedSpot, sceneOffset, planOffset, spotOfRef, type SpotRef } from '../plan/assemblySpots';
import { SPOT_DRAG_TYPE, draggedSpot } from './AssemblyPanel';
import { SpotMarkers } from './spotMarkers';
import { createStudio, worldBox } from '../render/studio';
import { selectionForHit } from '../plan/groups';
import { createSubmodel } from '../plan/createSubmodel';
import { instancePlacements, itemPlacement, placedBox, placedMatrix, sourceEditDelta, viewPlacement } from './modelPlacement';
import { NewSubmodelDialog } from './NewSubmodelDialog';
import { runCommand } from '../state/editing';
import { commandForKey } from '../state/keymap';
import { useStudio } from '../state/store';
import { metricsOf } from '../state/partService';
import { modelSteps } from '../plan/ops';
import { posedBounds, stepPoses, timelineStep } from '../model/stepLayout';
import { poseAt, spotTransform, type Timeline } from '../anim/timeline';
import { cameraAt, heroAround, worldBox3, type CamPose } from '../anim/camera';
import { stepAt } from '../anim/partClips';
import { advancePlayback, usePlayback } from '../state/playback';
import { animationOf, insertKeys, valuesAt, type ChannelValues, type KeyUpdate } from '../anim/keyframes';
import { makeKeyframePose } from '../anim/keyframePose';
import { advanceKeyframePlayback, useKeyframePlayback } from '../state/keyframePlayback';
import type { Plan, PlanItem } from '../plan/types';
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
import { SceneTools, CameraRegionOverlay } from './SceneTools';
import { useSceneView } from './sceneViewState';
import { createSceneControls } from './sceneControls';
import { cameraFrame, sceneSetupOf } from '../render/sceneSetup';
import { formatAspect } from '../export/formats';

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

/** A drag's stud snapper: the selected items' parts against every other part (LDraw frame). */
function snapperFor(instances: readonly Instance[], ids: readonly string[]): StudSnapper {
  const chosen = new Set(ids);
  const moving: SnapPart[] = [], others: SnapPart[] = [];
  for (const inst of instances) {
    if (inst.placeholder) continue;
    const m = metricsOf(inst.part);
    (chosen.has(inst.key.split('/')[0]) ? moving : others).push({ world: inst.world.elements, body: m.body, studs: m.studs });
  }
  return studSnapper(moving, others);
}

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
  const timelineEditor = useStudio((s) => s.timelineEditor);
  const autoKey = useKeyframePlayback((s) => s.autoKey);
  // Avoid 60 React rerenders/sec while keyframe playback runs. The RAF owns it.
  // Paused frame changes refresh transform handles only when someone scrubs.
  const keyframeAtRest = useKeyframePlayback((s) => s.playing ? -1 : Math.round(s.frame));
  const tool = useStudio((s) => s.tool);
  const spotSel = useStudio((s) => s.spot);
  const gizmoEnabled = useStudio((s) => s.gizmoEnabled);
  const gizmoMode = useStudio((s) => s.gizmoMode);
  const stepView = useStudio((s) => s.stepView);
  const hiddenIds = useStudio((s) => s.hidden[s.editingModel]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextItem[]; label: string } | null>(null);
  const [submodelDialog, setSubmodelDialog] = useState<{ model: string; ids: string[] } | null>(null);
  const follow = usePlayback((s) => s.follow);
  const playing = usePlayback((s) => s.playing);
  /**
   * Placing pieces (the Move tool, or the gizmo with something selected): show every
   * piece where it really is, so the handles sit on the piece they move. The animation
   * pose at the playhead has pieces waiting elsewhere on the staging table.
   */
  const placing = mode === 'edit' && timelineEditor === 'build' && (tool === 'move' || (gizmoEnabled && selection.model === editingModel && selection.ids.length > 0));
  /** the Build view shows the build animation at the playhead, with the editor's own camera */
  const engaged = mode === 'edit' && timelineEditor === 'build' && follow && !!timeline && !placing;
  /** what the render loop needs while engaged: the timeline and the pose at a time */
  const live = useRef<{ tl: Timeline; pose: (t: number) => (key: string) => THREE.Matrix4 | null; dirty: boolean; override?: Map<string, THREE.Matrix4> } | null>(null);
  /** Timeline mode uses a separate, non-destructive matrix sampler. */
  const keyScene = useRef<{ at: (frame: number) => Map<string, THREE.Matrix4 | null>; bases: Map<string, THREE.Matrix4>; dirty: boolean } | null>(null);
  const keyGesture = useRef<{ base: Plan; ids: string[]; model: string; frame: number; values: Map<string, ChannelValues> } | null>(null);
  const studioLook = useAppSettings((s) => s.studioLook);
  const materials = useAppSettings((s) => s.materials);
  const edgeLines = useAppSettings((s) => s.edgeLines);
  const linearColors = useAppSettings((s) => s.linearColors);
  const sceneSetup = useStudio((s) => s.plan.sceneSetup);
  const sceneSelected = useSceneView((s) => s.selectedId);
  const sceneCameraView = useSceneView((s) => s.cameraView);
  const sceneHelpers = useSceneView((s) => s.showHelpers);
  const sceneLock = useSceneView((s) => s.lockCamera);
  const outputFormat = useAppSettings((s) => s.format);
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

  /** Update the static GPU matrices without touching saved LDraw placements,
   * undo history, or the planner. Used while a build spot is being dragged. */
  const previewMatrices = (previewPlan: typeof plan) => {
    if (useStudio.getState().timelineEditor !== 'build') return;
    const state = useStudio.getState();
    if (!state.plan.showModelAtSpot || state.editingModel || state.currentStep !== null || state.laidOut || state.mode !== 'edit') return;
    const studio = viewportApi.studio;
    if (!studio) return;
    const asm = modelRef.current.assembly;
    const placements = instancePlacements(previewPlan, '', asm);
    const instances = new Map(modelRef.current.view.instances.map(inst => [inst.key, inst]));
    studio.bricks.setMatrices(key => {
      const inst = instances.get(key);
      return inst ? placedMatrix(inst, placements) : null;
    });
  };

  /** Drag the floor footprint AND its assembled contents in real time. The
   * candidate is preview-only until pointer release (one undoable plan edit). */
  const previewSpot = (ref: SpotRef, candidate: import('../plan/types').AssemblySpot) => {
    const state = useStudio.getState();
    const assembled = modelRef.current.assembly;
    const spot = sceneSpot(state.plan, assembled.bounds, ref, candidate);
    const data = markers(state.plan, assembled, timelineRef.current).map((m) =>
      sameSpot(m.ref, ref) ? { ...m, centre: [spot.x * 20, spot.z * 20] as [number, number], angle: spot.angle, placed: true } : m);
    const ground = timelineRef.current?.ground ?? assembled.bounds?.max[1] ?? 0;
    markersRef.current?.update(data, ref, -ground / 20);
    const previewPlan = isMainSpot(ref)
      ? setAssemblySpot(state.plan, candidate)
      : setSubmodelBuildSpot(state.plan, ref.model, ref.id, candidate);
    previewMatrices(previewPlan);
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
    viewportApi.frameAspect = () => formatAspect(useAppSettings.getState().format);

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
    viewportApi.scene = createSceneControls(studio, controls, canvas);
    viewportApi.scene.sync(useStudio.getState().plan.sceneSetup);
    const onSceneKey = (e: KeyboardEvent) => {
      if (useStudio.getState().mode !== 'edit' || isTyping(e.target)) return;
      if (e.code === 'Numpad0') {
        if (e.ctrlKey && e.altKey) viewportApi.scene?.alignCamera();
        else if (!e.ctrlKey && !e.altKey && !e.metaKey) viewportApi.scene?.enterCameraView();
        else return;
      } else if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'b' && !e.altKey) {
        if (!useSceneView.getState().cameraView) return;
        useSceneView.setState({ regionTool: true });
      } else if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'b') {
        useStudio.getState().apply((p) => ({ ...p, sceneSetup: { ...sceneSetupOf(p.sceneSetup), region: null } }));
      } else return;
      e.preventDefault(); e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onSceneKey, true);
    let lastTransform = '';
    let gizmoSnap: StudSnapper | null = null;
    transform.addEventListener('dragging-changed', (ev) => {
      const active = !!ev.value;
      gizmoSnap = null;
      draggingGizmo.current = active;
      controls.enabled = !active && useStudio.getState().mode === 'edit';
      if (active) {
        lastTransform = '';
        const current = useStudio.getState();
        origin.current.copy(proxy.position);
        if (current.timelineEditor === 'timeline') {
          if (!useKeyframePlayback.getState().autoKey || !current.selection.ids.length) return;
          useKeyframePlayback.getState().set({ playing: false });
          const at = Math.round(useKeyframePlayback.getState().frame);
          const ids = [...current.selection.ids];
          keyGesture.current = {
            base: current.plan, model: current.editingModel, ids, frame: at,
            values: new Map(ids.map((id) => [id, valuesAt(current.plan.animation, current.editingModel, id, at)])),
          };
          current.beginGesture();
          return;
        }
        if (current.selection.model === current.editingModel && current.selection.ids.length) {
          initialNodes.current = modelRef.current.view.nodes;
          initialIds.current = [...current.selection.ids];
          initialModel.current = current.editingModel;
        } else if (current.spot) {
          // The placed model follows the gizmo immediately, without waiting
          // for the planner. A scrubbed timeline must not override this edit.
          if (current.plan.showModelAtSpot) usePlayback.getState().set({ follow: false, playing: false });
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
        keyGesture.current = null;
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
          const shown = instancePlacements(current.plan, current.editingModel, modelRef.current.assembly);
          if (current.timelineEditor === 'timeline') {
            const at = makeKeyframePose(modelRef.current.view.instances, shown, current.plan.animation, current.editingModel, timelineRef.current)(useKeyframePlayback.getState().frame);
            for (const inst of boxes) {
              const pose = at.get(inst.key);
              if (!pose) bounds.union(worldBox(placedBox(inst, shown)));
              else {
                const shift = pose.clone().multiply(inst.world.clone().invert());
                const box = new THREE.Box3(new THREE.Vector3(...inst.worldBox.min), new THREE.Vector3(...inst.worldBox.max));
                bounds.union(box.applyMatrix4(shift).applyMatrix4(new THREE.Matrix4().makeScale(1 / 20, -1 / 20, -1 / 20)));
              }
            }
          } else boxes.forEach((inst) => bounds.union(worldBox(placedBox(inst, shown))));
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
      const keyed = keyGesture.current;
      if (keyed && state.timelineEditor === 'timeline') {
        const updates: KeyUpdate[] = [];
        for (const id of keyed.ids) {
          const base = keyed.values.get(id)!;
          if (state.gizmoMode === 'translate') {
            const move = proxy.position.clone().sub(origin.current);
            const offsets = { x: Math.round(move.x * 10) / 10, y: Math.round(move.y * 10) / 10, z: Math.round(move.z * 10) / 10 };
            for (const axis of ['x', 'y', 'z'] as const)
              updates.push({ model: keyed.model, target: id, channel: `location.${axis}`, value: Math.round((base[`location.${axis}`] + offsets[axis]) * 1000) / 1000 });
          } else if (state.gizmoMode === 'rotate') {
            const rot = new THREE.Euler().setFromQuaternion(proxy.quaternion, 'XYZ');
            for (const axis of ['x', 'y', 'z'] as const)
              updates.push({ model: keyed.model, target: id, channel: `rotation.${axis}`, value: Math.round((base[`rotation.${axis}`] + THREE.MathUtils.radToDeg(rot[axis])) * 1000) / 1000 });
          } else {
            for (const axis of ['x', 'y', 'z'] as const)
              updates.push({ model: keyed.model, target: id, channel: `scale.${axis}`, value: Math.round(base[`scale.${axis}`] * proxy.scale[axis] * 1000) / 1000 });
          }
        }
        const nextAnimation = insertKeys(animationOf(keyed.base.animation), keyed.frame, updates);
        state.apply((p) => ({ ...p, animation: nextAnimation }));
        return;
      }
      if (state.timelineEditor === 'timeline') return;
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
        // Whole studs, or a half stud when that seats the selection on a stud (jumper plates).
        gizmoSnap ??= snapperFor(modelRef.current.view.instances, initialIds.current);
        const flat = gizmoSnap({ x: move.x, z: -move.z });
        // the seat height applies only while the gizmo is not lifting the part itself
        const lift = Math.round(move.y / 0.4) * 0.4;
        const dx = flat.x, dy = lift || flat.y * 0.4, dz = -flat.z || 0;
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
      const shown = instancePlacements(state.plan, initialModel.current, modelRef.current.assembly);
      // Different selected submodel uses may be previewed at different bays.
      // Conjugate the gizmo delta separately for each authored top-level item,
      // keeping a multi-selection transform visually consistent.
      let next = original;
      for (const id of initialIds.current) {
        const placement = itemPlacement(modelRef.current.view.instances, shown, id);
        next = transformPlanItems(next, initialModel.current, [id], initialNodes.current, sourceEditDelta(delta, placement));
      }
      useStudio.getState().apply(() => next);
    });
    let raf = 0;
    let last = performance.now();
    let shownT = -1;
    let shownKeyFrame = Number.NaN;
    /**
     * The intro and the hero orbit are camera moves, so the Build view plays them. They keep
     * the editor's own zoom and lens though — the shot supplies the direction and the centre,
     * never the distance — and they ease in from wherever the editor camera is, so pressing
     * play never snaps or zooms.
     */
    let shotFrom: { at: number; position: THREE.Vector3; target: THREE.Vector3; radius: number } | null = null;
    const shotAt = (want: CamPose, t: number): CamPose => {
      if (!shotFrom) {
        const position = studio.camera.position.clone();
        const target = controls.target.clone();
        shotFrom = { at: t, position, target, radius: position.distanceTo(target) || 1 };
      }
      const dir = want.position.clone().sub(want.target);
      const pinned = want.target.clone().addScaledVector(dir, shotFrom.radius / (dir.length() || 1));
      const u = Math.min(1, (t - shotFrom.at) / 0.6);
      const k = u * u * (3 - 2 * u);
      return {
        position: shotFrom.position.clone().lerp(pinned, k),
        target: shotFrom.target.clone().lerp(want.target, k),
        fov: want.fov,
      };
    };
    /**
     * Looking through a scene camera (or with camera-frame staging) the build holds that
     * shot, and the hero orbit swings around it — the shot's own distance and lens, so the
     * framing never jumps. `heroBase` is the pose the orbit started from; scrubbing back
     * before the outro puts the camera exactly there again.
     */
    let heroBase: { shot: CamPose; cameraView: boolean } | null = null;
    let heldShot = false;
    // grabbing the view mid-orbit starts from the held shot, never from the orbit
    const onGrab = () => {
      if (!heroBase) return;
      studio.camera.position.copy(heroBase.shot.position);
      studio.camera.lookAt(heroBase.shot.target);
      controls.target.copy(heroBase.shot.target);
      heroBase = null;
    };
    controls.addEventListener('start', onGrab);
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      // The intro establishing shot and the hero orbit are camera moves: play them here
      // too, or pressing play in the Build view shows the poses without the shots.
      let shot: CamPose | null = null;
      if (useStudio.getState().mode === 'edit') {
        if (useStudio.getState().timelineEditor === 'timeline') {
          const scene = keyScene.current;
          if (scene) {
            const a = animationOf(useStudio.getState().plan.animation);
            const atFrame = advanceKeyframePlayback(dt, a.fps, a.startFrame, a.endFrame);
            if (atFrame !== shownKeyFrame || scene.dirty) {
              const poses = scene.at(atFrame);
              studio.bricks.setMatrices((key) => poses.has(key) ? poses.get(key)! : scene.bases.get(key) ?? null);
              scene.dirty = false;
              shownKeyFrame = atFrame;
            }
          }
        }
        const run = live.current;
        if (run) {
          // play / scrub in the Build view: the same animation as the preview
          const wasPlaying = usePlayback.getState().playing;
          const t = advancePlayback(dt, run.tl.duration);
          soundSnaps(run.tl, t, wasPlaying, useAppSettings.getState().snapSound, useAppSettings.getState().sound);
          if (t !== shownT || run.dirty) {
            const at = run.pose(t);
            const over = run.override;
            studio.bricks.setMatrices(over?.size ? (k) => over.get(k) ?? at(k) : at);
            shownT = t;
            run.dirty = false;
            // the step card and Steps panel follow the step being built
            const step = stepAt(run.tl, t);
            if (step !== null && useStudio.getState().currentStep !== step) useStudio.setState({ currentStep: step });
            // The intro shot and the hero orbit are camera moves the video plays, and only
            // they: the build in between stays the editor's own view, so playing never zooms
            // under you. The transport's camera switch turns both off completely.
            const settings = useAppSettings.getState();
            const inHero = t >= run.tl.buildEnd;
            // Camera-frame staging holds its fitted tabletop shot through playback;
            // the procedural intro/hero orbit would otherwise restore a huge
            // old editor radius and make every loose piece tiny again.
            const cameraView = useSceneView.getState().cameraView;
            const holdsShot = cameraView || settings.floorStyle === 'camera-frame';
            const follows = !settings.frameStagingPending && settings.cameraFollowsPlayback !== false;
            if (heroBase && heroBase.cameraView !== cameraView) heroBase = null;
            if (!holdsShot && follows && (inHero || t < run.tl.intro)) {
              const view = useSceneView.getState();
              shot = shotAt(cameraAt(run.tl, t, view.width / Math.max(1, view.height), settings.cameraFraming, settings.camera), t);
            } else if (holdsShot && follows && inHero && run.tl.heroOrbit) {
              shotFrom = null;
              heroBase ??= { cameraView, shot: { position: studio.camera.position.clone(), target: controls.target.clone(), fov: studio.perspective.fov } };
              shot = heroAround(run.tl, heroBase.shot, settings.camera)(t);
              heldShot = true;
            } else {
              shotFrom = null;
              if (heroBase) {
                // back before the outro: the held shot again, exactly
                shot = heroBase.shot;
                heroBase = null;
                heldShot = true;
              }
            }
          }
        }
        viewportApi.views?.update(dt);
        // While the hero orbits a held shot the controls must not see the move as a
        // gesture: with "lock camera to view" that would write the orbit into the camera.
        // They catch up once the camera is back on the held shot.
        if (!heldShot && !heroBase) controls.update();
        if (shot) {
          const active = studio.camera;
          active.position.copy(shot.position);
          active.lookAt(shot.target);
          // keep the editor's orbit behaving around the shot, not the old centre
          controls.target.copy(shot.target);
        }
        if (heldShot && !heroBase) controls.update();
        heldShot = false;
        studio.render(viewportApi.scene?.prepareRender());
      }
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(() => {
      const r = wrapRef.current!.getBoundingClientRect();
      studio.setSize(Math.max(1, r.width), Math.max(1, r.height));
      useSceneView.setState({ width: Math.max(1, r.width), height: Math.max(1, r.height) });
    });
    ro.observe(wrapRef.current!);
    return () => {
      cancelAnimationFrame(raf);
      controls.removeEventListener('start', onGrab);
      ro.disconnect();
      window.removeEventListener('keydown', onShift);
      window.removeEventListener('keyup', onShift);
      window.removeEventListener('keydown', onSceneKey, true);
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
      viewportApi.scene?.dispose();
      viewportApi.scene = null;
      viewportApi.frameAspect = null;
      controls.dispose();
      studio.dispose();
      viewportApi.studio = null;
      viewportApi.controls = null;
    };
  }, []);

  useEffect(() => { viewportApi.scene?.sync(sceneSetup); }, [sceneSetup, sceneSelected, sceneCameraView, sceneHelpers, sceneLock, outputFormat, mode]);

  // Video and live viewer use the same lighting preset. A changed preset is
  // applied to the EXISTING WebGL scene, never recreating the renderer.
  useEffect(() => {
    viewportApi.studio?.setLook?.(studioLook);
  }, [studioLook]);
  useEffect(() => {
    if (materials) viewportApi.studio?.setMaterials?.(materials);
  }, [materials]);
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
    const chosen = timelineEditor === 'build' && spotSel && !editingModel ? spotOfRef(plan, spotSel) : null;
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
    if (sceneSelected || mode !== 'edit' || !gizmoEnabled || !boxes.length || (timelineEditor === 'timeline' && (!autoKey || keyframeAtRest < 0))) {
      transform.enabled = false;
      transform.detach();
      return;
    }
    const bounds = new THREE.Box3();
    const shown = instancePlacements(plan, editingModel, model.assembly);
    if (timelineEditor === 'timeline') {
      const at = makeKeyframePose(model.view.instances, shown, plan.animation, editingModel, timeline)(keyframeAtRest);
      boxes.forEach((inst) => {
        const pose = at.get(inst.key);
        if (!pose) bounds.union(worldBox(placedBox(inst, shown)));
        else {
          const offset = pose.clone().multiply(inst.world.clone().invert());
          const box = new THREE.Box3(new THREE.Vector3(...inst.worldBox.min), new THREE.Vector3(...inst.worldBox.max));
          bounds.union(box.applyMatrix4(offset).applyMatrix4(new THREE.Matrix4().makeScale(1 / 20, -1 / 20, -1 / 20)));
        }
      });
    } else boxes.forEach((inst) => bounds.union(worldBox(placedBox(inst, shown))));
    bounds.getCenter(proxy.position);
    proxy.quaternion.identity();
    proxy.scale.setScalar(1);
    transform.setMode(gizmoMode);
    transform.enabled = true;
    transform.attach(proxy);
  }, [selection, editingModel, model.view, gizmoEnabled, gizmoMode, mode, spotSel, plan, timeline, timelineEditor, autoKey, keyframeAtRest, sceneSelected]);

  // Assembly-spot markers: Build view only, for the whole set (never in preview or export).
  useEffect(() => {
    const spotMarkers = markersRef.current;
    if (!spotMarkers) return;
    if (mode !== 'edit' || timelineEditor !== 'build' || editingModel !== '' || !model.ready) spotMarkers.clear();
    else spotMarkers.update(markers(plan, model.assembly, timeline), spotSel, -(timeline?.ground ?? model.assembly.bounds?.max[1] ?? 0) / 20);
  }, [plan, model.assembly, model.ready, timeline, mode, timelineEditor, editingModel, spotSel]);

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
    if (currentStep === null) return laidOut ? stepPoses(model.view, 'all', 'laidout', metricsOf) : new Map<string, THREE.Matrix4>();
    if (stepView === 'separated' && planned) return planned.poses;
    return stepPoses(model.view, currentStep, stepView, metricsOf);
  }, [model.view, currentStep, stepView, planned, placing, laidOut]);

  // Each submodel use can have an independent workbench transform. Unlike the
  // previous root-only preview, the chosen bay is applied to every descendant
  // brick, even when there is no (or a failed) animation timeline.
  // Timeline poses are ALREADY in their planned positions: never apply the
  // editor-only spot preview to those poses a second time.
  const editorPlacements = useMemo(() => instancePlacements(plan, editingModel, model.assembly),
    [plan, editingModel, model.assembly]);
  // Cache the entire installed-model preview bounds once per placement edit;
  // camera fitting and studio lighting should not rescan every part each frame.
  const finalDisplayedBounds = useMemo(() => {
    if (!editorPlacements.size) return model.view.bounds;
    const finalPoses = new Map(model.view.instances
      .filter((i) => editorPlacements.has(i.key))
      .map((i) => [i.key, placedMatrix(i, editorPlacements)]));
    return posedBounds(model.view.instances, finalPoses, (p) => metricsOf(p).body);
  }, [editorPlacements, model.view]);
  const alreadyPlanned = !!(currentStep !== null && stepView === 'separated' && planned && !placing);
  const shownPoses = useMemo(() => {
    if (!editorPlacements.size) return poses;
    const positioned = new Map<string, THREE.Matrix4>();
    for (const inst of visible) {
      const prior = poses.get(inst.key);
      const delta = editorPlacements.get(inst.key);
      if (prior && alreadyPlanned) positioned.set(inst.key, prior);
      else if (delta) positioned.set(inst.key, delta.clone().multiply(prior ?? inst.world));
      else if (prior) positioned.set(inst.key, prior);
    }
    return positioned;
  }, [poses, visible, editorPlacements, alreadyPlanned]);

  /** Keyframe poses are intentionally independent of planner success. The render loop
   * samples them directly at the active animation frame, without a React rerender. */
  const keyframePose = useMemo(() => makeKeyframePose(visible, editorPlacements, plan.animation, editingModel, timeline),
    [visible, editorPlacements, plan.animation, editingModel, timeline]);
  useEffect(() => {
    if (mode !== 'edit' || timelineEditor !== 'timeline') { keyScene.current = null; return; }
    keyScene.current = {
      at: keyframePose,
      bases: new Map(visible.map((inst) => [inst.key, shownPoses.get(inst.key) ?? inst.world])),
      dirty: true,
    };
  }, [mode, timelineEditor, keyframePose, visible, shownPoses]);

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
    // The user is composing a fixed shot. A newly planned timeline must not
    // invoke the editor's normal automatic Fit (which zoomed away from the shot).
    const holdingFrame = useAppSettings.getState().frameStagingPending ||
      useAppSettings.getState().floorStyle === 'camera-frame';
    if (!holdingFrame && viewportApi.controls && (!framed.current || (starting && !inView(studio.camera, scene)))) {
      frame(studio.camera, viewportApi.controls, scene);
      framed.current = true;
    }
    live.current = { tl, pose, dirty: true };
  }, [engaged, timeline, model.view, model.assembly.bounds, plan.assemblySpot, editingModel, drawn]);

  // Fixed-camera staging NEVER changes camera position or lens on Play.
  // The separate Staging > Fit camera button remains an explicit opt-in.

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
    const built = poses.size ? finalDisplayedBounds : null;
    const lit = built ? box.clone().union(worldBox(built)) : box;
    studio.fitTo(lit, b ? -b.max[1] / 20 : 0);
    // Multiple bricks share one group delta. Only serialize distinct transforms
    // rather than a copy of the same 16 floats for every single brick.
    const placementKey = [...new Set(editorPlacements.values())]
      .map(delta => delta.elements.map(n => n.toFixed(4)).join(',')).join('|');
    const placementChanged = placementKey !== lastShownPlacement.current;
    lastShownPlacement.current = placementKey;
    const holdingFrame = useAppSettings.getState().frameStagingPending ||
      useAppSettings.getState().floorStyle === 'camera-frame';
    if (!holdingFrame && b && viewportApi.controls && (!framed.current ||
      (placementChanged && editorPlacements.size > 0 && !inView(studio.camera, box)))) {
      // A newly dropped spot may be well outside the current camera. Only
      // refit on a *placement change*, never as the user intentionally zooms.
      frame(studio.camera, viewportApi.controls, box);
      framed.current = true;
    }
  }, [visible, model.view, mode, poses, shownPoses, editorPlacements, finalDisplayedBounds, engaged, timelineEditor]);

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
    const shown = instancePlacements(useStudio.getState().plan, useStudio.getState().editingModel, model.assembly);
    for (const i of boxes) box.union(worldBox(placedBox(i, shown)));
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
      // The Dope Sheet owns Delete, arrows, rotation, duplication and undo while
      // animating. Never let the underlying brick-edit shortcuts mutate LDraw
      // geometry when a keyframe operation is intended.
      if (useStudio.getState().timelineEditor === 'timeline') {
        if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey) fitAll();
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
      if (useStudio.getState().timelineEditor === 'build' && (e.key === ',' || e.key === '.' || e.key === '/') && !e.metaKey && !e.ctrlKey) {
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
    const keyframes = useStudio.getState().timelineEditor === 'timeline' && keyScene.current
      ? keyScene.current.at(useKeyframePlayback.getState().frame) : null;
    const combined = keyframes
      ? new Map(visible.map((inst) => [inst.key, keyframes.get(inst.key) ?? placedMatrix(inst, editorPlacements)]))
      : shownPoses;
    const b = combined.size ? posedBounds(visible, combined, (p) => metricsOf(p).body) : model.view.bounds;
    if (!b || !viewportApi.studio || !viewportApi.controls) return;
    const box = worldBox(b);
    const built = poses.size ? finalDisplayedBounds : null;
    if (built) box.union(worldBox(built));
    frame(viewportApi.studio.camera, viewportApi.controls, box);
  };

  const rayAt = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const cameraMode = useSceneView.getState().cameraView;
    const shown = cameraMode ? cameraFrame(r.width, r.height, formatAspect(useAppSettings.getState().format)) : null;
    const rx = e.clientX - r.left - (shown?.x ?? 0);
    const ry = e.clientY - r.top - (shown?.y ?? 0);
    const ndc = new THREE.Vector2((rx / (shown?.width ?? r.width)) * 2 - 1, -(ry / (shown?.height ?? r.height)) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, viewportApi.studio!.camera);
    return ray;
  };
  const pickAt = (e: { clientX: number; clientY: number }): string | null => (viewportApi.studio ? viewportApi.studio.bricks.pick(rayAt(e)) : null);
  /** The assembly marker under the pointer, if the Build view draws them. */
  const pickSpotAt = (e: { clientX: number; clientY: number }): SpotRef | null => (useStudio.getState().timelineEditor === 'build' && markersRef.current && viewportApi.studio ? markersRef.current.pick(rayAt(e)) : null);
  /** The floor plane the viewport currently uses (world Y), for dropping and dragging markers. */
  const floorPlane = () => new THREE.Plane(new THREE.Vector3(0, 1, 0), (timeline?.ground ?? model.assembly.bounds?.max[1] ?? 0) / 20);

  // Assembly markers (Build view, main model): dragging one slides it on X/Z, in whole studs.
  const startSpotDrag = (e: React.PointerEvent, ref: SpotRef): boolean => {
    const s = st();
    if (s.mode !== 'edit' || s.timelineEditor !== 'build' || e.button !== 0 || !viewportApi.studio) return false;
    if (s.plan.showModelAtSpot) usePlayback.getState().set({ follow: false, playing: false });
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
      else {
        markersRef.current?.update(markers(st().plan, modelRef.current.assembly, timelineRef.current), st().spot,
          -(timelineRef.current?.ground ?? modelRef.current.assembly.bounds?.max[1] ?? 0) / 20);
        // Cancellation (Escape/pointercancel) must also restore the bricks, not
        // leave a temporary GPU-only pose until some unrelated state change.
        previewMatrices(st().plan);
      }
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
    if (e.target !== canvasRef.current || viewportApi.scene?.isHandlingPointer()) return;
    if (viewportApi.scene?.pick(rayAt(e))) return;
    if (useSceneView.getState().selectedId) return;
    // a marker under the pointer wins over the bricks behind it (a gizmo handle still has priority)
    if (!(gizmoEnabled && gizmoRef.current?.controls.axis)) {
      const ref = pickSpotAt(e);
      if (ref && startSpotDrag(e, ref)) return;
    }
    if (startFloorDrag(e)) return;
    const s = st();
    if (s.timelineEditor === 'timeline') return;
    if (s.mode !== 'edit' || s.tool !== 'move' || (s.gizmoEnabled && s.selection.ids.length > 0) || e.button !== 0 || !viewportApi.studio) return;
    const key = pickAt(e);
    if (!key) return;
    const id = key.split('/')[0];
    const ids = s.selection.model === s.editingModel && s.selection.ids.includes(id)
      ? s.selection.ids : selectionForHit(s.plan, s.editingModel, id, e.altKey);
    if (!(s.selection.model === s.editingModel && ids.every(i => s.selection.ids.includes(i)))) s.select(ids);
    const inst = model.view.instances.find((i) => i.key === key);
    const placements = instancePlacements(s.plan, s.editingModel, model.assembly);
    const top = inst ? -placedBox(inst, placements).min[1] / 20 : 0;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -top);
    const hit = (ev: { clientX: number; clientY: number }) => rayAt(ev).ray.intersectPlane(plane, new THREE.Vector3());
    const start = hit(e);
    if (!start) return;
    if (viewportApi.controls) viewportApi.controls.enabled = false;
    s.beginGesture();
    const model0 = s.editingModel;
    const snap = snapperFor(model.view.instances, ids);
    const bodyOf = (item: PlanItem) => ('part' in item ? metricsOf(item.part).body : undefined);
    let last = '0,0,0';
    const move = (ev: PointerEvent) => {
      const p = hit(ev);
      const base = st().gesture;
      if (!p || !base) return;
      // A drag in display coordinates must be inverted through the specific
      // placed submodel's yaw. Two selected groups may have different bays.
      const changes = ids.map(id => {
        const placement = itemPlacement(model.view.instances, placements, id);
        const inverse = placement ? viewPlacement(placement).clone().invert() : null;
        const d = dragDelta(inverse ? start.clone().applyMatrix4(inverse) : start,
          inverse ? p.clone().applyMatrix4(inverse) : p, snap);
        return { id, d };
      });
      const sig = changes.map(c => `${c.id}:${c.d.x},${c.d.y},${c.d.z}`).join('|');
      if (sig === last) return;
      last = sig;
      st().apply(() => changes.reduce((next, { id, d }) => moveItems(next, model0, [id], d, bodyOf), base));
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
        if (!ref || useStudio.getState().timelineEditor !== 'build' || !viewportApi.studio) return;
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
          if (st().mode !== 'edit' || viewportApi.scene?.isHandlingPointer()) return;
          if (Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) > 4) return;
          // Clicking an axis must not clear the selection because a brick ray missed.
          if (gizmoRef.current?.controls.axis && st().gizmoEnabled) return;
          const selectedScene = viewportApi.scene?.pick(rayAt(e));
          if (selectedScene) {
            useSceneView.setState({ selectedId: selectedScene, panelOpen: true });
            st().select([]);
            return;
          }
          const mark = pickSpotAt(e);
          if (mark) { st().selectSpot(mark); return; }
          const key = pickAt(e);
          if (key) {
            const state = st();
            st().select(selectionForHit(state.plan, state.editingModel, key.split('/')[0], e.altKey), e.shiftKey);
          }
          else if (!e.shiftKey) {
            st().select([]);
            useSceneView.setState({ selectedId: null });
          }
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
      <SceneTools />
      <CameraRegionOverlay />
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
