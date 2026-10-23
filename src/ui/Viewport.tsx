import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { findItem, moveItems } from '../plan/ops';
import { aroundPivot, transformPlanItems } from '../plan/gizmo';
import type { ANode } from '../model/assemble';
import { dragDelta } from '../state/drag';
import { isSub } from '../plan/types';
import { createStudio, worldBox } from '../render/studio';
import { runCommand } from '../state/editing';
import { commandForKey } from '../state/keymap';
import { useStudio } from '../state/store';
import { metricsOf } from '../state/partService';
import { modelSteps } from '../plan/ops';
import { posedBounds, stepPoses, timelineStep } from '../model/stepLayout';
import { poseAt, type Timeline } from '../anim/timeline';
import { worldBox3 } from '../anim/camera';
import { stepAt } from '../anim/partClips';
import { advancePlayback, usePlayback } from '../state/playback';
import { soundSnaps } from '../audio/snapSound';
import { useAppSettings } from '../state/appSettings';
import type { ModelState } from '../state/useModel';
import { viewportApi } from './viewportApi';

/** Whether the camera sees all of `box` (its eight corners inside the view). */
function inView(camera: THREE.PerspectiveCamera, box: THREE.Box3): boolean {
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    if (!frustum.containsPoint(p)) return false;
  }
  return true;
}

