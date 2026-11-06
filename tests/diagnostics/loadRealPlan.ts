/** Like loadRealModel, but from an already parsed plan (e.g. a .brickmotion project). Diagnostics only. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble, type Assembly, type Metrics } from '../../src/model/assemble';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { parseLDConfig } from '../../src/ldraw/colors';
import { parseLDraw, normalizeName } from '../../src/ldraw/parse';
import { shadowLookupFrom } from '../../src/ldraw/shadow';
import { allPartIds } from '../../src/state/useModel';
import type { Plan } from '../../src/plan/types';
const LDRAW = join(__dirname, '..', '..', 'public', 'ldraw');
const SHADOW = join(__dirname, '..', '..', 'public', 'data', 'ldcad-shadow.json');
export async function loadRealPlan(plan: Plan): Promise<{ asm: Assembly; metrics: Metrics }> {
  const lib = new PartLibrary(async (p) => { const f = join(LDRAW, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; });
  if (plan.parts) lib.addInline(new Map(Object.entries(plan.parts).map(([n, t]) => [normalizeName(n), parseLDraw(t, normalizeName(n))])));
  lib.setShadow(shadowLookupFrom(JSON.parse(readFileSync(SHADOW, 'utf8')).files));
  const map = new Map<string, PartMetrics>();
  for (const id of allPartIds(plan)) map.set(id, measurePart(await lib.loadPart(id), id));
  const metrics: Metrics = (p) => map.get(p) ?? measurePart(null, p);
  return { asm: assemble(plan, metrics, parseLDConfig(readFileSync(join(LDRAW, 'LDConfig.ldr'), 'utf8'))), metrics };
}
