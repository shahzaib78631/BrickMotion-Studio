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

const LDRAW = join(__dirname, '..', '..', 'public', 'ldraw');
const SHADOW = join(__dirname, '..', '..', 'public', 'data', 'ldcad-shadow.json');
export const partDataInstalled = () => existsSync(join(LDRAW, 'LDConfig.ldr')) && existsSync(SHADOW);

export async function loadRealModel(file: string): Promise<{ asm: Assembly; metrics: Metrics }> {
  const plan = ensureIds(importLDraw(readFileSync(file, 'utf8'), file.split('/').pop()!));
  const lib = new PartLibrary(async (p) => { const f = join(LDRAW, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; });
  if (plan.parts) lib.addInline(new Map(Object.entries(plan.parts).map(([n, t]) => [normalizeName(n), parseLDraw(t, normalizeName(n))])));
  lib.setShadow(shadowLookupFrom(JSON.parse(readFileSync(SHADOW, 'utf8')).files));
  const map = new Map<string, PartMetrics>();
  for (const id of allPartIds(plan)) map.set(id, measurePart(await lib.loadPart(id), id));
  const metrics: Metrics = (p) => map.get(p) ?? measurePart(null, p);
  return { asm: assemble(plan, metrics, parseLDConfig(readFileSync(join(LDRAW, 'LDConfig.ldr'), 'utf8'))), metrics };
}
