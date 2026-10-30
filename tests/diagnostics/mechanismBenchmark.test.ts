/**
 * Real-model mechanism benchmark. Scores the detector against the hand-checked
 * mechanisms in benchmarks/mechanisms/<id>.expected.json.
 *
 *   npm run bench:mechanisms                 # print scores
 *   BENCH_WRITE=1 npm run bench:mechanisms   # also refresh the committed results
 *
 * Skipped when the model file or LDraw part data is not installed. Scores are
 * reported, not asserted: the detector is expected to improve against them.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectMechanisms } from '../../src/anim/motion/v4/mechanismLab';
import { MechanismSolver } from '../../src/anim/motion/v4/mechanismSolver';
import { formatBenchmark, scoreMechanismBenchmark, type BenchmarkSpec } from '../../src/anim/motion/benchmark/mechanismBenchmark';
import { loadRealModel, partDataInstalled } from './loadRealModel';

const ROOT = join(__dirname, '..', '..');
const DIR = join(ROOT, 'benchmarks', 'mechanisms');
const specs = readdirSync(DIR).filter(f => f.endsWith('.expected.json'));

describe('real-model mechanism benchmark', () => {
  for (const name of specs) {
    const spec = JSON.parse(readFileSync(join(DIR, name), 'utf8')) as BenchmarkSpec;
    const file = join(ROOT, spec.model.file);
    it.skipIf(!existsSync(file) || !partDataInstalled())(name.replace('.expected.json', ''), async () => {
      const text = readFileSync(file);
      if (spec.model.sha256) expect(createHash('sha256').update(text).digest('hex'), 'benchmark model file changed').toBe(spec.model.sha256);
      const { asm, metrics } = await loadRealModel(file);
      const result = scoreMechanismBenchmark(spec, asm, inspectMechanisms(asm, metrics));
      console.log(formatBenchmark(result));
      // A wrong benchmark file must fail loudly, not look like a detector miss.
      expect(result.checks.filter(c => c.status === 'unresolved'), 'benchmark points at missing parts').toEqual([]);
      if (process.env.BENCH_WRITE === '1') {
        const id = name.replace('.expected.json', '');
        writeFileSync(join(DIR, `${id}.results.json`), JSON.stringify(result, null, 2) + '\n');
        writeFileSync(join(DIR, `${id}.results.txt`), formatBenchmark(result) + '\n');
      }
    }, 600_000);
  }
});

describe('5590 ready-to-drive steering', () => {
  const file = join(ROOT, 'samples', '5590_-_whirl_n_wheel_super_truck.mpd');
  it.skipIf(!existsSync(file) || !partDataInstalled())('steers both front wheels together across its whole range', async () => {
    const { asm, metrics } = await loadRealModel(file);
    const s = inspectMechanisms(asm, metrics).detection.suggestions.find(x => x.evidence === 'measured-gear-train');
    expect(s?.title).toMatch(/^Rack steering — 4143 → 3647 → 3743 on a four-bar tie rod/);
    const p = s!.program, solver = new MechanismSolver(asm, p);
    const arms = p.joints.filter(j => j.parent === undefined && /4261/.test(asm.instances.find(i => i.key === j.body)!.part));
    expect(arms).toHaveLength(2);
    for (const end of [1, -1]) {
      solver.assembled();
      let last = 0;
      for (let i = 1; i <= 16; i++) {
        const f = solver.solve(end * p.driver.amplitude * i / 16);
        const [l, r] = arms.map(a => f.joints.get(a.id)!);
        // A parallelogram: both steering arms turn the same amount, steadily one way.
        expect(Math.abs(l - r)).toBeLessThan(1e-3);
        expect(Math.abs(l)).toBeGreaterThan(Math.abs(last));
        expect(f.rackContactErrorsLdu![0]).toBeLessThan(.1);
        last = l;
      }
      console.log(`5590 steering: knob ${(end * p.driver.amplitude * 180 / Math.PI).toFixed(0)}° -> wheels ${(last * 180 / Math.PI).toFixed(1)}°`);
    }
  }, 600_000);
});
