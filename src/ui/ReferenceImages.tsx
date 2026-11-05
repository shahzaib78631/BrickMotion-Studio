import { useRef, useState } from 'react';
import * as THREE from 'three';
import { addImage, createReferenceImage, facing, imagesOf, readReferenceFile, referenceImage, removeImage, turnImage, updateImage,
  MAX_REFERENCE_IMAGES, type ReferenceImage } from '../render/referenceImages';
import { sceneSetupOf, type SceneSetup, type XYZ } from '../render/sceneSetup';
import { perspectiveEquivalent } from '../render/studio';
import { useStudio } from '../state/store';
import { Ic } from './icons';
import { useReferenceView } from './referenceViewState';
import { useSceneView } from './sceneViewState';
import { viewportApi } from './viewportApi';

const update = (fn: (s: SceneSetup) => SceneSetup) =>
  useStudio.getState().apply((p) => ({ ...p, sceneSetup: fn(sceneSetupOf(p.sceneSetup)) }));

/** Hangs picture files in the view, facing it, at the point the view is orbiting. Returns the messages for files it could not use. */
export async function addReferenceFiles(files: Iterable<File>): Promise<string[]> {
  const studio = viewportApi.studio, orbit = viewportApi.controls;
  const problems: string[] = [];
  if (!studio || !orbit) return ['The 3D view is not ready yet.'];
  const view = perspectiveEquivalent(studio, orbit.target);
  const { width, height } = useSceneView.getState();
  let last: string | null = null;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (imagesOf(useStudio.getState().plan.sceneSetup).length >= MAX_REFERENCE_IMAGES) { problems.push(`Only ${MAX_REFERENCE_IMAGES} reference images fit in a project.`); break; }
    try {
      const picture = await readReferenceFile(file);
      const image = createReferenceImage(picture.name, picture.src, picture.aspect,
        { from: view.position, target: orbit.target.clone(), fov: view.fov, viewAspect: Math.max(1, width) / Math.max(1, height) });
      update((s) => addImage(s, image));
      last = image.id;
    } catch (e) { problems.push(e instanceof Error ? e.message : String(e)); }
  }
  if (last) useReferenceView.setState({ selectedId: last });
  return problems;
}

