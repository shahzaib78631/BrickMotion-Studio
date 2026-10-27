import { useEffect, useState } from 'react';
import * as THREE from 'three';
import type { ModelState } from '../state/useModel';
import { useStudio } from '../state/store';
import { useAppSettings } from '../state/appSettings';
import { useViewState } from './viewState';
import { viewportApi } from './viewportApi';
import { runCommand } from '../state/editing';
import { nextGroupName, setGroup } from '../plan/groups';
import { modelSteps } from '../plan/ops';
import { movePartsToModel } from '../plan/crossModel';
import { Ic } from './icons';
import { ViewsDropdown } from './ViewMenu';

/** Lightweight editing chrome drawn over the REAL WebGL viewport.
 * The controls talk to the existing camera / selection / undoable plan actions. */
export function ViewportChrome({ model, onMakeSubmodel }: { model: ModelState; onMakeSubmodel(): void }) {
  const tool = useStudio((s) => s.tool);
  const gizmoEnabled = useStudio((s) => s.gizmoEnabled);
  const gizmoMode = useStudio((s) => s.gizmoMode);
  const selection = useStudio((s) => s.selection);
  const editingModel = useStudio((s) => s.editingModel);
  const mode = useStudio((s) => s.mode);
  const view = useViewState((s) => s.view);
  const projection = useViewState((s) => s.projection);
  const laidOut = useStudio((s) => s.laidOut);
  const showSelectionBar = useAppSettings((s) => s.showSelectionBar);
  const [grid, setGrid] = useState(8);
  const [showGrid, setShowGrid] = useState(true);
  const [overview, setOverview] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [more, setMore] = useState(false);
  const ids = selection.model === editingModel ? selection.ids : [];
  const modelTotal = model.view.instances.length;
  // Split is the laid-out view: every part on the floor, framed. It shares the
  // store flag with Models → "Lay out all parts", so both reflect the same state.
  useEffect(() => {
    if (!laidOut) return;
    const frame = requestAnimationFrame(() => viewportApi.fit());
    return () => cancelAnimationFrame(frame);
  }, [laidOut]);
  if (mode !== 'edit') return null;

  const toggleSplit = () => {
    const next = !laidOut;
    useStudio.getState().setLaidOut(next);
    setOverview(next);
  };

  const changeZoom = (direction: 1 | -1) => {
    const camera = viewportApi.studio?.camera;
    const orbit = viewportApi.controls;
    if (!camera || !orbit) return;
    if (camera instanceof THREE.OrthographicCamera) {
      camera.zoom = Math.min(8, Math.max(0.15, camera.zoom * (direction > 0 ? 1.2 : 1 / 1.2)));
      camera.updateProjectionMatrix();
    } else {
      camera.position.sub(orbit.target).multiplyScalar(direction > 0 ? 0.83 : 1.2).add(orbit.target);
    }
    orbit.update();
    setZoom((z) => Math.max(25, Math.min(400, Math.round(z * (direction > 0 ? 1.2 : 1 / 1.2)))));
  };
  const extract = () => {
    if (!ids.length || !editingModel) return;
    const result = movePartsToModel(useStudio.getState().plan, model.assembly, {
      from: editingModel, to: '', ids, step: modelSteps(useStudio.getState().plan, '').length,
    });
    if ('error' in result) return window.alert(result.error);
    useStudio.getState().apply(() => result.plan);
    useStudio.getState().setEditingModel('');
    useStudio.getState().select(result.moved);
  };
  const setTool = (next: 'select' | 'move') => useStudio.getState().setTool(next);
  const selectAll = () => useStudio.getState().select(modelSteps(useStudio.getState().plan, editingModel)
    .flatMap((s) => s.pieces.map((p) => p.id).filter((id): id is string => !!id)));

  return <div className="bm-viewport-chrome" style={{ '--grid-step': `${grid * 5}px` } as React.CSSProperties}>
    {showGrid && <div className="bm-screen-grid" aria-hidden="true" />}
    <div className="bm-viewport-top-left bm-floating-group" role="group" aria-label="Viewport display">
      <ViewsDropdown />
      <button className={view === 'user' ? 'selected' : ''} onClick={() => { viewportApi.views?.setProjection('perspective'); if (view === 'top') viewportApi.views?.orbit(34, -46); else if (view === 'bottom') viewportApi.views?.orbit(34, 46); else viewportApi.views?.orbit(18, 8); }}>3D</button>
      <button className={laidOut ? 'selected' : ''} aria-pressed={laidOut} title="Lay out every part on the floor" onClick={toggleSplit}>Split</button>
    </div>
    <div className="bm-viewport-top-center bm-floating-group" role="toolbar" aria-label="Selection and transform tools">
      <button className={tool === 'select' ? 'selected square' : 'square'} title="Select parts (V)" aria-label="Select parts" onClick={() => setTool('select')}><Ic name="pointer" /></button>
      <button className={tool === 'move' ? 'selected square' : 'square'} title="Move parts (M)" aria-label="Move parts" onClick={() => setTool('move')}><Ic name="move" /></button>
      <button className={gizmoEnabled && gizmoMode === 'translate' ? 'selected square' : 'square'} title="Transform gizmo (G)" aria-label="Transform gizmo" onClick={() => { useStudio.getState().setGizmo(true); useStudio.getState().setGizmoMode('translate'); }}><Ic name="fit" /></button>
      <button className={gizmoEnabled && gizmoMode === 'rotate' ? 'selected square' : 'square'} title="Rotate gizmo" aria-label="Rotate gizmo" onClick={() => { useStudio.getState().setGizmo(true); useStudio.getState().setGizmoMode('rotate'); }}><Ic name="rotate" /></button>
    </div>
    <div className="bm-viewport-top-right" role="toolbar" aria-label="Viewport options">
      <button className="bm-float-icon" title="Orbit 45°" aria-label="Orbit 45 degrees" onClick={() => viewportApi.views?.orbit(45, 0)}><Ic name="rotate" /></button>
      <button className="bm-float-icon" title="Toggle perspective / orthographic" aria-label="Toggle projection" onClick={() => viewportApi.views?.toggleProjection()}><Ic name="view" /></button>
      <button className="bm-float-icon" title="Fit parts in view (F)" aria-label="Fit view" onClick={() => viewportApi.fit()}><Ic name="fit" /></button>
      <span className="bm-toolbar-separator" />
      <button className={`bm-grid-button ${showGrid ? 'on' : ''}`} onClick={() => setShowGrid((s) => !s)} aria-pressed={showGrid}>Grid</button>
      <select aria-label="Grid size" title="Screen grid spacing" value={grid} onChange={(e) => { setGrid(Number(e.target.value)); setShowGrid(true); }}>
        {[4, 8, 12, 16, 24].map((g) => <option key={g} value={g}>{g}</option>)}
      </select>
      <button className="bm-float-icon bm-fullscreen" title="Fullscreen viewport" aria-label="Fullscreen viewport" onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.querySelector('.bm-stage')?.requestFullscreen?.();
      }}><Ic name="widen" /></button>
    </div>
    <div className="bm-viewport-toolrail bm-floating-group" role="toolbar" aria-label="Editing tools">
      <button className={tool === 'select' ? 'selected' : ''} aria-label="Select" title="Select (V)" onClick={() => setTool('select')}><Ic name="pointer" /></button>
      <button className={tool === 'move' ? 'selected' : ''} aria-label="Move" title="Move (M)" onClick={() => setTool('move')}><Ic name="move" /></button>
      <button className={gizmoEnabled && gizmoMode === 'rotate' ? 'selected' : ''} aria-label="Rotate" title="Rotate selected bricks" onClick={() => { useStudio.getState().setGizmo(true); useStudio.getState().setGizmoMode('rotate'); }}><Ic name="rotate" /></button>
      <button className={gizmoEnabled && gizmoMode === 'scale' ? 'selected' : ''} aria-label="Scale" title="Scale transform handles" onClick={() => { useStudio.getState().setGizmo(true); useStudio.getState().setGizmoMode('scale'); }}><Ic name="scale" /></button>
      <span className="bm-toolrail-separator" />
      <button aria-label="Select all" title="Select all (A)" onClick={selectAll}><Ic name="components" /></button>
      <button aria-label="Fit selection" title="Fit selected parts" onClick={() => ids.length ? useStudio.getState().requestFocus(ids) : viewportApi.fit()}><Ic name="view" /></button>
    </div>
    {ids.length > 0 && showSelectionBar && <div className="bm-selection-float" role="toolbar" aria-label="Quick selection actions">
      <button className="bm-selection-primary" disabled={ids.length < 2} onClick={onMakeSubmodel}><Ic name="box" /> Make Submodule</button>
      <button disabled={!editingModel} onClick={extract} title="Extract selected pieces to the main model"><Ic name="moveHere" /> Extract</button>
      <button disabled={ids.length < 2} onClick={() => {
        const st = useStudio.getState(); st.apply((p) => setGroup(p, editingModel, ids, nextGroupName(p, editingModel)));
      }}><Ic name="components" /> Group</button>
      <span className="bm-selection-divider" />
      <button className="icon-only" aria-label="Duplicate selected" title="Duplicate (⌘D)" onClick={() => runCommand({ kind: 'duplicate' })}><Ic name="copy" /></button>
      <button className="icon-only" aria-label="Rotate selected" title="Rotate 90° (R)" onClick={() => runCommand({ kind: 'rotate' })}><Ic name="rotate" /></button>
      <button className="icon-only" aria-label="Delete selected" title="Delete selected (Del)" onClick={() => runCommand({ kind: 'delete' })}><Ic name="trash" /></button>
      <button className="icon-only" aria-label="More selection actions" aria-expanded={more} onClick={() => setMore((s) => !s)}><Ic name="more" /></button>
      {more && <div className="bm-selection-more">
        <button onClick={() => { useStudio.getState().setLaidOut(true); setMore(false); }}>Lay out all pieces</button>
        <button onClick={() => { useStudio.getState().hide(ids); setMore(false); }}>Hide selected</button>
        <button onClick={() => { useStudio.getState().select([]); setMore(false); }}>Clear selection</button>
      </div>}
    </div>}
    {overview && <div className="bm-split-overview">
      <div className="bm-split-overview-heading"><Ic name="components" /> Assembly overview <button aria-label="Close overview" onClick={() => setOverview(false)}><Ic name="x" /></button></div>
      <div className="bm-split-overview-stat"><strong>{modelTotal.toLocaleString()}</strong><span>visible parts</span></div>
      <div className="bm-split-overview-stat"><strong>{modelSteps(useStudio.getState().plan, editingModel).length}</strong><span>build steps</span></div>
      <p>Every part is laid out on the floor. Select parts to group them or make a submodule, or turn Split off to return to the build view.</p>
    </div>}
    <div className="bm-viewport-bottom-right">
      <button title="Frame all parts" aria-label="Reset view" onClick={() => { viewportApi.fit(); setZoom(100); }}><Ic name="fit" /></button>
      <div className="bm-zoom-controls">
        <button aria-label="Zoom out" onClick={() => changeZoom(-1)}>−</button>
        <button className="bm-zoom-value" onClick={() => { viewportApi.fit(); setZoom(100); }} title="Fit view">{zoom}% <Ic name="chevron" /></button>
        <button aria-label="Zoom in" onClick={() => changeZoom(1)}>+</button>
      </div>
    </div>
    <span className="bm-projection-indicator">{projection === 'ortho' ? 'ORTHO' : 'PERSPECTIVE'}</span>
  </div>;
}
