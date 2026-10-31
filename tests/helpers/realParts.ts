/** Real LDraw parts measured with the LDCad shadow pack, as the app measures them. Tests skip without the library. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { shadowLookupFrom } from '../../src/ldraw/shadow';

const root = join(__dirname, '..', '..', 'public', 'ldraw');
const pack = join(__dirname, '..', '..', 'public', 'data', 'ldcad-shadow.json');
export const realPartsReady = existsSync(join(root, 'parts', '3001.dat')) && existsSync(pack);
const shadow = realPartsReady ? shadowLookupFrom(JSON.parse(readFileSync(pack, 'utf8')).files) : undefined;
const lib = new PartLibrary(async (p) => {
  const f = join(root, p);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}, shadow);
const cache = new Map<string, PartMetrics>();

export async function measureReal(id: string): Promise<PartMetrics> {
  const key = id.replace(/\.dat$/i, '');
  const hit = cache.get(key);
  if (hit) return hit;
  const m = measurePart(await lib.loadPart(key), key);
  cache.set(key, m);
  return m;
}

/** Measures parts up front and returns a synchronous lookup (the app's `metricsOf` shape). */
export async function realMetrics(ids: string[]): Promise<(part: string) => PartMetrics> {
  for (const id of ids) await measureReal(id);
  return (part) => {
    const m = cache.get(part.replace(/\.dat$/i, ''));
    if (!m) throw new Error(`part ${part} not measured`);
    return m;
  };
}
