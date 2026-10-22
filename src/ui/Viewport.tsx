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
import type { ModelState } from '../state/useModel';
import { viewportApi } from './viewportApi';

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

export function Viewport({ model }: { model: ModelState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const framed = useRef(false);
  const plan = useStudio((s) => s.plan);
  const editingModel = useStudio((s) => s.editingModel);
  const currentStep = useStudio((s) => s.currentStep);
  const selection = useStudio((s) => s.selection);
  const focus = useStudio((s) => s.focus);
  const mode = useStudio((s) => s.mode);
  const tool = useStudio((s) => s.tool);
  const gizmoEnabled = useStudio((s) => s.gizmoEnabled);
  const gizmoMode = useStudio((s) => s.gizmoMode);
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
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (useStudio.getState().mode === 'edit') {
        controls.update();
        studio.render();
      }
    };
    loop();
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

  // instances
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio || mode !== 'edit') return;
    studio.bricks.setInstances(visible);
    const b = model.view.bounds;
    const box = b ? worldBox(b) : new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 1, 5));
    studio.fitTo(box, b ? -b.max[1] / 20 : 0);
    if (b && !framed.current && viewportApi.controls) {
      frame(studio.camera, viewportApi.controls, box);
      framed.current = true;
    }
  }, [visible, model.view, mode]);

  // a new project or submodel gets re-framed
  useEffect(() => {
    framed.current = false;
  }, [plan.name, editingModel]);

  // the preview drives the camera itself
  useEffect(() => {
    if (viewportApi.controls) viewportApi.controls.enabled = mode === 'edit';
  }, [mode]);

  // highlights
  useEffect(() => {
    const studio = viewportApi.studio;
    if (!studio || mode !== 'edit') return;
    const sel = new Set(selection.model === editingModel ? selection.ids : []);
    studio.bricks.setHighlight(new Set(visible.filter((i) => sel.has(i.key.split('/')[0])).map((i) => i.key)), 'select');
    const warnIds = new Set(model.warnings.flatMap((w) => w.itemIds));
    studio.bricks.setHighlight(new Set(visible.filter((i) => warnIds.has(i.itemId) || warnIds.has(i.key.split('/')[0])).map((i) => i.key)), 'warn');
  }, [selection, model.warnings, visible, editingModel, mode]);

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
    const b = model.view.bounds;
    if (b && viewportApi.studio && viewportApi.controls) frame(viewportApi.studio.camera, viewportApi.controls, worldBox(b));
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
