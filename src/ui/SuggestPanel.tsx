import { useMemo, useState } from 'react';
import { MODEL_COUNT } from '../data/suggestRelations.generated';
import { partName } from '../state/partService';
import { acceptSuggestion, askSpot, clearSpot, highlightSuggestion, setSuggestionsOn, useSuggest } from '../state/suggest';
import type { SuggestionKind } from '../suggest/engine';
import { angledWall, lowellSphere, roundWall, snotSpacing, taper, technicPolygon, wedgeFor } from '../suggest/geometry';
import { TECHNIQUES, searchTechniques, techniqueById, type Technique } from '../suggest/techniques';
import { PaneHead } from './PaneHead';
import { PartThumb } from './PartThumb';

const KIND: Record<SuggestionKind, string> = { mirror: 'Mirror', repeat: 'Continue', habit: 'Builders do this', technique: 'Technique', fit: 'Fits here' };

/**
 * Build autocomplete: what to place next (drawn as a ghost in the view; Tab places it),
 * and the building-technique library with its calculators.
 */
export function SuggestPanel() {
  const { on, list, index, busy, dismissed, spot, spots } = useSuggest();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const found = useMemo(() => (q.trim() ? searchTechniques(q) : []), [q]);
  // techniques the current suggestions use come first when nothing is searched
  const shownTechniques = q.trim() ? found
    : [...new Set(list.map((s) => s.technique).filter((t): t is string => !!t))].map((id) => techniqueById.get(id)!).filter(Boolean);

  return (
    <div className="nx-pane bm-suggest">
      <PaneHead id="suggest" title="Suggest" count={on ? list.length : 'off'}
        help={<>Suggestions follow what you select (or the last piece placed). Each one is checked to connect and to sit inside nothing. <b>Tab</b> places the ghost, <b>`</b> shows the next one, <b>Esc</b> hides them. Right-click a piece and pick <b>What fits here?</b> for the parts that fit that stud, hole or clip, ranked by how often builders join them there in 67,185 BrickNet models (Kulits &amp; Schmid, CVPR 2026). Habits also come from {MODEL_COUNT} real models; techniques from the Brick Builder&apos;s Handbook.</>} />
      <label className="nx-hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={on} onChange={(e) => setSuggestionsOn(e.target.checked)} />
        Suggest what to place next
      </label>

      {on && (
        <>
          {spot ? (
            <div className="nx-sub bm-suggest-spot">
              <span>What fits this {spot.label} {busy && <span className="nx-fine">· thinking…</span>}</span>
              <button className="nx-btn nx-sm" onClick={clearSpot} title="Back to next-piece suggestions">Back</button>
            </div>
          ) : (
            <div className="nx-sub">Next pieces {busy && <span className="nx-fine">· loading parts…</span>}</div>
          )}
          {!spot && spots.length > 0 && (
            <div className="bm-suggest-spots" aria-label="Open connections">
              <span className="nx-fine">Open:</span>
              {summarise(spots.map((x) => x.label)).map(([label, n]) => (
                <button key={label} className="nx-chip" title={`Show what fits the first open ${label}`} onClick={() => askSpot(spots.find((x) => x.label === label)!)}>
                  {n > 1 ? `${n} ${plural(label)}` : `1 ${label}`}
                </button>
              ))}
            </div>
          )}
          {!list.length && !busy && <p className="nx-fine">{spot ? 'Nothing fits there without hitting another piece.' : 'Select a piece to see what could go on it, or right-click a stud or hole and pick What fits here?. Nothing here means nothing fits around it.'}</p>}
          <ol className="bm-suggest-list">
            {list.map((s, i) => (
              <li key={s.id} className={`bm-suggest-item ${i === index && !dismissed ? 'active' : ''}`} onMouseEnter={() => highlightSuggestion(i)}>
                <button className="bm-suggest-main" onClick={() => highlightSuggestion(i)} title={s.why}>
                  <span className="bm-suggest-thumbs">
                    {s.pieces.slice(0, 3).map((g, k) => <PartThumb key={k} id={g.part} color={g.color} size={34} />)}
                  </span>
                  <span className="bm-suggest-text">
                    <span className={`bm-suggest-kind k-${s.kind}`}>{KIND[s.kind]}</span>
                    <span className="bm-suggest-title">{s.title}</span>
                    <span className="nx-fine">{s.pieces.length > 1 ? `${s.pieces.length} pieces · ` : ''}{s.pieces.map((g) => partName(g.part) || g.part).slice(0, 2).join(', ')}</span>
                  </span>
                </button>
                <button className="nx-btn nx-sm" onClick={() => acceptSuggestion(i)} title="Place it (Tab)">Place</button>
                {i === index && !dismissed && <p className="nx-fine bm-suggest-why">{s.why}</p>}
              </li>
            ))}
          </ol>
        </>
      )}

      <div className="nx-sub">Techniques</div>
      <input type="search" aria-label="Search techniques" placeholder="What are you building? round tower, 45° wall, sideways…" value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim() && !found.length && <p className="nx-fine">No technique matches. Try: round, angle, sideways, offset, sphere, taper.</p>}
      {shownTechniques.map((t) => (
        <TechniqueCard key={t.id} t={t} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} />
      ))}
      {!q.trim() && (
        <details className="bm-suggest-all">
          <summary className="nx-fine">All {TECHNIQUES.length} techniques</summary>
          {[...new Set(TECHNIQUES.map((t) => t.section))].map((sec) => (
            <div key={sec}>
              <div className="nx-fine bm-suggest-section">{sec}</div>
              {TECHNIQUES.filter((t) => t.section === sec).map((t) => (
                <TechniqueCard key={t.id} t={t} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} />
              ))}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

const plural = (label: string) => (label.endsWith('s') ? label : label === 'open underside' ? 'open undersides' : `${label}s`);
function summarise(labels: string[]): [string, number][] {
  const n = new Map<string, number>();
  for (const l of labels) n.set(l, (n.get(l) ?? 0) + 1);
  return [...n.entries()];
}

function TechniqueCard({ t, open, onToggle }: { t: Technique; open: boolean; onToggle: () => void }) {
  return (
    <section className={`bm-tech ${open ? 'open' : ''}`}>
      <button className="bm-tech-head" onClick={onToggle} aria-expanded={open}>
        <span className="bm-tech-name">{t.name}</span>
        <span className="nx-fine">{t.goal}</span>
      </button>
      {open && (
        <div className="bm-tech-body">
          <p className="nx-fine"><b>Why it works:</b> {t.rule}</p>
          <ol className="bm-tech-steps">{t.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          {t.pitfall && <p className="nx-fine"><b>Watch out:</b> {t.pitfall}</p>}
          {t.parts.length > 0 && (
            <div className="bm-tech-parts">{t.parts.slice(0, 6).map((p) => <span key={p} title={partName(p) || p}><PartThumb id={p} size={30} /></span>)}</div>
          )}
          {t.calc && <Calculator kind={t.calc} />}
          {t.recipe && <p className="nx-fine">Select a piece: when this fits on it, it shows up under Next pieces.</p>}
          {t.url && <a className="nx-link" href={t.url} target="_blank" rel="noreferrer">Source: Brick Builder&apos;s Handbook</a>}
        </div>
      )}
    </section>
  );
}

function Num({ label, value, set, step = 1 }: { label: string; value: number; set: (v: number) => void; step?: number }) {
  return (
    <label className="nx-field">
      {label}
      <input type="number" value={value} step={step} onChange={(e) => set(Number(e.target.value) || 0)} />
    </label>
  );
}

function Calculator({ kind }: { kind: NonNullable<Technique['calc']> }) {
  const [a, setA] = useState(kind === 'roundWall' ? 18 : kind === 'lowellSphere' ? 27.2 : kind === 'technicPolygon' ? 8 : kind === 'snotSpacing' ? 2 : kind === 'taper' ? 28 : 45);
  const [b, setB] = useState(kind === 'technicPolygon' ? 5 : kind === 'taper' ? 7 : 0);
  const [c, setC] = useState(42);
  const row = (k: string, v: string) => <div className="bm-calc-row" key={k}><span>{k}</span><b>{v}</b></div>;
  return (
    <div className="bm-calc">
      {kind === 'angledWall' && (
        <>
          <Num label="Wall angle (°)" value={a} set={setA} />
          {angledWall(a).map((w, i) => (
            <div key={i} className="bm-calc-out">
              {row(`${w.legs[0]} × ${w.legs[1]} → ${w.span}`, `${w.angle.toFixed(1)}° ${w.exact ? 'exact' : 'near'}`)}
              <p className="nx-fine">{w.how}</p>
            </div>
          ))}
        </>
      )}
      {kind === 'roundWall' && (() => {
        const r = roundWall(a);
        return <><Num label="Inside diameter (studs)" value={a} set={setA} />{row('Hinge plates', String(r.hinges))}{row('Sides', String(r.sides))}{row('Turn per hinge', `${r.turn.toFixed(2)}°`)}{row('Outside diameter', `${r.outer} studs`)}<p className="nx-fine">{r.note}</p></>;
      })()}
      {kind === 'wedgeFor' && (
        <>
          <Num label="Angle (°)" value={a} set={setA} step={0.5} />
          {wedgeFor(a).map((w, i) => row(`${w.pair ? 'Two mirrored ' : ''}${w.wedge.size} wedge${w.pair ? 's' : ''} (${w.wedge.left}/${w.wedge.right})`, `${w.angle.toFixed(2)}°`))}
        </>
      )}
      {kind === 'technicPolygon' && (() => {
        const p = technicPolygon(a, b);
        return <><Num label="Sides" value={a} set={setA} /><Num label="Side length (studs)" value={b} set={setB} />{row('Interior angle', `${p.interior.toFixed(1)}°`)}{row('Connector', p.connector ? `#${p.connector.n} (${p.connector.part})` : 'none fits this polygon')}{row('Apothem', `${p.apothem.toFixed(2)} studs`)}{row('Axle', `${p.axle}L`)}</>;
      })()}
      {kind === 'lowellSphere' && (() => {
        const s = lowellSphere(a);
        return <><Num label="Diameter (studs)" value={a} set={setA} step={0.2} />{row('SNOT core', `${s.core} studs`)}{row('Panel thickness', `${s.panelPlates} plates`)}{row('Actual diameter', `${s.actual} studs`)}</>;
      })()}
      {kind === 'snotSpacing' && (() => {
        const s = snotSpacing(a);
        return <><Num label="Sideways length (studs)" value={a} set={setA} />{row('Equals', `${s.plates} plates`)}{row('Stack', s.fill || '—')}{s.halfPlate && <p className="nx-fine">Half a plate over: use a half-plate offset (inverted bracket or headlight brick).</p>}</>;
      })()}
      {kind === 'taper' && (() => {
        const t = taper(a, b, c);
        return <><Num label="From (studs wide)" value={a} set={setA} /><Num label="To (studs wide)" value={b} set={setB} /><Num label="Floors" value={c} set={setC} />{row('Step', `${t.step} stud${t.step > 1 ? 's' : ''} every ${t.every} floor${t.every > 1 ? 's' : ''}`)}<p className="nx-fine">{t.jumpers ? 'Too steep for plain parts: step with 2×2 jumper plates (half a stud per side).' : 'Plain bricks and plates can do it.'}</p></>;
      })()}
    </div>
  );
}
