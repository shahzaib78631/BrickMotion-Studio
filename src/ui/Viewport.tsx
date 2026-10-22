import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { findItem } from '../plan/ops';
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
      controls.dispose();
      studio.dispose();
      viewportApi.studio = null;
      viewportApi.controls = null;
    };
  }, []);

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

  const pickAt = (e: React.MouseEvent): string | null => {
    const studio = viewportApi.studio;
    if (!studio) return null;
    const r = canvasRef.current!.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, studio.camera);
    return studio.bricks.pick(ray);
  };

  const down = useRef({ x: 0, y: 0 });
  const st = useStudio.getState;
  return (
    <div className="viewport" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY })}
        onClick={(e) => {
          if (st().mode !== 'edit') return;
          if (Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) > 4) return;
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
