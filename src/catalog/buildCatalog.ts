export type CatalogEntry = { id: string; name: string; category: string };

export type RebrickableData = {
  /** part_num → part_cat_id */
  parts: Map<string, string>;
  /** part_cat_id → category name */
  categories: Map<string, string>;
};

/** Reads the header of an LDraw part file. Returns null for moved, alias and obsolete parts. */
export function parseDatHeader(fileName: string, text: string): CatalogEntry | null {
  const lines = text.split(/\r?\n/);
  const first = lines.find((l) => l.trim().length > 0);
  if (!first || !first.trim().startsWith('0')) return null;
  const name = first.trim().replace(/^0\s*/, '').replace(/\s+/g, ' ').trim();
  if (!name || /^[~=_|]/.test(name)) return null;

  let category: string | undefined;
  for (const l of lines) {
    const m = /^\s*0\s+!CATEGORY\s+(.+?)\s*$/.exec(l);
    if (m) {
      category = m[1];
      break;
    }
  }
  const id = fileName.replace(/\\/g, '/').split('/').pop()!.replace(/\.dat$/i, '');
  return { id, name, category: category ?? name.split(' ')[0] };
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function buildCatalog(headers: CatalogEntry[], rb: RebrickableData): CatalogEntry[] {
  return headers
    .map((h) => {
      const catId = rb.parts.get(h.id);
      const catName = catId !== undefined ? rb.categories.get(catId) : undefined;
      return catName ? { ...h, category: catName } : h;
    })
    .sort((a, b) => collator.compare(a.id, b.id));
}
