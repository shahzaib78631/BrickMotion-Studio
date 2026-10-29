import { useMemo, useState } from 'react';
import type { ColorDef, ColorFinish } from '../ldraw/colors';
import { getColors } from '../state/partService';

const GROUPS: { id: string; label: string; finishes: ColorFinish[] }[] = [
  { id: 'solid', label: 'Solid', finishes: ['solid'] },
  { id: 'trans', label: 'Transparent', finishes: ['trans'] },
  { id: 'metal', label: 'Metallic & pearl', finishes: ['metal', 'chrome', 'pearl'] },
  { id: 'rubber', label: 'Rubber', finishes: ['rubber'] },
];

const FINISH_LABEL: Record<ColorFinish, string> = {
  solid: 'Solid', trans: 'Transparent', metal: 'Metallic', chrome: 'Chrome', pearl: 'Pearl', rubber: 'Rubber',
};

const RECENT_KEY = 'bm.recentColors';
const RECENT_MAX = 10;

export const colorLabel = (c: ColorDef) => c.name.replace(/_/g, ' ');

function hsl(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/** Greys first (dark → light), then the rainbow in hue bands, dark → light inside each band. */
function byShade(a: ColorDef, b: ColorDef) {
  const x = hsl(a.hex), y = hsl(b.hex);
  const gx = x.s < 0.15, gy = y.s < 0.15;
  if (gx !== gy) return gx ? -1 : 1;
  if (gx) return x.l - y.l;
  const bx = Math.floor(((x.h + 15) % 360) / 30), by = Math.floor(((y.h + 15) % 360) / 30);
  return bx - by || x.l - y.l;
}

function loadRecent(): number[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((n) => typeof n === 'number') : []; }
  catch { return []; }
}

function saveRecent(list: number[]) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

function Swatch({ c, active, onPick, onHover }: { c: ColorDef; active: boolean; onPick: () => void; onHover: (c: ColorDef | null) => void }) {
  const name = colorLabel(c);
  return <button type="button" className={`swatch ${c.finish}${active ? ' active' : ''}`} title={`${name} · ${FINISH_LABEL[c.finish]} · #${c.code}`}
    aria-label={name} aria-pressed={active} onClick={onPick}
    onMouseEnter={() => onHover(c)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(c)} onBlur={() => onHover(null)}>
    <span style={{ background: c.hex }} />
  </button>;
}

export function ColorSwatches({ value, onPick }: { value?: number; onPick: (code: number) => void }) {
  const table = getColors();
  const colors = useMemo(() => [...table.values()].filter((c) => c.code !== 16 && c.code !== 24 && c.code < 10000).sort(byShade), [table]);
  const [q, setQ] = useState('');
  const [hover, setHover] = useState<ColorDef | null>(null);
  const [recent, setRecent] = useState(loadRecent);

  const query = q.trim().toLowerCase();
  const matches = (c: ColorDef) => !query || colorLabel(c).toLowerCase().includes(query) || String(c.code) === query
    || FINISH_LABEL[c.finish].toLowerCase().startsWith(query);
  const groups = GROUPS.map((g) => ({ ...g, items: colors.filter((c) => g.finishes.includes(c.finish) && matches(c)) })).filter((g) => g.items.length);
  const recentColors = query ? [] : recent.map((code) => table.get(code)).filter((c): c is ColorDef => !!c);

  const pick = (code: number) => {
    const next = [code, ...recent.filter((n) => n !== code)].slice(0, RECENT_MAX);
    setRecent(next); saveRecent(next); onPick(code);
  };

  const shown = hover ?? (value !== undefined ? table.get(value) : undefined);
  const row = (items: ColorDef[]) => <div className="swatches">
    {items.map((c) => <Swatch key={c.code} c={c} active={value === c.code} onPick={() => pick(c.code)} onHover={setHover} />)}
  </div>;

  return <div className="bm-color-picker">
    <div className="bm-color-preview" aria-live="polite">
      <span className={`swatch big ${shown?.finish ?? ''}`}>{shown && <span style={{ background: shown.hex }} />}</span>
      {shown ? <div><strong>{colorLabel(shown)}</strong><small>{FINISH_LABEL[shown.finish]} · code {shown.code}{hover && value !== hover.code ? ' · click to apply' : ''}</small></div>
        : <div><strong>No color</strong><small>Pick a color below</small></div>}
    </div>
    <input type="search" className="bm-color-search" placeholder="Search colors (e.g. red, trans, 71)…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search colors" />
    <div className="bm-color-groups">
      {recentColors.length > 0 && <section><h5>Recently used</h5>{row(recentColors)}</section>}
      {groups.map((g) => <section key={g.id}><h5>{g.label} <small>{g.items.length}</small></h5>{row(g.items)}</section>)}
      {!groups.length && <p className="bm-color-empty">No colors match “{q}”.</p>}
    </div>
  </div>;
}
