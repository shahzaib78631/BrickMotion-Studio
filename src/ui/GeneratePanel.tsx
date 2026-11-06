import { useEffect, useMemo, useState } from 'react';
import { buildingSpec, generateBuilding, type BuildingKind, type RoofStyle, type Shape, type SpecOverrides } from '../generate/building';
import { certify, type Certificate } from '../generate/certify';
import { originality, type Originality, type SetFingerprint } from '../generate/priors';
import { flushSave, newProject } from '../state/persistence';
import { useStudio } from '../state/store';
import { PaneHead } from './PaneHead';

type Any<T> = T | 'any';

const newSeed = () => Math.floor(Math.random() * 1e9);

const KINDS: [BuildingKind, string][] = [['house', 'House'], ['shop', 'Shop'], ['tower', 'House with tower'], ['manor', 'Manor with terrace'], ['block', 'Town block']];
const SHAPES: [Shape, string][] = [['rect', 'Rectangle'], ['L', 'L'], ['T', 'T'], ['U', 'U']];
const ROOFS: [RoofStyle, string][] = [['gable', 'Stepped gable'], ['hip', 'Stepped hip'], ['slope', 'Sloped'], ['flat', 'Flat']];

/**
 * Generators that build a whole model from a seed. Every model is laid in real bricks
 * and certified by the editor's own checks before it is offered; it opens as a new
 * project so it can be edited and animated like any other.
 */
export function GeneratePanel() {
  const [seed, setSeed] = useState(newSeed);
  const [kind, setKind] = useState<Any<BuildingKind>>('any');
  const [shape, setShape] = useState<Any<Shape>>('any');
  const [roof, setRoof] = useState<Any<RoofStyle>>('any');
  const [floors, setFloors] = useState<Any<number>>('any');
  const [width, setWidth] = useState<Any<number>>('any');
  const [busy, setBusy] = useState(false);
  const [cert, setCert] = useState<Certificate | null>(null);
  const [sets, setSets] = useState<SetFingerprint[] | null>(null);

  // the real sets' fingerprints are large: load them only when this panel is open
  useEffect(() => {
    let live = true;
    void import('../data/buildingFingerprints.generated').then((m) => { if (live) setSets(m.SET_FINGERPRINTS); });
    return () => { live = false; };
  }, []);

  const preview = useMemo(() => {
    const over: SpecOverrides = {};
    if (kind !== 'any') over.kind = kind;
    if (shape !== 'any') over.shape = shape;
    if (roof !== 'any') over.roof = roof;
    if (floors !== 'any') over.floors = floors;
    if (width !== 'any') over.width = width;
    return generateBuilding(buildingSpec(seed, over));
  }, [seed, kind, shape, roof, floors, width]);

  // certify every preview with the editor's checks (loads its parts first)
  useEffect(() => {
    let live = true;
    setCert(null);
    const t = setTimeout(() => {
      void certify(preview.plan, preview.built.components).then((c) => { if (live) setCert(c); }).catch(() => undefined);
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [preview]);

  const build = async () => {
    setBusy(true);
    try {
      await flushSave();
      await newProject();
      useStudio.getState().setPlan(preview.plan, { resetHistory: true });
    } finally {
      setBusy(false);
    }
  };

  const select = <T extends string | number>(label: string, value: Any<T>, set: (v: Any<T>) => void, options: [T, string][]) => (
    <label className="nx-field">
      {label}
      <select value={String(value)} onChange={(e) => {
        const raw = e.target.value;
        if (raw === 'any') return set('any');
        const hit = options.find(([o]) => String(o) === raw);
        if (hit) set(hit[0]);
      }}>
        <option value="any">Any</option>
        {options.map(([o, l]) => <option key={String(o)} value={String(o)}>{l}</option>)}
      </select>
    </label>
  );

  const { spec } = preview;
  const orig: Originality | null = useMemo(() => (sets && sets.length ? originality(preview.plan, sets) : null), [preview, sets]);
  return (
    <div className="nx-pane bm-generate">
      <PaneHead id="generate" title="Generate" help={<>Builds a whole model from a seed: the same seed always gives the same model. Every model is laid in real bricks with real windows, doors and roof slopes, and is certified by the editor&apos;s own checks: one piece, nothing floating, nothing overlapping. It opens as a new project; the one you have open is saved first.</>} />
      <div className="nx-sub">Building</div>
      <div className="bm-generate-seed">
        <label className="nx-field">
          Seed
          <input type="number" value={seed} onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
        </label>
        <button className="nx-btn" onClick={() => setSeed(newSeed())} title="Another seed">Shuffle</button>
      </div>
      <div className="bm-generate-grid">
        {select('Kind', kind, setKind, KINDS)}
        {select('Shape', shape, setShape, SHAPES)}
        {select('Roof', roof, setRoof, ROOFS)}
        {select('Floors', floors, setFloors, [[1, '1'], [2, '2'], [3, '3']])}
        {select('Width (studs)', width, setWidth, [8, 10, 12, 14, 16, 20, 24].map((w) => [w, String(w)] as [number, string]))}
      </div>
      <div className="bm-generate-card">
        <b>{spec.label}</b>
        <span className="nx-fine">{spec.floors} {spec.floors === 1 ? 'floor' : 'floors'} · {spec.width}×{spec.depth} studs · {spec.volumes.length > 1 ? `${spec.volumes.length} parts · ` : ''}{cert ? `${cert.pieces} pieces` : 'checking…'}</span>
        {cert && (cert.buildable
          ? <span className="bm-generate-ok">Certified buildable: one piece, nothing floating or overlapping{cert.weak ? ` · ${cert.weak} weak ${cert.weak === 1 ? 'joint' : 'joints'}` : ''}</span>
          : <span className="bm-generate-bad">Not buildable: {[cert.parts > 1 && `${cert.parts} separate parts`, cert.floating && `${cert.floating} floating`, cert.overlapping && `${cert.overlapping} overlapping`, cert.unknown && `${cert.unknown} unknown parts`].filter(Boolean).join(', ')}</span>)}
        {orig && (
          <span className="nx-fine" title={`Compared with ${sets!.length} real building sets from the LDraw Official Model Repository by their mix of parts and colours.`}>
            {orig.percent}% original{orig.closest ? ` · closest real set: ${orig.closest.name} (${orig.closest.set}), ${orig.closest.shared}% shared` : ''}
          </span>
        )}
      </div>
      <button className="nx-btn nx-primary" disabled={busy || !cert?.buildable} onClick={() => void build()}>Build it as a new project</button>
    </div>
  );
}
