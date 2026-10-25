import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import * as THREE from 'three';
import { createCamera, createLight, freshSceneId, sceneObject, sceneSetupOf, updateObject, removeObject,
  regionFromDrag, cameraCrop, cameraFrame, type SceneSetup, type SceneCamera, type SceneLight, type SceneObject, type LightType, type XYZ, type Region } from '../render/sceneSetup';
import { formatAspect } from '../export/formats';
import { useAppSettings } from '../state/appSettings';
import { useStudio } from '../state/store';
import { Ic } from './icons';
import { viewportApi } from './viewportApi';
import { useSceneView } from './sceneViewState';

/** Camera and light outliner plus inspector. All edits use the project's normal
 * undo/autosave path and therefore survive project export/import. */
export function SceneTools() {
  const mode = useStudio((s) => s.mode);
  const source = useStudio((s) => s.plan.sceneSetup);
  const setup = sceneSetupOf(source);
  const outputAspect = formatAspect(useAppSettings((s) => s.format));
  const v = useSceneView();
  const selected = sceneObject(setup, v.selectedId);
  const update = (fn: (s: SceneSetup) => SceneSetup) => {
    useStudio.getState().apply((p) => ({ ...p, sceneSetup: fn(sceneSetupOf(p.sceneSetup)) }));
  };
  const edit = (patch: Partial<SceneObject>) => {
    if (!selected) return;
    update((s) => updateObject(s, selected.id, (item) => ({ ...item, ...patch }) as SceneObject));
  };
  const addCamera = () => {
    const studio = viewportApi.studio;
    const orbit = viewportApi.controls;
    if (!studio || !orbit) return;
    const cam = createCamera(studio.camera.position, orbit.target, studio.projection === 'perspective' ? studio.perspective.fov : 42, setup.cameras.length + 1);
    update((s) => ({ ...s, cameras: [...s.cameras, cam], activeCameraId: cam.id }));
    useSceneView.setState({ selectedId: cam.id, panelOpen: true });
  };
  const addLight = (type: LightType) => {
    const studio = viewportApi.studio;
    const orbit = viewportApi.controls;
    if (!studio || !orbit) return;
    const lamp = createLight(type, studio.camera.position, orbit.target, setup.lights.length + 1);
    update((s) => ({ ...s, lights: [...s.lights, lamp] }));
    useSceneView.setState({ selectedId: lamp.id, panelOpen: true });
  };
  const active = setup.cameras.find((c) => c.id === setup.activeCameraId);
  const isActive = selected?.kind === 'camera' && setup.activeCameraId === selected.id;
  if (mode !== 'edit') return null;
  const coord = (name: 'position' | 'target', axis: number) => {
    if (!selected) return null;
    const old = selected[name];
    return <label key={name + axis} className="bm-scene-coordinate"><span>{'XYZ'[axis]}</span>
      <input aria-label={`${selected.name} ${name} ${'XYZ'[axis]}`} type="number" step="0.25"
        value={Number(old[axis].toFixed(3))} onChange={(e) => {
          const n = Number(e.target.value);
          if (!e.target.value || !Number.isFinite(n)) return;
          const vec = [...old] as XYZ; vec[axis] = n;
          edit({ [name]: vec });
        }} /></label>;
  };
  return <>
    <button className={`bm-scene-btn${v.panelOpen ? ' on' : ''}`} onClick={() => useSceneView.setState({ panelOpen: !v.panelOpen })}
      title="Add and edit cameras and lights directly in the 3D viewport" aria-expanded={v.panelOpen} aria-controls="bm-scene-panel">
      <Ic name="camera" /> Scene <Ic name="chevron" />
    </button>
    {v.panelOpen && <div id="bm-scene-panel" className="bm-scene-panel" role="region" aria-label="Cameras and lighting">
      <div className="bm-scene-panel-head"><b>Cameras &amp; Lighting</b><button aria-label="Close scene panel" onClick={() => useSceneView.setState({ panelOpen: false })}><Ic name="x" /></button></div>
      <div className="bm-scene-panel-inner">
        <div className="bm-scene-section"><label>Add to scene</label>
          <div className="bm-scene-add"><button onClick={addCamera}><Ic name="camera" /> Camera</button>
            <button onClick={() => addLight('sun')}><Ic name="sun" /> Sun</button>
            <button onClick={() => addLight('point')}>✦ Point</button>
            <button onClick={() => addLight('spot')}>◉ Spot</button>
            <button onClick={() => addLight('ambient')}>☼ Ambient</button>
          </div>
        </div>
        <div className="bm-scene-section"><label>Scene objects <span>{setup.cameras.length + setup.lights.length}</span></label>
          {!setup.cameras.length && !setup.lights.length && <p className="bm-scene-help">Add a camera to frame a shot, or a light to shape the preview.</p>}
          {[...setup.cameras, ...setup.lights].map((item) => <div key={item.id} className={`bm-scene-outliner ${v.selectedId === item.id ? 'selected' : ''}`}>
            <button className="bm-scene-object" aria-pressed={v.selectedId === item.id} onClick={() => useSceneView.setState({ selectedId: item.id })}>
              <Ic name={item.kind === 'camera' ? 'camera' : 'sun'} /><span>{item.name}</span>
            </button>
            {item.kind === 'camera' && <button className="bm-scene-activate" title="Set active camera" aria-label={`Make ${item.name} active camera`}
              onClick={() => update((s) => ({ ...s, activeCameraId: item.id }))}>{setup.activeCameraId === item.id ? '●' : '○'}</button>}
          </div>)}
        </div>
        <div className="bm-scene-section"><label>Camera view</label>
          <div className="bm-scene-add">
            <button disabled={!active} className={v.cameraView ? 'active' : ''} onClick={() => viewportApi.scene?.enterCameraView()} title="Numpad 0">{v.cameraView ? 'Exit camera' : 'View camera'}</button>
            <button disabled={v.cameraView} onClick={() => viewportApi.scene?.alignCamera()} title="Ctrl+Alt+Numpad 0 (outside camera view)">Align to view</button>
          </div>
          <label className="bm-scene-check"><input type="checkbox" checked={v.lockCamera} onChange={(e) => useSceneView.setState({ lockCamera: e.target.checked })} /> Lock camera to view</label>
          <label className="bm-scene-check"><input type="checkbox" checked={setup.useCameraForVideo} onChange={(e) => update((s) => ({ ...s, useCameraForVideo: e.target.checked }))} /> Use active camera in Preview &amp; MP4</label>
        </div>
        <div className="bm-scene-section"><label>Camera render region</label>
          <div className="bm-scene-add">
            <button disabled={!active || !v.cameraView} className={v.regionTool ? 'active' : ''} onClick={() => useSceneView.setState({ regionTool: !v.regionTool })} title="Ctrl+B">{v.regionTool ? 'Drag on camera frame…' : 'Select region'}</button>
            <button disabled={!setup.region} onClick={() => update((s) => ({ ...s, region: null }))} title="Ctrl+Alt+B">Clear</button>
          </div>
          {setup.region && <p className="bm-scene-help">Region: {Math.round(setup.region.width * 100)}% × {Math.round(setup.region.height * 100)}% of the camera frame.</p>}
          <label className="bm-scene-check"><input type="checkbox" checked={setup.cropToRegion} onChange={(e) => update((s) => ({ ...s, cropToRegion: e.target.checked }))} /> Crop Preview &amp; MP4 to region</label>
          <label className="bm-scene-check"><input type="checkbox" checked={v.showGuides} onChange={(e) => useSceneView.setState({ showGuides: e.target.checked })} /> Rule-of-thirds guides</label>
          <label className="bm-scene-check"><input type="checkbox" checked={v.showSafe} onChange={(e) => useSceneView.setState({ showSafe: e.target.checked })} /> Safe-area guides</label>
        </div>
        {selected && <div className="bm-scene-section"><label>Selected object</label>
          <input className="bm-scene-name" aria-label="Object name" maxLength={100} value={selected.name} onChange={(e) => edit({ name: e.target.value || selected.name })} />
          <div className="bm-scene-property"><span>Move / Rotate</span>
            <button onClick={() => viewportApi.scene?.setTransformMode('translate')}>Move</button>
            <button onClick={() => viewportApi.scene?.setTransformMode('rotate')}>Rotate</button>
          </div>
          <span className="bm-scene-small-label">Position (studs)</span>
          <div className="bm-scene-xyz">{[0, 1, 2].map((axis) => coord('position', axis))}</div>
          {selected.kind !== 'light' || selected.type !== 'ambient' ? <><span className="bm-scene-small-label">Look-at target (studs)</span>
            <div className="bm-scene-xyz">{[0, 1, 2].map((axis) => coord('target', axis))}</div></> : null}
          {selected.kind === 'camera' ? <>
            <div className="bm-scene-add">{[24, 35, 50, 85].map((lens) => <button key={lens} onClick={() => edit({ fov: THREE.MathUtils.radToDeg(2 * Math.atan(18 / (lens * outputAspect))) } as Partial<SceneCamera>)}>{lens} mm</button>)}</div>
            <label className="bm-scene-field">Field of view <span>{selected.fov.toFixed(1)}°</span><input type="range" min="10" max="110" step="0.5" value={selected.fov} onChange={(e) => edit({ fov: Number(e.target.value) } as Partial<SceneCamera>)} /></label>
            <div className="bm-scene-property"><span>Equivalent focal length (36 mm width)</span><b>{(18 / (outputAspect * Math.tan(THREE.MathUtils.degToRad(selected.fov / 2)))).toFixed(0)} mm</b></div>
          </> : <>
            <label className="bm-scene-field">Light intensity <span>{selected.intensity.toFixed(1)}</span><input type="range" min="0" max={selected.type === 'sun' || selected.type === 'ambient' ? 10 : 1000} step="0.1" value={selected.intensity} onChange={(e) => edit({ intensity: Number(e.target.value) } as Partial<SceneLight>)} /></label>
            <div className="bm-scene-property"><span>Color</span><input type="color" aria-label="Light color" value={selected.color} onChange={(e) => edit({ color: e.target.value } as Partial<SceneLight>)} /></div>
            {selected.type === 'spot' && <label className="bm-scene-field">Spot cone <span>{selected.angle}°</span><input type="range" min="5" max="170" value={selected.angle} onChange={(e) => edit({ angle: Number(e.target.value) } as Partial<SceneLight>)} /></label>}
            {selected.type !== 'ambient' && <label className="bm-scene-check"><input type="checkbox" checked={selected.castShadow} onChange={(e) => edit({ castShadow: e.target.checked } as Partial<SceneLight>)} /> Cast shadows</label>}
            <label className="bm-scene-check"><input type="checkbox" checked={selected.enabled} onChange={(e) => edit({ enabled: e.target.checked } as Partial<SceneLight>)} /> Light enabled</label>
          </>}
          <div className="bm-scene-add"><button onClick={() => {
            const id = freshSceneId();
            const position: XYZ = [...selected.position]; position[0] += 2;
            if (selected.kind === 'camera') update((scene) => ({ ...scene, cameras: [...scene.cameras,
              { ...selected, id, position, name: `${selected.name} copy` }], activeCameraId: id }));
            else update((scene) => ({ ...scene, lights: [...scene.lights,
              { ...selected, id, position, name: `${selected.name} copy` }] }));
            useSceneView.setState({ selectedId: id });
          }}><Ic name="copy" /> Duplicate</button>
          {selected.kind === 'light' && selected.type !== 'ambient' && <button onClick={() => {
            const target = viewportApi.controls?.target.toArray() as XYZ | undefined;
            if (target) edit({ target } as Partial<SceneLight>);
          }}>Aim at view</button>}</div>
          <button className="bm-scene-remove" onClick={() => {
            update((s) => removeObject(s, selected.id));
            useSceneView.setState({ selectedId: null });
            if (isActive) viewportApi.scene?.enterCameraView(false);
          }}><Ic name="trash" /> Delete object</button>
        </div>}
        <div className="bm-scene-section"><label>Rendering</label>
          <label className="bm-scene-check"><input type="checkbox" checked={setup.includeStudioLights} onChange={(e) => update((s) => ({ ...s, includeStudioLights: e.target.checked }))} /> Keep default studio lights</label>
          <label className="bm-scene-check"><input type="checkbox" checked={setup.useLightsForVideo} onChange={(e) => update((s) => ({ ...s, useLightsForVideo: e.target.checked }))} /> Use scene lights in Preview &amp; MP4</label>
          <label className="bm-scene-check"><input type="checkbox" checked={v.showHelpers} onChange={(e) => useSceneView.setState({ showHelpers: e.target.checked })} /> Show 3D camera &amp; light handles</label>
          <label className="bm-scene-field">Exposure <span>{setup.exposure.toFixed(2)}×</span><input type="range" min="0.1" max="3" step="0.05" value={setup.exposure} onChange={(e) => update((s) => ({ ...s, exposure: Number(e.target.value) }))} /></label>
        </div>
        <p className="bm-scene-help">Cameras, lighting, and regions save with this project. Rendering helpers are editor-only and are excluded from video.</p>
      </div>
    </div>}
  </>;
}

