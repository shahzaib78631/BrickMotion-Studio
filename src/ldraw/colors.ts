export type ColorFinish = 'solid' | 'chrome' | 'metal' | 'pearl' | 'rubber' | 'trans';
export type ColorDef = { code: number; name: string; hex: string; edge: string; alpha: number; finish: ColorFinish };

export function normalizeColorName(name: string): string {
  return name.toLowerCase().replace(/_/g, ' ').replace(/\bgrey\b/g, 'gray').replace(/\s+/g, ' ').trim();
}

export function parseLDConfig(text: string): Map<number, ColorDef> {
  const table = new Map<number, ColorDef>();
  for (const line of text.split(/\r?\n/)) {
    const tok = line.trim().split(/\s+/);
    if (tok[0] !== '0' || tok[1] !== '!COLOUR') continue;
    const name = tok[2];
    const get = (key: string) => {
      const i = tok.indexOf(key);
      return i >= 0 ? tok[i + 1] : undefined;
    };
    const code = Number(get('CODE'));
    if (!Number.isFinite(code)) continue;
    const alpha = get('ALPHA') !== undefined ? Number(get('ALPHA')) : 255;
    let finish: ColorFinish = 'solid';
    if (tok.includes('CHROME')) finish = 'chrome';
    else if (tok.includes('METAL')) finish = 'metal';
    else if (tok.includes('PEARLESCENT')) finish = 'pearl';
    else if (tok.includes('RUBBER')) finish = 'rubber';
    if (alpha < 255) finish = 'trans';
    table.set(code, { code, name, hex: get('VALUE') ?? '#888888', edge: get('EDGE') ?? '#333333', alpha, finish });
  }
  return table;
}

const nameIndexCache = new WeakMap<Map<number, ColorDef>, Map<string, number>>();

/** Resolves a color code or name (case-insensitive, `_`/space and grey/gray tolerant). */
export function resolveColor(table: Map<number, ColorDef>, c: string | number): number | undefined {
  if (typeof c === 'number') return table.has(c) ? c : undefined;
  const s = c.trim();
  if (/^-?\d+$/.test(s)) return resolveColor(table, Number(s));
  let index = nameIndexCache.get(table);
  if (!index) {
    index = new Map([...table.values()].map((d) => [normalizeColorName(d.name), d.code]));
    nameIndexCache.set(table, index);
  }
  return index.get(normalizeColorName(s));
}
