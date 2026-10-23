/**
 * Planner benchmark (LEGACY planner): plans one real LDraw model with the real
 * library and LDCad shadow pack and prints how many units end up uncertified.
 *
 *   BENCH_MODEL=/path/model.mpd npx vitest run tests/diagnostics/bench.test.ts --silent=false
 *
 * STEPLESS=1 drops the file's STEP lines and runs the same component split and
 * auto-steps the app runs when importing a step-less file.
 * Skipped when BENCH_MODEL is not set.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importLDraw } from '../../src/io/ldrawImport';
import { assemble, type Metrics } from '../../src/model/assemble';
import { ensureIds } from '../../src/plan/ids';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { parseLDConfig } from '../../src/ldraw/colors';
import { parseLDraw, normalizeName } from '../../src/ldraw/parse';
import { shadowLookupFrom } from '../../src/ldraw/shadow';
import { buildTimeline } from '../../src/anim/timeline';
import { allPartIds } from '../../src/state/useModel';
import { modelsWithoutSteps, autoStepPlan } from '../../src/plan/autoSteps';
import { splitPlanComponents } from '../../src/plan/components';

const ROOT = join(__dirname, '..', '..', 'public', 'ldraw');
const DATA = join(__dirname, '..', '..', 'public', 'data');
const MODEL = process.env.BENCH_MODEL;

describe.skipIf(!MODEL)('planner benchmark', () => {
  it('plans the model and reports uncertified units', async () => {
    expect(existsSync(MODEL!)).toBe(true);
    let text = readFileSync(MODEL!, 'utf8');
    if (process.env.STEPLESS === '1') text = text.split(/\r?\n/).filter((l) => !/^\s*0\s+(STEP|ROTSTEP)\b/i.test(l)).join('\n');
    let plan = ensureIds(importLDraw(text, MODEL!.split('/').pop()!));
    const lib = new PartLibrary(async (p) => {
      const f = join(ROOT, p);
      return existsSync(f) ? readFileSync(f, 'utf8') : null;
    });
    if (plan.parts) lib.addInline(new Map(Object.entries(plan.parts).map(([n, t]) => [normalizeName(n), parseLDraw(t, normalizeName(n))])));
    lib.setShadow(shadowLookupFrom((JSON.parse(readFileSync(join(DATA, 'ldcad-shadow.json'), 'utf8')) as { files: Record<string, string> }).files));
    const map = new Map<string, PartMetrics>();
    for (const id of allPartIds(plan)) map.set(id, measurePart(await lib.loadPart(id), id));
    const metrics: Metrics = (p: string) => map.get(p) ?? measurePart(null, p);
    const colors = parseLDConfig(readFileSync(join(ROOT, 'LDConfig.ldr'), 'utf8'));
    if (process.env.STEPLESS === '1' && modelsWithoutSteps(plan).length) {
      const split = splitPlanComponents(plan, metrics, colors);
      plan = autoStepPlan(split.plan, metrics, colors).plan;
      console.log(`[bench] step-less: ${split.components.length} components split aside: ${split.components.join(', ')}`);
    }
    const asm = assemble(plan, metrics, colors);
    const started = Date.now();
    let progressCalls = 0;
    const tl = buildTimeline(asm, metrics, {
      targetSeconds: 15,
      heroOrbit: true,
      accessSearchAttempts: Number(process.env.ACCESS_ATTEMPTS ?? 12),
      accessSearchWork: Number(process.env.ACCESS_WORK ?? 1500),
    }, () => void progressCalls++);
    const bad = tl.units.filter((u) => u.uncertified);
    console.log(`[bench] ${MODEL!.split('/').pop()}${process.env.STEPLESS === '1' ? ' (step-less)' : ''}: planned in ${((Date.now() - started) / 1000).toFixed(1)}s, ${progressCalls} progress reports`);
    console.log(`[bench] uncertified units: ${bad.length} / ${tl.units.length} (${bad.reduce((n, u) => n + u.keys.length, 0)} pieces)`);
    console.log(`[bench] uncertified keys: ${bad.map((u) => u.keys[0]).join(' ')}`);
  }, 900_000);
});