function frame(camera: THREE.PerspectiveCamera, controls: OrbitControls, box: THREE.Box3) {
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 3);
  const fov = (camera.fov * Math.PI) / 180;
  const dist = (r / Math.sin(Math.min(fov, fov * camera.aspect) / 2)) * 1.15;
  const dir = camera.position.clone().sub(controls.target).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(dir.multiplyScalar(dist));
  controls.update();
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export function Viewport({ model, timeline = null }: { model: ModelState; timeline?: Timeline | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const framed = useRef(false);
  /** the model the Build view is following the timeline of (null: not following) */
  const followFor = useRef<string | null>(null);
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const currentStep = useStudio((s) => s.currentStep);
  const selection = useStudio((s) => s.selection);
  const focus = useStudio((s) => s.focus);
  const mode = useStudio((s) => s.mode);
  const tool = useStudio((s) => s.tool);
  const gizmoEnabled = useStudio((s) => s.gizmoEnabled);
  const gizmoMode = useStudio((s) => s.gizmoMode);
  const stepView = useStudio((s) => s.stepView);
  const follow = usePlayback((s) => s.follow);
  /** the Build view shows the build animation at the playhead, with the editor's own camera */
  const engaged = mode === 'edit' && follow && !!timeline;
  /** what the render loop needs while engaged: the timeline and the pose at a time */
  const live = useRef<{ tl: Timeline; pose: (t: number) => (key: string) => THREE.Matrix4 | null; dirty: boolean } | null>(null);
  const studioLook = useAppSettings((s) => s.studioLook);
  const edgeLines = useAppSettings((s) => s.edgeLines);
  const linearColors = useAppSettings((s) => s.linearColors);
  const gizmoRef = useRef<{ controls: TransformControls; proxy: THREE.Object3D } | null>(null);
  const draggingGizmo = useRef(false);
  const origin = useRef(new THREE.Vector3());
  const gizmoPress = useRef(false);
  const initialNodes = useRef<ANode[]>([]);
  const initialIds = useRef<string[]>([]);
  const initialModel = useRef('');
  const modelRef = useRef(model);
  modelRef.current = model;

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
    const transform = new TransformControls(studio.camera, canvas);
    transform.setSize(0.86);
    transform.setSpace('world');
    transform.setRotationSnap(Math.PI / 2); // LEGO right-angle rotations
    transform.setScaleSnap(0.1);
    transform.setTranslationSnap(null); // X/Z studs and Y plates have different snap units
    studio.scene.add(transform.getHelper());
    transform.enabled = false;
    gizmoRef.current = { controls: transform, proxy };
    let lastTransform = '';
    transform.addEventListener('dragging-changed', (ev) => {
      const active = !!ev.value;
      draggingGizmo.current = active;
      controls.enabled = !active && useStudio.getState().mode === 'edit';
      if (active) {
        lastTransform = '';
        const current = useStudio.getState();
        if (current.selection.model !== current.editingModel || !current.selection.ids.length) return;
        initialNodes.current = modelRef.current.view.nodes;
        initialIds.current = [...current.selection.ids];
        initialModel.current = current.editingModel;
        origin.current.copy(proxy.position);
        current.beginGesture();
      } else {
        useStudio.getState().endGesture();
        // A snapped placement may differ from a raw drag by a fraction of a stud.
        // Recenter the handles on the saved piece positions after release.
        const current = useStudio.getState();
        const ids = new Set(current.selection.ids);
        const boxes = modelRef.current.view.instances.filter((inst) => ids.has(inst.key.split('/')[0]));
        if (boxes.length) {
          const bounds = new THREE.Box3();
          boxes.forEach((inst) => bounds.union(worldBox(inst.worldBox)));
          bounds.getCenter(proxy.position);
          proxy.quaternion.identity();
          proxy.scale.setScalar(1);
        }
      }
    });
    transform.addEventListener('objectChange', () => {
      const original = useStudio.getState().gesture;
      if (!draggingGizmo.current || !original || !initialNodes.current.length) return;
      const currentMode = useStudio.getState().gizmoMode;
      let delta: THREE.Matrix4;
      if (currentMode === 'translate') {
        const move = proxy.position.clone().sub(origin.current);
        // World units: 1 stud = 1; one plate is 8/20 of a world unit.
        const dx = Math.round(move.x), dy = Math.round(move.y / 0.4) * 0.4, dz = Math.round(move.z);
        delta = new THREE.Matrix4().makeTranslation(dx, dy, dz);
      } else if (currentMode === 'rotate') {
        delta = aroundPivot(new THREE.Matrix4().makeRotationFromQuaternion(proxy.quaternion), origin.current);
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
      const next = transformPlanItems(original, initialModel.current, initialIds.current, initialNodes.current, delta);
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
            studio.bricks.setMatrices(run.pose(t));
            shownT = t;
            run.dirty = false;
            // the step card and Steps panel follow the step being built
            const step = stepAt(run.tl, t);
            if (step !== null && useStudio.getState().currentStep !== step) useStudio.setState({ currentStep: step });
          }
        }
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
      transform.detach();
      studio.scene.remove(transform.getHelper());
      transform.dispose();
      studio.scene.remove(proxy);
      gizmoRef.current = null;
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
    if (mode !== 'edit' || !gizmoEnabled || !boxes.length) {
      transform.enabled = false;
      transform.detach();
      return;
    }
    const bounds = new THREE.Box3();
    boxes.forEach((inst) => bounds.union(worldBox(inst.worldBox)));
    bounds.getCenter(proxy.position);
    proxy.quaternion.identity();
    proxy.scale.setScalar(1);
    transform.setMode(gizmoMode);
    transform.enabled = true;
    transform.attach(proxy);
  }, [selection, editingModel, model.view, gizmoEnabled, gizmoMode, mode]);

  // which top-level step each top-level item belongs to
  const topStep = useMemo(() => new Map(model.view.nodes.map((n) => [n.itemId, n.step])), [model.view]);
  const visible = useMemo(
    () => (currentStep === null ? model.view.instances : model.view.instances.filter((i) => (topStep.get(i.key.split('/')[0]) ?? 0) <= currentStep)),
    [model.view, currentStep, topStep],
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
  const poses = useMemo(() => {
    if (currentStep === null) return new Map<string, THREE.Matrix4>();
    if (stepView === 'separated' && planned) return planned.poses;
    return stepPoses(model.view, currentStep, stepView);
  }, [model.view, currentStep, stepView, planned]);

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
    for (const inst of model.view.instances) {
      const tr = tl.tracks.get(inst.key);
      if (!tr || tr.final.elements.some((v, k) => Math.abs(v - inst.world.elements[k]) > 1e-3)) changed.add(inst.key);
    }
    const pose = (t: number) => {
      const at = poseAt(tl, t);
      return (key: string) => {
        const inst = byKey.get(key);
        if (!inst) return null;
        if (!changed.has(key)) return at(key);
        // new since the plan: show it placed; edited: placed once the animation has it built
        if (!tl.tracks.has(key)) return inst.world;
        return at(key) ? inst.world : null;
      };
    };
    studio.bricks.setInstances(model.view.instances);
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
  }, [engaged, timeline, model.view, editingModel]);

  // instances
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio || mode !== 'edit' || engaged) return;
    studio.bricks.setInstances(visible);
    if (poses.size) {
      const world = new Map(visible.map((i) => [i.key, i.world]));
      studio.bricks.setMatrices((k) => poses.get(k) ?? world.get(k) ?? null);
    }
    const b = poses.size ? posedBounds(visible, poses, (p) => metricsOf(p).body) : model.view.bounds;
    const box = b ? worldBox(b) : new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 1, 5));
    // light and shadows cover both where the step's parts wait and where they end up
    // (playing the step moves them in place), so no shadow gets cut off
    const built = poses.size ? posedBounds(visible, new Map(), (p) => metricsOf(p).body) : null;
    const lit = built ? box.clone().union(worldBox(built)) : box;
    studio.fitTo(lit, b ? -b.max[1] / 20 : 0);
    if (b && !framed.current && viewportApi.controls) {
      frame(studio.camera, viewportApi.controls, box);
      framed.current = true;
    }
  }, [visible, model.view, mode, poses, engaged]);

  // the preview drives the camera itself
  useEffect(() => {
    if (viewportApi.controls) viewportApi.controls.enabled = mode === 'edit';
  }, [mode]);

  // highlights
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio || mode !== 'edit') return;
    const shown = engaged ? model.view.instances : visible;
    const sel = new Set(selection.model === editingModel ? selection.ids : []);
    studio.bricks.setHighlight(new Set(shown.filter((i) => sel.has(i.key.split('/')[0])).map((i) => i.key)), 'select');
    const warnIds = new Set(model.warnings.flatMap((w) => w.itemIds));
    studio.bricks.setHighlight(new Set(shown.filter((i) => warnIds.has(i.itemId) || warnIds.has(i.key.split('/')[0])).map((i) => i.key)), 'warn');
  }, [selection, model.warnings, visible, editingModel, mode, engaged, model.view]);

  // focus requests
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio || !viewportApi.controls || !focus.ids.length) return;
    const ids = new Set(focus.ids);
    const boxes = model.view.instances.filter((i) => ids.has(i.itemId) || ids.has(i.key.split('/')[0]));
    if (!boxes.length) return;
    const box = new THREE.Box3();
    for (const i of boxes) box.union(worldBox(i.worldBox));
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
    const b = poses.size ? posedBounds(visible, poses, (p) => metricsOf(p).body) : model.view.bounds;
    if (!b || !viewportApi.studio || !viewportApi.controls) return;
    const box = worldBox(b);
    const built = poses.size ? posedBounds(visible, new Map(), (p) => metricsOf(p).body) : null;
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

  // Move tool: dragging a piece slides the selection over the floor in whole studs (one undo step).
  // Runs in the capture phase so the orbit controls are switched off before they see the press.
  const startDrag = (e: React.PointerEvent) => {
    const s = st();
    if (s.mode !== 'edit' || s.tool !== 'move' || (s.gizmoEnabled && s.selection.ids.length > 0) || e.button !== 0 || !viewportApi.studio) return;
    const key = pickAt(e);
    if (!key) return;
    const id = key.split('/')[0];
    const ids = s.selection.model === s.editingModel && s.selection.ids.includes(id) ? s.selection.ids : [id];
    if (ids.length === 1 && ids[0] === id) s.select(ids);
    const inst = model.view.instances.find((i) => i.key === key);
    const top = inst ? -inst.worldBox.min[1] / 20 : 0;
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
      const d = dragDelta(start, p);
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

  const down = useRef({ x: 0, y: 0 });
  const st = useStudio.getState;
  return (
    <div className={`viewport ${tool === 'move' && mode === 'edit' ? 'bm-move' : ''}`} ref={wrapRef} onPointerDownCapture={startDrag}>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => {
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
          const key = pickAt(e);
          if (key) st().select([key.split('/')[0]], e.shiftKey);
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
      {model.ready && model.view.instances.length === 0 && mode === 'edit' && (
        <div className="overlay-note">Empty floor — add parts from the left, import a file, or generate a set with AI.</div>
      )}
    </div>
  );
}
