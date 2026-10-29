import type { CatalogEntry } from '../catalog/buildCatalog';
import { parseLDConfig, type ColorDef } from '../ldraw/colors';
import { buildPartGeometry, type PartGeometry } from '../ldraw/geometry';
import { browserFetchText, PartLibrary, type FetchText } from '../ldraw/library';
import { measurePart, type PartMetrics } from '../ldraw/metrics';
import { normalizeName, parseLDraw, type LDrawFile } from '../ldraw/parse';
import { shadowLookupFrom, type ShadowLookup } from '../ldraw/shadow';

/** App-wide cache of LDraw parts: colors, catalog, measurements and geometry. */
let library = new PartLibrary(browserFetchText);
let shadow: ShadowLookup | undefined;
let colors = new Map<number, ColorDef>();
let catalog: CatalogEntry[] = [];
let catalogById = new Map<string, CatalogEntry>();
const metrics = new Map<string, PartMetrics>();
const geometry = new Map<string, PartGeometry | null>();
const pending = new Map<string, Promise<void>>();

export async function initPartService(fetchText: FetchText = browserFetchText): Promise<void> {
  library = new PartLibrary(fetchText, shadow);
  library.setStudLogos(studLogos);
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
  // Optional connector metadata (npm run setup:shadow). Without it parts simply have no snaps.
  try {
    const res = await fetch('/data/ldcad-shadow.json');
    if (res.ok) setShadowPack(((await res.json()) as { files: Record<string, string> }).files);
  } catch {
    /* not installed */
  }
}

/** Installs LDCad shadow-library connector metadata (file name → snap lines); parts are re-measured. */
export function setShadowPack(files: Record<string, string> | undefined): void {
  shadow = files ? shadowLookupFrom(files) : undefined;
  library.setShadow(shadow);
  metrics.clear();
  geometry.clear();
  pending.clear();
}

export const hasShadowPack = () => !!shadow;

/** Raised LEGO logos on studs (Materials). On by default, like product renders. */
let studLogos = true;
const geometryListeners = new Set<() => void>();
/** Called after loaded part geometry was rebuilt (e.g. logos switched); returns an unsubscribe. */
export function onGeometryChange(cb: () => void): () => void {
  geometryListeners.add(cb);
  return () => { geometryListeners.delete(cb); };
}
let logoSwitch: Promise<void> = Promise.resolve();
/** Switches stud logos and rebuilds the geometry of every part already loaded. */
export function setStudLogos(on: boolean): Promise<void> {
  if (on === studLogos) return logoSwitch;
  studLogos = on;
  library.setStudLogos(on);
  const ids = [...geometry.keys()];
  logoSwitch = logoSwitch.then(async () => {
    const old: PartGeometry[] = [];
    for (const id of ids) {
      const flat = await library.loadPart(id);
      if (studLogos !== on) return; // switched again meanwhile; that run rebuilds
      const prev = geometry.get(id);
      if (prev) old.push(prev);
      geometry.set(id, flat ? buildPartGeometry(flat) : null);
    }
    for (const cb of geometryListeners) cb();
    // only now nothing draws the old buffers any more
    for (const g of old) for (const b of [g.main, g.mainDoubleSided, g.edges, ...g.fixed.map((f) => f.geometry)]) b?.dispose();
  });
  return logoSwitch;
}
export const studLogosOn = () => studLogos;

const registered = new Map<string, string>();

/** Makes custom parts embedded in a plan (from imported files) loadable. */
export function registerInlineParts(parts: Record<string, string> | undefined): void {
  if (!parts) return;
  const fresh = new Map<string, LDrawFile>();
  for (const [name, text] of Object.entries(parts)) {
    const n = normalizeName(name);
    if (registered.get(n) === text) continue;
    registered.set(n, text);
    fresh.set(n, parseLDraw(text, n));
    const id = n.replace(/\.dat$/, '');
    metrics.delete(id);
    geometry.delete(id);
    pending.delete(id);
  }
  if (fresh.size) library.addInline(fresh);
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
        const request = p;
        const part = id;
        request.then(() => { if (pending.get(part) === request) pending.delete(part); },
          () => { if (pending.get(part) === request) pending.delete(part); });
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
