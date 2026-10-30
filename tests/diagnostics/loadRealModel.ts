/** Loads a real LDraw model the way the app does: real part library, real
 * part metrics and the LDCad connector pack. Needs `npm run setup` data. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importLDraw } from '../../src/io/ldrawImport';
import { assemble, type Assembly, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { parseLDConfig } from '../../src/ldraw/colors';
import { parseLDraw, normalizeName } from '../../src/ldraw/parse';
import { shadowLookupFrom } from '../../src/ldraw/shadow';
import { allPartIds } from '../../src/state/useModel';
import { ensurePartFunctions, loadPartFunctionTable } from '../../src/anim/motion/parts/partFunctions';

const LDRAW = join(__dirname, '..', '..', 'public', 'ldraw');
const SHADOW = join(__dirname, '..', '..', 'public', 'data', 'ldcad-shadow.json');
/** Packed part functions (npm run data:part-functions); without it parts are measured as they load. */
const FUNCTIONS = join(__dirname, '..', '..', 'public', 'data', 'part-functions.json');
let tableLoaded = false;
export const partDataInstalled = () => existsSync(join(LDRAW, 'LDConfig.ldr')) && existsSync(SHADOW);

export async function loadRealModel(file: string): Promise<{ asm: Assembly; metrics: Metrics }> {
  const plan = ensureIds(importLDraw(readFileSync(file, 'utf8'), file.split('/').pop()!));
  const lib = new PartLibrary(async (p) => { const f = join(LDRAW, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; });
  if (plan.parts) lib.addInline(new Map(Object.entries(plan.parts).map(([n, t]) => [normalizeName(n), parseLDraw(t, normalizeName(n))])));
  lib.setShadow(shadowLookupFrom(JSON.parse(readFileSync(SHADOW, 'utf8')).files));
  const map = new Map<string, PartMetrics>();
  if (!tableLoaded && existsSync(FUNCTIONS)) { loadPartFunctionTable(JSON.parse(readFileSync(FUNCTIONS, 'utf8'))); tableLoaded = true; }
  const embedded = new Set(Object.keys(plan.parts ?? {}).map(n => normalizeName(n).replace(/\.dat$/, '')));
  for (const id of allPartIds(plan)) {
    const flat = await lib.loadPart(id);
    map.set(id, measurePart(flat, id));
    // Gears and racks: from the packed table, or measured from geometry as the app does without it.
    ensurePartFunctions(id, flat, embedded.has(id.replace(/\.dat$/i, '')));
  }
  const metrics: Metrics = (p) => map.get(p) ?? measurePart(null, p);
  return { asm: assemble(plan, metrics, parseLDConfig(readFileSync(join(LDRAW, 'LDConfig.ldr'), 'utf8'))), metrics };
}