/** A Blender-style camera border with composition guides and an interactive
 * Ctrl+B rectangle. All pointer coordinates are inside the framed camera image. */
export function CameraRegionOverlay() {
  const view = useSceneView();
  const setup = sceneSetupOf(useStudio((s) => s.plan.sceneSetup));
  const aspect = formatAspect(useAppSettings((s) => s.format));
  const [drawing, setDrawing] = useState<Region | null>(null);
  const start = useRef<[number, number] | null>(null);
  const border = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!view.regionTool) { start.current = null; setDrawing(null); } }, [view.regionTool]);
  if (!view.cameraView || !activeCameraPresent(setup)) return null;
  const f = cameraFrame(view.width, view.height, aspect);
  const at = (e: ReactPointerEvent): [number, number] => {
    const rect = border.current!.getBoundingClientRect();
    return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
  };
  const shown = drawing ?? (setup.cropToRegion ? cameraCrop(setup.region) : setup.region);
  return <div className="bm-camera-overlay" style={{ left: f.x, top: f.y, width: f.width, height: f.height }}>
    <div className="bm-camera-frame" ref={border} data-testid="camera-frame"
      style={{ cursor: view.regionTool ? 'crosshair' : undefined, pointerEvents: view.regionTool ? 'auto' : 'none' }}
      onPointerDown={(e) => { if (!view.regionTool || e.button !== 0) return; e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); start.current = at(e); setDrawing(null); }}
      onPointerMove={(e) => { if (start.current) { e.stopPropagation(); setDrawing(regionFromDrag(start.current, at(e))); } }}
      onPointerUp={(e) => {
        if (!start.current) return;
        e.stopPropagation(); const next = regionFromDrag(start.current, at(e)); start.current = null;
        setDrawing(null); useSceneView.setState({ regionTool: false });
        if (next) useStudio.getState().apply((p) => ({ ...p, sceneSetup: { ...sceneSetupOf(p.sceneSetup), region: next } }));
      }}
      onPointerCancel={() => { start.current = null; setDrawing(null); }}>
      {view.showGuides && <div className="bm-thirds"><i /><i /><i /><i /></div>}
      {view.showSafe && <div className="bm-camera-safe" />}
      {shown && <div className="bm-region-border" style={{ left: `${shown.x * 100}%`, top: `${shown.y * 100}%`, width: `${shown.width * 100}%`, height: `${shown.height * 100}%` }} />}
      <span className="bm-camera-frame-name">{setup.cameras.find((c) => c.id === setup.activeCameraId)?.name} {setup.cropToRegion ? '· crop enabled' : ''}</span>
    </div>
  </div>;
}
function activeCameraPresent(s: SceneSetup) { return s.cameras.some((c) => c.id === s.activeCameraId); }
