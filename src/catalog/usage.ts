import type { CatalogEntry } from './buildCatalog';

/**
 * How often a part is used, mined from the model corpora by
 * `scripts/build-part-usage.ts`. `sets`/`instances` count official OMR sets
 * (a part in any of a set's files counts once for that set), `models`/
 * `modelInstances` count the BrickNet corpus.
 */
export type PartUsage = { sets: number; instances: number; models: number; modelInstances: number };

/** Shape of `public/data/part-usage.json`: rows are `[partId, sets, instances, models, modelInstances]`. */
export type PartUsageFile = {
  format?: string;
  version?: number;
  sources?: { omrSets?: number; bricknetModels?: number };
  parts?: unknown;
};

let byId = new Map<string, PartUsage>();
/** Part ids, most used first. */
let ranked: string[] = [];
let sources = { omrSets: 0, bricknetModels: 0 };

const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Installs the mined dataset; malformed rows are dropped rather than trusted. */
export function loadPartUsage(data: PartUsageFile | null | undefined): void {
  const next = new Map<string, PartUsage>();
  for (const row of Array.isArray(data?.parts) ? data.parts : []) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0]) continue;
    const usage = { sets: finite(row[1]), instances: finite(row[2]), models: finite(row[3]), modelInstances: finite(row[4]) };
    // A row that says the part was never seen carries no information; the miner never emits one.
    if (!usage.sets && !usage.instances && !usage.models && !usage.modelInstances) continue;
    next.set(row[0], usage);
  }
  byId = next;
  ranked = [...next.entries()]
    .sort((a, b) => b[1].sets - a[1].sets || b[1].instances - a[1].instances || b[1].models - a[1].models || a[0].localeCompare(b[0]))
    .map(([id]) => id);
  sources = { omrSets: finite(data?.sources?.omrSets), bricknetModels: finite(data?.sources?.bricknetModels) };
}

export const getPartUsage = (): Map<string, PartUsage> => byId;
export const partUsageOf = (id: string): PartUsage | undefined => byId.get(id);

/** How much of each corpus was mined, for the panel's caption. */
export const usageSources = (): { omrSets: number; bricknetModels: number } => sources;

/** The most-used parts that are in the catalog, most official sets first. */
export function frequentParts(catalog: CatalogEntry[], limit = 60): CatalogEntry[] {
  const index = new Map(catalog.map((e) => [e.id, e]));
  const out: CatalogEntry[] = [];
  for (const id of ranked) {
    const entry = index.get(id);
    if (!entry) continue;
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** The catalog entries for `ids`, keeping the given order and dropping unknown ones. */
export function catalogEntries(catalog: CatalogEntry[], ids: readonly string[]): CatalogEntry[] {
  const index = new Map(catalog.map((e) => [e.id, e]));
  return ids.map((id) => index.get(id)).filter((e): e is CatalogEntry => !!e);
}
