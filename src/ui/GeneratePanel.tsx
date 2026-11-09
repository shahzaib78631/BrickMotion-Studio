import { useEffect, useMemo, useState } from 'react';
import { buildingSpec, generateBuilding, type BuildingKind, type RoofStyle, type Shape, type SpecOverrides } from '../generate/building';
import { castleSpec, generateCastle, CASTLE_SIZES, type CastleOverrides, type GeneratedCastle, type Stone, type TowerTop } from '../generate/castle';
import { certify, type Certificate } from '../generate/certify';
import { originality, type Originality, type SetFingerprint } from '../generate/priors';
import { flushSave, newProject } from '../state/persistence';
import { useStudio } from '../state/store';
import { PaneHead } from './PaneHead';
import type { PromptResult } from '../ai/promptToModel';
import type { RemixResult } from '../ai/remix';
import type { VariantResult } from '../ai/variant';
import { useAppSettings } from '../state/appSettings';
import type { Plan } from '../plan/types';

type Any<T> = T | 'any';

const newSeed = () => Math.floor(Math.random() * 1e9);

const KINDS: [BuildingKind | 'castle', string][] = [['house', 'House'], ['shop', 'Shop'], ['tower', 'House with tower'], ['manor', 'Manor with terrace'], ['block', 'Town block'], ['castle', 'Castle']];
const SIZES: [number, string][] = CASTLE_SIZES.map((n) => [n, String(n)]);
const TOWER_TOPS: [TowerTop, string][] = [['battlements', 'Battlements'], ['roof', 'Pointed roofs']];
const STONES: [Stone, string][] = [['light', 'Light grey'], ['dark', 'Dark grey'], ['sand', 'Sandstone']];
const YES_NO: ['yes' | 'no', string][] = [['yes', 'Yes'], ['no', 'No']];
const SHAPES: [Shape, string][] = [['rect', 'Rectangle'], ['L', 'L'], ['T', 'T'], ['U', 'U']];
const ROOFS: [RoofStyle, string][] = [['gable', 'Stepped gable'], ['hip', 'Stepped hip'], ['slope', 'Sloped'], ['flat', 'Flat']];

/**
 * Generators that build a whole model from a seed. Every model is laid in real bricks
 * and certified by the editor's own checks before it is offered; it opens as a new
 * project so it can be edited and animated like any other.
 */
