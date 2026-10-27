import { useAppSettings } from '../state/appSettings';
import { useStudio } from '../state/store';
import type { FloorStyle } from '../anim/pacing';
import { modelSteps, setRootHint } from '../plan/ops';
import { resetFloorShifts } from '../plan/pieceActions';
import { Card, Section } from './MaterialsPanel';
import { Ic } from './icons';

const STAGING: { id: FloorStyle; label: string; hint: string }[] = [
  { id: 'packed', label: 'Packed', hint: 'Tight rows, the least floor' },
  { id: 'spaced', label: 'Spaced', hint: 'Room around every piece' },
  { id: 'grid', label: 'Grid', hint: 'An even grid, centred in cells' },
  { id: 'rows', label: 'Rows', hint: 'One row per group (colour, part…)' },
  { id: 'scattered', label: 'Scattered', hint: 'Loosely laid, slightly turned' },
  { id: 'showcase', label: 'Showcase', hint: 'Balanced, centred product-shot rows' },
  { id: 'gallery', label: 'Gallery', hint: 'Centred rows separated by part or colour' },
  { id: 'fan', label: 'Camera fan', hint: 'A gentle curved spread around the centre' },
  { id: 'camera-frame', label: 'Camera frame', hint: 'Centered rows that adapt to the selected video aspect ratio' },
];
/** A tiny diagram of each staging style. */
function StagingDiagram({ id }: { id: FloorStyle }) {
  const cells: [number, number, number, number, number][] = [];
  const tone = ['#c7362b', '#2b2d33', '#8d939a', '#c7362b', '#2b2d33'];
  if (id === 'packed') [[0, 0, 9, 5], [10, 0, 5, 5], [16, 0, 7, 5], [0, 6, 6, 4], [7, 6, 9, 4], [17, 6, 6, 4], [0, 11, 12, 4], [13, 11, 5, 4]].forEach((c, i) => cells.push([...c, i % 5] as never));
  else if (id === 'spaced') [[0, 0, 7, 4], [11, 0, 5, 4], [0, 8, 5, 4], [9, 8, 8, 4], [3, 15, 6, 3], [13, 15, 5, 3]].forEach((c, i) => cells.push([...c, i % 5] as never));
  else if (id === 'grid') for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) cells.push([c * 6 + 1, r * 6 + 1, 4, 4, (r + c) % 5]);
  else if (id === 'rows') [0, 1, 2].forEach((r) => [0, 1, 2, 3].forEach((c) => cells.push([c * 6, r * 6 + 1, 5, 4, r])));
  else if (id === 'showcase') [[6, 1, 5, 4], [13, 1, 6, 4], [2, 8, 5, 4], [9, 8, 7, 4], [18, 8, 5, 4], [6, 15, 5, 3], [13, 15, 6, 3]].forEach((c, i) => cells.push([...c, i % 5] as never));
  else if (id === 'gallery') [[6, 1, 5, 4], [13, 1, 5, 4], [3, 8, 5, 4], [10, 8, 5, 4], [17, 8, 5, 4], [7, 15, 5, 3], [14, 15, 5, 3]].forEach((c, i) => cells.push([...c, i < 2 ? 0 : i < 5 ? 2 : 1] as never));
  else if (id === 'camera-frame') [[8, 1, 7, 3], [6, 6, 5, 4], [13, 6, 5, 4], [4, 12, 6, 4], [12, 12, 7, 4], [8, 17, 7, 2]].forEach((c, i) => cells.push([...c, i % 5] as never));
  else if (id === 'fan') [[9, 1, 6, 4], [3, 5, 5, 4], [16, 5, 5, 4], [0, 12, 5, 4], [7, 10, 5, 4], [14, 10, 5, 4], [21, 12, 4, 4]].forEach((c, i) => cells.push([...c, i % 5] as never));
  else [[1, 1, 5, 4], [9, 3, 6, 3], [17, 0, 5, 4], [3, 9, 6, 4], [12, 10, 4, 4], [18, 8, 5, 3], [6, 15, 5, 3], [15, 15, 6, 3]].forEach((c, i) => cells.push([...c, i % 5] as never));
  const rot = (i: number) => (id === 'scattered' ? ((i * 37) % 24) - 12 : 0);
  return (
    <svg viewBox="-1 -1 26 21" aria-hidden="true">
      {cells.map(([x, y, w, h, t], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx={0.8} fill={tone[t]} transform={`rotate(${rot(i)} ${x + w / 2} ${y + h / 2})`} />
      ))}
    </svg>
  );
}