/** The Scene panel's reference images: add pictures, then move, turn, resize and fade them. */
export function ReferenceImagesSection() {
  const setup = sceneSetupOf(useStudio((s) => s.plan.sceneSetup));
  const view = useReferenceView();
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string[]>([]);
  const images = imagesOf(setup);
  const selected = referenceImage(setup, view.selectedId);
  const edit = (patch: Partial<ReferenceImage>) => { if (selected) update((s) => updateImage(s, selected.id, patch)); };
  const number = (axis: number) => selected && <label key={axis} className="bm-scene-coordinate"><span>{'XYZ'[axis]}</span>
    <input aria-label={`Rotation ${'XYZ'[axis]} (degrees)`} type="number" step="5" value={selected.rotation[axis]} onChange={(e) => {
      const n = Number(e.target.value);
      if (!e.target.value || !Number.isFinite(n)) return;
      const rotation = [...selected.rotation] as XYZ; rotation[axis] = n; edit({ rotation });
    }} /></label>;
  const faceView = () => {
    const studio = viewportApi.studio, orbit = viewportApi.controls;
    if (!studio || !orbit || !selected) return;
    const view = perspectiveEquivalent(studio, orbit.target);
    edit({ rotation: facing(view.position, orbit.target) });
  };
  const bringToView = () => {
    const orbit = viewportApi.controls;
    if (orbit && selected) edit({ position: orbit.target.toArray().map((n) => Math.round(n * 1000) / 1000) as XYZ });
  };
  return <div className="bm-scene-section"><label>Reference images <span>{images.length}</span></label>
    <input ref={input} type="file" accept="image/*" multiple hidden onChange={async (e) => {
      const files = [...(e.target.files ?? [])];
      e.target.value = '';
      setNote(await addReferenceFiles(files));
    }} />
    <div className="bm-scene-add">
      <button onClick={() => input.current?.click()} disabled={images.length >= MAX_REFERENCE_IMAGES} title="You can also drop picture files onto the 3D view">
        <Ic name="plus" /> Add image…</button>
    </div>
    {note.map((n, i) => <p key={i} className="bm-scene-help" role="alert">{n}</p>)}
    {!images.length && <p className="bm-scene-help">Hang a photo or sketch in the view to model against. It faces the camera when you add it. Reference images are for editing only: they are not in previews, captures or videos.</p>}
    {images.map((item) => <div key={item.id} className={`bm-scene-outliner ${view.selectedId === item.id ? 'selected' : ''}`}>
      <button className="bm-scene-object" aria-pressed={view.selectedId === item.id} onClick={() => useReferenceView.setState({ selectedId: item.id })}>
        <Ic name="image" /><span>{item.name}</span>
      </button>
      <button className="bm-scene-activate" title={item.visible ? 'Hide' : 'Show'} aria-label={`${item.visible ? 'Hide' : 'Show'} ${item.name}`}
        onClick={() => update((s) => updateImage(s, item.id, { visible: !item.visible }))}>{item.visible ? '●' : '○'}</button>
      <button className="bm-scene-activate" title={item.locked ? 'Unlock' : 'Lock so it cannot be picked or dragged'} aria-label={`${item.locked ? 'Unlock' : 'Lock'} ${item.name}`}
        onClick={() => update((s) => updateImage(s, item.id, { locked: !item.locked }))}>{item.locked ? '🔒' : '🔓'}</button>
    </div>)}
    {selected && <>
      <input className="bm-scene-name" aria-label="Image name" maxLength={100} value={selected.name} onChange={(e) => edit({ name: e.target.value || selected.name })} />
      <label className="bm-scene-field">Opacity <span>{Math.round(selected.opacity * 100)}%</span>
        <input type="range" min="0" max="100" step="1" aria-label="Image opacity" value={Math.round(selected.opacity * 100)} onChange={(e) => edit({ opacity: Number(e.target.value) / 100 })} /></label>
      <label className="bm-scene-field">Size <span>{selected.width.toFixed(1)} studs wide</span>
        <input type="range" min="1" max="400" step="0.5" aria-label="Image width" value={Math.min(400, selected.width)} onChange={(e) => edit({ width: Number(e.target.value) })} /></label>
      <div className="bm-scene-property"><span>Handles</span>
        <button className={view.mode === 'translate' ? 'active' : ''} onClick={() => useReferenceView.setState({ mode: 'translate' })}>Move</button>
        <button className={view.mode === 'rotate' ? 'active' : ''} onClick={() => useReferenceView.setState({ mode: 'rotate' })}>Rotate</button>
      </div>
      <span className="bm-scene-small-label">Rotation (degrees)</span>
      <div className="bm-scene-xyz">{[0, 1, 2].map(number)}</div>
      <div className="bm-scene-add">
        <button onClick={() => edit({ rotation: turnImage(selected, 1, 90) })} title="A quarter turn about the vertical axis">↻ 90° (up axis)</button>
        <button onClick={() => edit({ rotation: turnImage(selected, 1, -90) })} title="A quarter turn the other way">↺ 90°</button>
        <button onClick={() => edit({ rotation: turnImage(selected, 2, 90) })} title="A quarter turn in the picture's own plane, for a sideways picture">⟳ 90° (in plane)</button>
      </div>
      <div className="bm-scene-add">
        <button onClick={faceView}>Face the view</button>
        <button onClick={bringToView}>Move to view centre</button>
        <button onClick={() => edit({ rotation: [0, 0, 0] })} title="Front view: the picture stands facing the front">Front</button>
        <button onClick={() => edit({ rotation: [0, 90, 0] })}>Side</button>
        <button onClick={() => edit({ rotation: [-90, 0, 0] })}>Top</button>
      </div>
      <button className="bm-scene-remove" onClick={() => { update((s) => removeImage(s, selected.id)); useReferenceView.setState({ selectedId: null }); }}>
        <Ic name="trash" /> Delete image</button>
    </>}
  </div>;
}
