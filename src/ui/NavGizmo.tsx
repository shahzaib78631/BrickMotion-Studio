import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { ViewName } from '../render/viewPresets';
import { useStudio } from '../state/store';
import { viewportApi } from './viewportApi';

/** Blender's axis colours: X red, Y green, Z blue. */
const AXES: { dir: THREE.Vector3; color: string; label: string; pos: ViewName; neg: ViewName }[] = [
  { dir: new THREE.Vector3(1, 0, 0), color: '#e5484d', label: 'X', pos: 'right', neg: 'left' },
  { dir: new THREE.Vector3(0, 1, 0), color: '#46a758', label: 'Y', pos: 'top', neg: 'bottom' },
  { dir: new THREE.Vector3(0, 0, 1), color: '#0e7ff1', label: 'Z', pos: 'front', neg: 'back' },
];

const SIZE = 84;
const RADIUS = 30;
const DOT = 8.5;
/** drag further than this and a press becomes an orbit instead of a view snap */
const CLICK_PX = 4;
/** degrees per pixel while dragging */
const DRAG = 0.4;

type End = { x: number; y: number; depth: number; color: string; label: string | null; view: ViewName };

/** The Blender-like navigation gizmo: axis bubbles that rotate with the camera,
 * click to snap to that view, drag to orbit. */
export function NavGizmo() {
  const mode = useStudio((s) => s.mode);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (mode !== 'edit') return;
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    const c = SIZE / 2;

    // world axis endpoints in gizmo space, far ones first so near bubbles draw on top
    const ends = (): End[] | null => {
      const cam = viewportApi.studio?.camera;
      if (!cam) return null;
      cam.updateMatrixWorld();
      const e = cam.matrixWorld.elements;
      const right = new THREE.Vector3(e[0], e[1], e[2]);
      const up = new THREE.Vector3(e[4], e[5], e[6]);
      const fwd = new THREE.Vector3(-e[8], -e[9], -e[10]);
      const out: End[] = [];
      for (const a of AXES)
        for (const sign of [1, -1] as const) {
          const v = a.dir.clone().multiplyScalar(sign);
          out.push({ x: c + RADIUS * v.dot(right), y: c - RADIUS * v.dot(up), depth: v.dot(fwd), color: a.color, label: sign > 0 ? a.label : null, view: sign > 0 ? a.pos : a.neg });
        }
      return out.sort((p, q) => p.depth - q.depth);
    };

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      const list = ends();
      if (!list) return;
      for (const p of list) {
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = p.depth < 0 ? 0.4 : 0.9;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      for (const p of list) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, DOT, 0, Math.PI * 2);
        if (p.label) {
          ctx.fillStyle = p.color;
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.font = '600 9px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.label, p.x, p.y + 0.5);
        } else {
          ctx.fillStyle = '#ffffffd9';
          ctx.fill();
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(c, c, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = '#00000073';
      ctx.fill();
    };
    raf = requestAnimationFrame(draw);

    const hitAt = (ev: PointerEvent): ViewName | null => {
      const list = ends();
      if (!list) return null;
      const r = canvas.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * SIZE;
      const py = ((ev.clientY - r.top) / r.height) * SIZE;
      let best: End | null = null;
      for (const p of list) if (Math.hypot(px - p.x, py - p.y) <= DOT + 3 && (!best || p.depth > best.depth)) best = p;
      return best?.view ?? null;
    };

    let dragging = false;
    let hit: ViewName | null = null;
    let downX = 0;
    let downY = 0;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    const onDown = (ev: PointerEvent) => {
      ev.preventDefault();
      canvas.setPointerCapture(ev.pointerId);
      dragging = true;
      hit = hitAt(ev);
      downX = lastX = ev.clientX;
      downY = lastY = ev.clientY;
      moved = false;
    };
    const onMove = (ev: PointerEvent) => {
      if (!dragging) return;
      if (!moved && Math.hypot(ev.clientX - downX, ev.clientY - downY) <= CLICK_PX) return;
      moved = true;
      // the scene follows the cursor, like an OrbitControls drag: the camera moves against it
      viewportApi.views?.orbit((lastX - ev.clientX) * DRAG, (ev.clientY - lastY) * DRAG);
      lastX = ev.clientX;
      lastY = ev.clientY;
    };
    const onUp = (ev: PointerEvent) => {
      dragging = false;
      canvas.releasePointerCapture?.(ev.pointerId);
      if (!moved && hit) viewportApi.views?.snapTo(hit);
      hit = null;
      moved = false;
      lastX = lastY = 0;
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
  }, [mode]);

  if (mode !== 'edit') return null;
  return <canvas ref={ref} className="bm-nav-gizmo" aria-label="Navigation gizmo" />;
}
