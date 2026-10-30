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
