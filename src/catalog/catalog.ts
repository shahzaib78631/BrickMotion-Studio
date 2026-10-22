import type { CatalogEntry } from './buildCatalog';

export type { CatalogEntry };

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Lower-cases and joins dimensions: "Brick 2 x 4" → "brick 2x4". */
export function normalizeQuery(s: string): string {
  return s
    .toLowerCase()
    .replace(/(\d)\s*x\s*(?=\d)/g, '$1x')
    .replace(/\s+/g, ' ')
    .trim();
}

const normCache = new WeakMap<CatalogEntry, string>();
const norm = (e: CatalogEntry) => {
  let n = normCache.get(e);
  if (n === undefined) normCache.set(e, (n = normalizeQuery(e.name)));
  return n;
};

export function searchCatalog(entries: CatalogEntry[], q: string, limit = 60): CatalogEntry[] {
  const query = normalizeQuery(q);
  if (!query) return entries.slice(0, limit);
  const tokens = query.split(' ');
  const scored: { e: CatalogEntry; s: number }[] = [];
  for (const e of entries) {
    const id = e.id.toLowerCase();
    let s: number;
    if (id === query) s = 0;
    else if (id.startsWith(query)) s = 1;
    else {
      const name = norm(e);
      const words = name.split(' ');
      if (!tokens.every((t) => name.includes(t))) continue;
      // whole-word matches and shorter (plainer) names rank higher
      const wordHits = tokens.filter((t) => words.includes(t)).length;
      s = 2 + (tokens.length - wordHits) * 0.5 + name.length / 1000;
    }
    scored.push({ e, s });
  }
  scored.sort((a, b) => a.s - b.s || collator.compare(a.e.id, b.e.id));
  return scored.slice(0, limit).map((x) => x.e);
}
