import type { CatalogEntry } from '../catalog/buildCatalog';
import { parseLDConfig, type ColorDef } from '../ldraw/colors';
import { buildPartGeometry, type PartGeometry } from '../ldraw/geometry';
import { browserFetchText, PartLibrary, type FetchText } from '../ldraw/library';
import { measurePart, type PartMetrics } from '../ldraw/metrics';

/** App-wide cache of LDraw parts: colors, catalog, measurements and geometry. */
let library = new PartLibrary(browserFetchText);
let colors = new Map<number, ColorDef>();
let catalog: CatalogEntry[] = [];
let catalogById = new Map<string, CatalogEntry>();
const metrics = new Map<string, PartMetrics>();
const geometry = new Map<string, PartGeometry | null>();
const pending = new Map<string, Promise<void>>();

export async function initPartService(fetchText: FetchText = browserFetchText): Promise<void> {
  library = new PartLibrary(fetchText);
  const cfg = await fetchText('LDConfig.ldr');
  if (!cfg) throw new Error('LDraw library not found. Run "npm run setup" first.');
  colors = parseLDConfig(cfg);
  try {
    const res = await fetch('/data/catalog.json');
    catalog = res.ok ? ((await res.json()) as CatalogEntry[]) : [];
  } catch {
    catalog = [];
  }
  catalogById = new Map(catalog.map((e) => [e.id, e]));
}

export const getColors = () => colors;
export const getCatalog = () => catalog;
export const getLibrary = () => library;

async function loadOne(id: string): Promise<void> {
  const flat = await library.loadPart(id);
  metrics.set(id, measurePart(flat, id));
  geometry.set(id, flat ? buildPartGeometry(flat) : null);
}

/** Loads, measures and builds geometry for parts, 6 at a time. */
export async function ensureParts(ids: string[]): Promise<void> {
  const todo = [...new Set(ids)].filter((id) => !metrics.has(id));
  const queue = [...todo];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      let p = pending.get(id);
      if (!p) {
        p = loadOne(id);
        pending.set(id, p);
      }
      await p;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

export function metricsOf(id: string): PartMetrics {
  return metrics.get(id) ?? measurePart(null, id);
}

export function isLoaded(id: string): boolean {
  return metrics.has(id);
}

export function geometryOf(id: string): PartGeometry | null {
  return geometry.get(id) ?? null;
}

export function partName(id: string): string {
  return catalogById.get(id)?.name ?? id;
}