export function GeneratePanel() {
  const [seed, setSeed] = useState(newSeed);
  const [kind, setKind] = useState<Any<BuildingKind | 'castle'>>('any');
  // castle options
  const [cWidth, setCWidth] = useState<Any<number>>(48);
  const [cDepth, setCDepth] = useState<Any<number>>(48);
  const [cFloors, setCFloors] = useState<Any<number>>('any');
  const [cTop, setCTop] = useState<Any<TowerTop>>('any');
  const [cStone, setCStone] = useState<Any<Stone>>('any');
  const [cMoat, setCMoat] = useState<Any<'yes' | 'no'>>('yes');
  const [cBack, setCBack] = useState<Any<'yes' | 'no'>>('yes');
  const [castle, setCastle] = useState<GeneratedCastle | null>(null);
  const isCastle = kind === 'castle';
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

  const house = useMemo(() => {
    if (kind === 'castle') return null;
    const over: SpecOverrides = {};
    if (kind !== 'any') over.kind = kind;
    if (shape !== 'any') over.shape = shape;
    if (roof !== 'any') over.roof = roof;
    if (floors !== 'any') over.floors = floors;
    if (width !== 'any') over.width = width;
    return generateBuilding(buildingSpec(seed, over));
  }, [seed, kind, shape, roof, floors, width]);

  // a castle is big: lay it after the panel has shown that it is working
  useEffect(() => {
    if (!isCastle) return;
    setCastle(null);
    const over: CastleOverrides = {};
    if (cWidth !== 'any') over.width = cWidth;
    if (cDepth !== 'any') over.depth = cDepth;
    if (cFloors !== 'any') over.keepFloors = cFloors;
    if (cTop !== 'any') over.towerTop = cTop;
    if (cStone !== 'any') over.stone = cStone;
    if (cMoat !== 'any') over.moat = cMoat === 'yes';
    if (cBack !== 'any') over.openBack = cBack === 'yes';
    const t = setTimeout(() => setCastle(generateCastle(castleSpec(seed, over))), 30);
    return () => clearTimeout(t);
  }, [isCastle, seed, cWidth, cDepth, cFloors, cTop, cStone, cMoat, cBack]);

  const preview = isCastle ? castle : house;

  // certify every preview with the editor's checks (loads its parts first)
  useEffect(() => {
    let live = true;
    setCert(null);
    if (!preview) return;
    const t = setTimeout(() => {
      void certify(preview.plan, preview.built.components).then((c) => { if (live) setCert(c); }).catch(() => undefined);
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [preview]);

  const build = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await openAsProject(preview.plan);
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

  const orig: Originality | null = useMemo(() => (house && sets && sets.length ? originality(house.plan, sets) : null), [house, sets]);
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
      {isCastle ? (
        <div className="bm-generate-grid">
          {select('Kind', kind, setKind, KINDS)}
          {select('Width (studs)', cWidth, setCWidth, SIZES)}
          {select('Depth (studs)', cDepth, setCDepth, SIZES)}
          {select('Keep floors', cFloors, setCFloors, [[1, '1'], [2, '2'], [3, '3']])}
          {select('Towers', cTop, setCTop, TOWER_TOPS)}
          {select('Stone', cStone, setCStone, STONES)}
          {select('Moat', cMoat, setCMoat, YES_NO)}
          {select('Open back (see the rooms)', cBack, setCBack, YES_NO)}
        </div>
      ) : (
        <div className="bm-generate-grid">
          {select('Kind', kind, setKind, KINDS)}
          {select('Shape', shape, setShape, SHAPES)}
          {select('Roof', roof, setRoof, ROOFS)}
          {select('Floors', floors, setFloors, [[1, '1'], [2, '2'], [3, '3']])}
          {select('Width (studs)', width, setWidth, [8, 10, 12, 14, 16, 20, 24].map((w) => [w, String(w)] as [number, string]))}
        </div>
      )}
      <div className="bm-generate-card">
        {isCastle ? (castle ? (
          <>
            <b>{castle.spec.label}</b>
            <span className="nx-fine">{castle.spec.width}×{castle.spec.depth} studs · rooms: {castle.spec.rooms.join(', ')} · {cert ? `${cert.pieces} pieces` : 'checking…'}</span>
          </>
        ) : <span className="nx-fine">Laying the castle’s bricks…</span>) : house && (
          <>
            <b>{house.spec.label}</b>
            <span className="nx-fine">{house.spec.floors} {house.spec.floors === 1 ? 'floor' : 'floors'} · {house.spec.width}×{house.spec.depth} studs · {house.spec.volumes.length > 1 ? `${house.spec.volumes.length} parts · ` : ''}{cert ? `${cert.pieces} pieces` : 'checking…'}</span>
          </>
        )}
        {cert && <CertificateLine cert={cert} />}
        {orig && (
          <span className="nx-fine" title={`Compared with ${sets!.length} real building sets from the LDraw Official Model Repository by their mix of parts and colours.`}>
            {orig.percent}% original{orig.closest ? ` · closest real set: ${orig.closest.name} (${orig.closest.set}), ${orig.closest.shared}% shared` : ''}
          </span>
        )}
      </div>
      <button className="nx-btn nx-primary" disabled={busy || !preview || !cert?.buildable} onClick={() => void build()}>Build it as a new project</button>
      <PromptSection seed={seed} />
    </div>
  );
}

async function openAsProject(plan: Plan): Promise<void> {
  await flushSave();
  await newProject();
  useStudio.getState().setPlan(plan, { resetHistory: true });
}

/**
 * Any object from a sentence (src/ai): remix the closest real set from the LDraw Official
 * Model Repository (real parts, looks like a real build), or sketch a new shape with
 * BrickMotion's own shape model (original, but blocky).
 */
function PromptSection({ seed }: { seed: number }) {
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sketch, setSketch] = useState<PromptResult | null>(null);
  const [remix, setRemix] = useState<RemixResult | null>(null);
  const [cert, setCert] = useState<Certificate | null>(null);
  const [busy, setBusy] = useState(false);
  const [variantAsk, setVariantAsk] = useState('');
  const [variant, setVariant] = useState<VariantResult | null>(null);
  const [abort, setAbort] = useState<AbortController | null>(null);
  const apiKey = useAppSettings((s) => s.apiKey);
  // the dev server's bridge to the local Claude CLI (your Claude login, no key): used when it is there
  const [bridge, setBridge] = useState(false);
  useEffect(() => { void import('../ai/claudeBridge').then((m) => m.bridgeAvailable()).then(setBridge); }, []);
  const canAsk = bridge || !!apiKey;

  const start = () => {
    setBusy(true);
    setError(null);
    setSketch(null);
    setRemix(null);
    setCert(null);
    setVariant(null);
  };
  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    setStatus(null);
  };

  const runSketch = async () => {
    start();
    try {
      const { generateFromPrompt } = await import('../ai/promptToModel');
      const r = await generateFromPrompt(prompt, seed, (stage, done, total) =>
        setStatus(total > 1 ? `${stage}… ${Math.round((100 * done) / total)}%` : `${stage}…`));
      setSketch(r);
      setStatus('Checking…');
      setCert(await certify(r.plan, { generatorParts: r.built.components }));
      setStatus(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const runRemix = async (choice?: number) => {
    start();
    try {
      const { remixFromPrompt } = await import('../ai/remix');
      const r = await remixFromPrompt(prompt, seed, (stage) => setStatus(`${stage}…`), choice);
      setRemix(r);
      setStatus('Checking…');
      setCert(await certify(r.plan, { realModel: true }));
      setStatus(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /** Claude edits the remixed build into a variant; the certificate checks each round. */
  const runVariant = async () => {
    if (!remix) return;
    const ac = new AbortController();
    setAbort(ac);
    setBusy(true);
    setError(null);
    setVariant(null);
    try {
      const { makeVariant } = await import('../ai/variant');
      const v = await makeVariant({ apiKey: bridge ? undefined : apiKey, request: variantAsk, base: remix.plan, signal: ac.signal, progress: (stage) => setStatus(`${stage}…`) });
      setVariant(v);
      setStatus(null);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') setStatus(null);
      else fail(e);
    } finally {
      setBusy(false);
      setAbort(null);
    }
  };

  const plan = variant?.plan ?? remix?.plan ?? sketch?.plan;
  const shownCert = variant?.cert ?? cert;
  return (
    <>
      <div className="nx-sub">From a prompt</div>
      <label className="nx-field">
        Describe an object
        <input
          type="text" value={prompt} placeholder="a police car"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && prompt.trim() && !busy) void runRemix(); }}
        />
      </label>
      <div className="nx-row">
        <button className="nx-btn" disabled={busy || !prompt.trim()} onClick={() => void runRemix()}
          title="Find the closest real build (LDraw Official Model Repository sets and BrickNet models) and remix it: real parts, recoloured when the prompt names a colour">
          {busy && !sketch ? 'Working…' : 'Remix a real build'}
        </button>
        <button className="nx-btn" disabled={busy || !prompt.trim()} onClick={() => void runSketch()}
          title="Sketch a new shape with BrickMotion's own shape model and lay it in bricks: original, but blocky">
          Sketch a shape
        </button>
      </div>
      {(status || error || plan) && (
        <div className="bm-generate-card">
          {status && <span className="nx-fine">{status}</span>}
          {error && <span className="bm-generate-bad">{error}</span>}
          {remix && (
            <>
              <b>{remix.plan.name}</b>
              {remix.sample.source === 'bricknet' ? (
                <span className="nx-fine">
                  BrickNet model: {remix.sample.caption ?? remix.sample.name} · BrickNet dataset (Kulits &amp; Schmid, CVPR 2026)
                  {remix.recoloured !== null ? ' · recoloured' : ''}{cert ? ` · ${cert.pieces} pieces` : ''}
                </span>
              ) : (
                <span className="nx-fine">
                  {remix.sample.sub ? `“${remix.sample.sub}” from ` : ''}set {remix.sample.set} {remix.sample.name} ({remix.sample.theme})
                  {remix.sample.author ? ` · modelled by ${remix.sample.author}` : ''} · LDraw OMR, CC BY
                  {remix.recoloured !== null ? ' · recoloured' : ''}{cert ? ` · ${cert.pieces} pieces` : ''}
                </span>
              )}
              <span className="nx-fine">
                Other matches:{' '}
                {remix.matches.map((m, i) => (m.file === remix.sample.file && m.sub === remix.sample.sub ? null : (
                  <button key={i} className="nx-link" disabled={busy} onClick={() => void runRemix(i)}>{m.sub || m.name}</button>
                )))}
              </span>
              {cert && <CertificateLine cert={cert} />}
              <label className="nx-field">
                Make a variant
                <input
                  type="text" value={variantAsk} placeholder="make it a fire truck with a ladder on top"
                  onChange={(e) => setVariantAsk(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && variantAsk.trim() && canAsk && !busy) void runVariant(); }}
                />
              </label>
              <div className="nx-row">
                <button className="nx-btn" disabled={busy || !variantAsk.trim() || !canAsk} onClick={() => void runVariant()}
                  title="Claude Sonnet edits this build into a variant; the certificate checks every round and sends problems back to fix">
                  {busy && abort ? 'Working…' : 'Make a variant with Claude'}
                </button>
                {abort && <button className="nx-btn" onClick={() => abort.abort()}>Cancel</button>}
              </div>
              {!canAsk && <span className="nx-fine">Run the app with <code>npm run dev</code> (it uses the Claude CLI you are signed in to), or add a Claude API key in Settings.</span>}
              {bridge && <span className="nx-fine">Uses Sonnet through your Claude login (counts toward your plan's usage, no API key).</span>}
            </>
          )}
          {variant && (
            <>
              <b>{variant.name}</b>
              <span className="nx-fine">
                {variant.summary} · Claude Sonnet · {variant.rounds} {variant.rounds === 1 ? 'round' : 'rounds'}
              </span>
              {variant.problems.length > 0 && (
                <span className="bm-generate-bad">Still to fix: {variant.problems.slice(0, 4).join('; ')}{variant.problems.length > 4 ? ` (+${variant.problems.length - 4} more)` : ''}</span>
              )}
            </>
          )}
          {sketch && (
            <>
              <b>{sketch.plan.name}</b>
              <span className="nx-fine">{sketch.voxels.w}×{sketch.voxels.d} studs · {Math.round(sketch.voxels.h / 3)} bricks high{cert ? ` · ${cert.pieces} pieces` : ''} · seed {sketch.seed} (Shuffle above for another)</span>
            </>
          )}
          {shownCert && (variant || sketch) && <CertificateLine cert={shownCert} dropped={sketch?.built.dropped} />}
        </div>
      )}
      {plan && (
        <button className="nx-btn nx-primary" disabled={busy || !shownCert?.buildable} onClick={() => void openAsProject(plan)}>
          Build it as a new project
        </button>
      )}
    </>
  );
}

/** What the certificate says, in one line: both generators show the same thing. */
function CertificateLine({ cert, dropped }: { cert: Certificate; dropped?: number }) {
  const extra = [
    cert.weak ? `${cert.weak} weak ${cert.weak === 1 ? 'joint' : 'joints'} (held by one stud)` : '',
    // a real set is not failed for it (its weights are estimates), so say it here
    cert.realModel && cert.tipping ? `may tip over on its own (${cert.tipping} ${cert.tipping === 1 ? 'part' : 'parts'})` : '',
    dropped ? `${dropped} loose ${dropped === 1 ? 'piece' : 'pieces'} left out` : '',
  ].filter(Boolean).join(' · ');
  if (cert.buildable && cert.realModel) {
    return <span className="bm-generate-ok">Checked: the set&apos;s own build, nothing floating or overlapping, every part known{extra ? ` · ${extra}` : ''}</span>;
  }
  if (cert.buildable) {
    return <span className="bm-generate-ok">Certified buildable: one piece, nothing floating or overlapping, stands without tipping{extra ? ` · ${extra}` : ''}</span>;
  }
  const why = [
    !cert.realModel && cert.parts > 1 && `${cert.parts} separate parts`,
    cert.floating && `${cert.floating} floating`,
    cert.overlapping && `${cert.overlapping} overlapping`,
    cert.unknown && `${cert.unknown} unknown parts`,
    !cert.realModel && cert.tipping && 'tips over (its weight is not above what it stands on)',
  ].filter(Boolean).join(', ');
  return <span className="bm-generate-bad">Not buildable: {why}</span>;
}
