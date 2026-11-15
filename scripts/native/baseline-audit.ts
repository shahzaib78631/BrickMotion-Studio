/**
 * Runs the current (web) engine over the corpus manifest, one child process per model, and
 * writes the baseline scoreboard (native rewrite, phase 0).
 *
 *   npx tsx scripts/native/baseline-audit.ts [--tier smoke|full] [--no-plan] [--jobs N] [--timeout seconds]
 *
 * Rows go to .cache/native-baseline/<id>.json and are reused on the next run, so a stopped
 * run resumes. The summary goes to native/corpus/baseline.json.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CorpusEntry } from './corpus-manifest';
import type { ScoreRow } from './baseline-worker';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const tier = arg('--tier') ?? 'smoke';
const noPlan = process.argv.includes('--no-plan');
const jobs = Number(arg('--jobs') ?? 4);
const timeoutMs = Number(arg('--timeout') ?? 180) * 1000;
const rowsDir = join(repo, '.cache/native-baseline');
const rowFile = (id: string) => join(rowsDir, `${id}.json`);

function runOne(entry: CorpusEntry): Promise<ScoreRow> {
  return new Promise(done => {
    const child = spawn(process.execPath, ['--max-old-space-size=4096', '--import', 'tsx', join(repo, 'scripts/native/baseline-worker.ts'), JSON.stringify(entry), ...(noPlan ? ['--no-plan'] : [])], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, BM_BASELINE_CHILD: '1' } });
    let out = '', settled = false;
    const finish = (row: ScoreRow) => { if (!settled) { settled = true; clearTimeout(timer); done(row); } };
    const failed = (error: string): ScoreRow => ({ id: entry.id, engine: 'web', ok: false, error });
    const last = (): ScoreRow | null => {
      const line = out.split('\n').reverse().find(l => l.startsWith('::row '));
      try { return line ? (JSON.parse(line.slice(6)) as ScoreRow) : null; } catch { return null; }
    };
    // A model that loaded but ran out of time while planning keeps its load columns.
    const timer = setTimeout(() => { child.kill('SIGKILL'); const partial = last(); finish(partial ? { ...partial, planOk: false, planMs: timeoutMs, error: 'plan-timeout' } : failed('timeout')); }, timeoutMs);
    child.stdout.on('data', d => { out += d; if (out.length > 1 << 20) out = out.slice(-(1 << 19)); });
    child.on('error', () => finish(failed('crash')));
    child.on('close', () => finish(last() ?? failed('crash')));
  });
}

const quantile = (values: number[], q: number) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };
export function summarize(rows: ScoreRow[]) {
  const sum = (f: (r: ScoreRow) => number | undefined) => rows.reduce((n, r) => n + (f(r) ?? 0), 0);
  const nums = (f: (r: ScoreRow) => number | undefined) => rows.map(f).filter((v): v is number => typeof v === 'number');
  const planned = rows.filter(r => r.planOk !== undefined);
  return {
    engine: 'web', date: new Date().toISOString().slice(0, 10), tier, models: rows.length, failed: rows.filter(r => !r.ok).length,
    errors: Object.fromEntries([...new Set(rows.filter(r => r.error).map(r => r.error!))].map(e => [e, rows.filter(r => r.error === e).length]).sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 20)),
    totals: {
      pieces: sum(r => r.pieces), joined: sum(r => r.joined), groups: sum(r => r.groups), overlaps: sum(r => r.overlaps), floating: sum(r => r.floating),
      unknownParts: sum(r => r.unknownParts?.length), fullyJoinedModels: rows.filter(r => r.ok && r.groups === 1).length,
      planned: planned.length, planOk: planned.filter(r => r.planOk).length, planFlagged: sum(r => r.planFlagged), buildFloating: sum(r => r.buildFloating),
      modelsWithBuildFloating: rows.filter(r => (r.buildFloating ?? 0) > 0).length,
    },
    p50: { loadMs: quantile(nums(r => r.loadMs), 0.5), planMs: quantile(nums(r => r.planMs), 0.5) },
    p95: { loadMs: quantile(nums(r => r.loadMs), 0.95), planMs: quantile(nums(r => r.planMs), 0.95) },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = (JSON.parse(readFileSync(join(repo, 'native/corpus/manifest.json'), 'utf8')) as CorpusEntry[]).filter(e => tier === 'full' || e.tier === 'smoke');
  const rows: ScoreRow[] = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < manifest.length) {
      const entry = manifest[next++];
      const file = rowFile(entry.id);
      let row: ScoreRow;
      if (existsSync(file)) row = JSON.parse(readFileSync(file, 'utf8'));
      else {
        row = await runOne(entry);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(row));
      }
      rows.push(row);
      console.log(`::progress ${++done}/${manifest.length}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  const summary = summarize(rows);
  writeFileSync(join(repo, 'native/corpus/baseline.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}