/** Staging: how pieces wait on the floor before they fly in, and the order they go on. */
export function StagingPanel() {
  const s = useAppSettings();
  const v2 = ['construction-v2', 'construction-auto', 'construction-v3', 'construction-v3-auto', 'construction-v4'].includes(s.planner ?? '');
  const model = useStudio((st) => st.editingModel);
  const plan = useStudio((st) => st.plan);
  const pieces = modelSteps(plan, model).flatMap((step) => step.pieces);
  const moved = [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap((m) => m.steps)].reduce((n, step) => n + step.pieces.filter((i) => i.assembly?.floorShift).length, 0);
  const ids = pieces.map((i) => i.id).filter((id): id is string => !!id);
  const forced = pieces.filter((i) => i.assembly?.root).length;
  const force = (root: boolean) => useStudio.getState().apply((p) => setRootHint(p, model, ids, root));
  return (
    <div className="nx-pane bm-materials bm-staging" aria-label="Staging">
      <div className="nx-pane-head"><h3>Staging</h3></div>

      <Section title="Layout" value={STAGING.find((st) => st.id === s.floorStyle)?.label}>
        <div className="bm-mat-grid">
          {STAGING.map((st) => (
            <Card key={st.id} selected={s.floorStyle === st.id} label={st.label} hint={st.hint} onClick={() => !v2 && s.set({ floorStyle: st.id })}
              swatch={<span className="bm-mat-swatch bm-mat-staging"><StagingDiagram id={st.id} /></span>} />
          ))}
        </div>
        {s.floorStyle === 'camera-frame' && <span className="nx-hint">Using video frame {s.format}. Change the format in Video settings to reshape the staging rows. The model stays centered; final framing still depends on camera angle and zoom.</span>}
        <div className="nx-grid2">
          <label className="nx-field">
            Group
            <select aria-label="Group waiting pieces" disabled={v2} value={s.floorSort} onChange={(e) => s.set({ floorSort: e.target.value as typeof s.floorSort })}>
              <option value="step">By step</option>
              <option value="colour">By colour</option>
              <option value="part">By part</option>
              <option value="size">By size</option>
              <option value="all">All parts at once</option>
            </select>
          </label>
          <label className="nx-field">
            Where
            <select aria-label="Where waiting pieces lie" disabled={v2} value={s.floorSides} onChange={(e) => s.set({ floorSides: e.target.value as typeof s.floorSides })}>
              <option value="front-back">In front and behind</option>
              <option value="front">In front</option>
              <option value="behind">Behind</option>
              <option value="sides">Left and right</option>
              <option value="around">All around</option>
            </select>
          </label>
          <label className="nx-field">
            Side
            <select aria-label="Which side each piece waits on" disabled={v2} value={s.floorMatch} onChange={(e) => s.set({ floorMatch: e.target.value as typeof s.floorMatch })}>
              <option value="fill">Fill in order</option>
              <option value="nearest">Nearest to where it goes</option>
            </select>
          </label>
        </div>
        <span className="nx-hint">{v2
          ? 'The construction planners lay out their own work bays, so staging applies to the standard planners only.'
          : 'How the pieces wait on the floor before they fly in. Rows with "By colour" or "By part" give tidy product-shot rows. Showcase, Gallery and Camera fan centre the pieces around the build. Camera frame adapts the row proportions to the selected video aspect ratio. Changing this plans the build again.'}</span>
      </Section>

      <Section title="Waiting pieces" value={moved ? `${moved} moved` : undefined}>
        <span className="nx-hint">Drag a waiting piece in the Build view to move it.</span>
        {moved > 0 && (
          <button className="nx-btn nx-sm" onClick={() => useStudio.getState().apply(resetFloorShifts)}>
            <Ic name="undo" /> Put {moved} moved piece{moved === 1 ? '' : 's'} back
          </button>
        )}
        <label className="nx-check" title="Within a step, each piece waits for what it rests on">
          <input type="checkbox" disabled={v2} checked={s.bottomUp} onChange={(e) => s.set({ bottomUp: e.target.checked })} /> Build bottom-up
        </label>
      </Section>

      <Section title="Build order" value={forced ? `${forced} forced` : 'Smart'}>
        <span className="nx-hint">
          Drag clips in the Parts lane of the timeline to change when they go on. The planner keeps a piece after what it
          rests on. Hold <kbd>Alt</kbd> (<kbd>⌥</kbd>) while you drop to force your order, or click the pin on a clip to
          force or release it.
        </span>
        <div className="bm-btn-row">
          <button className="nx-btn nx-sm" disabled={!ids.length || forced === ids.length} title="Every piece of this model goes on exactly in the order you set. Pieces may pass through each other." onClick={() => force(true)}>
            <Ic name="pin" /> Force all
          </button>
          <button className="nx-btn nx-sm" disabled={!forced} title="Let the planner put pieces after what they rest on again" onClick={() => force(false)}>
            <Ic name="x" /> Release all
          </button>
        </div>
        {forced > 0 && <span className="nx-hint">Forced pieces keep your order even when they would pass through something already built.</span>}
      </Section>
    </div>
  );
}
