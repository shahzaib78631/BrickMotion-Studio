/**
 * Measures the current (web) engine on one corpus model and returns a scoreboard row
 * (native rewrite, phase 0). Run directly it audits one entry given as JSON on argv and
 * prints the row as the last line of stdout:
 *
 *   npx tsx scripts/native/baseline-worker.ts '<entry json>' [--no-plan]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CorpusEntry } from './corpus-manifest';
import { importLDraw } from '../../src/io/ldrawImport';
import { readStudioIo } from '../../src/io/studioIo';
import { ensureIds } from '../../src/plan/ids';
import { PartLibrary } from '../../src/ldraw/library';
import { measurePart, type PartMetrics } from '../../src/ldraw/metrics';
import { parseLDConfig } from '../../src/ldraw/colors';
import { parseLDraw, normalizeName } from '../../src/ldraw/parse';
import { shadowLookupFrom } from '../../src/ldraw/shadow';
import { assemble } from '../../src/model/assemble';
import { validate } from '../../src/model/validate';
import { modelConnections } from '../../src/plan/connectionGraph';

export type ScoreRow = {
  id: string; engine: 'web' | 'native'; ok: boolean; error: string | null;
  pieces?: number; unknownParts?: string[]; missingSubmodels?: string[]; loadMs?: number;
  joined?: number; groups?: number; overlaps?: number; floating?: number;
  planOk?: boolean; planMs?: number; planFlagged?: number; buildFloating?: number;
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ldrawDir = () => process.env.BM_LDRAW_DIR ?? join(repo, 'public/ldraw');
const dataDir = () => process.env.BM_DATA_DIR ?? '/Users/mac/Projects/BrickMotion-Data';
export const entryFile = (e: CorpusEntry) => resolve(e.source === 'omr' || e.source === 'bricknet' || e.source === 'moc' ? dataDir() : repo, e.path);

/** Sizes of the connected groups of `keys` under `edges`, largest first. */
function components(keys: string[], edges: [string, string][]): number[] {
  const parent = new Map(keys.map(k => [k, k]));
  const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r; };
  for (const [a, b] of edges) if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  const size = new Map<string, number>();
  for (const k of keys) size.set(find(k), (size.get(find(k)) ?? 0) + 1);
  return [...size.values()].sort((a, b) => b - a);
}

export async function auditModel(entry: CorpusEntry, opts: { plan: boolean }): Promise<ScoreRow> {
  const row: ScoreRow = { id: entry.id, engine: 'web', ok: false, error: null };
  try {
    const root = ldrawDir();
    const bytes = readFileSync(entryFile(entry));
    const text = /\.io$/i.test(entry.path) ? await readStudioIo(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) : bytes.toString('utf8');
    const started = performance.now();
    const plan = ensureIds(importLDraw(text, entry.path.split('/').at(-1)!));
    const lib = new PartLibrary(async p => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null));
    if (plan.parts) lib.addInline(new Map(Object.entries(plan.parts).map(([n, t]) => [normalizeName(n), parseLDraw(t, normalizeName(n))])));
    const shadow = join(repo, 'public/data/ldcad-shadow.json');
    if (existsSync(shadow)) lib.setShadow(shadowLookupFrom(JSON.parse(readFileSync(shadow, 'utf8')).files));
    const ids = new Set<string>();
    for (const step of [...plan.steps, ...Object.values(plan.submodels ?? {}).flatMap(s => s.steps)]) for (const item of step.pieces) if ('part' in item) ids.add(item.part);
    const table = new Map<string, PartMetrics>(), unknown: string[] = [];
    for (const id of ids) {
      const flat = await lib.loadPart(id);
      if (!flat) unknown.push(id);
      table.set(id, measurePart(flat, id));
    }
    const metrics = (id: string) => table.get(id) ?? measurePart(null, id);
    const asm = assemble(plan, metrics, parseLDConfig(readFileSync(join(root, 'LDConfig.ldr'), 'utf8')));
    row.loadMs = performance.now() - started;
    row.pieces = asm.instances.length;
    row.unknownParts = unknown.sort();
    row.missingSubmodels = [...new Set(asm.problems.filter(p => p.kind === 'missing-submodel').map(p => p.detail))].sort();

    const connections = modelConnections(asm, metrics);
    const edges = connections.map(c => [c.a.key, c.b.key] as [string, string]);
    const groups = components(asm.instances.map(i => i.key), edges);
    row.joined = groups[0] ?? 0;
    row.groups = groups.length;
    const warnings = validate(asm);
    row.overlaps = warnings.filter(w => w.kind === 'overlap').length;
    row.floating = warnings.filter(w => w.kind === 'floating').length;
    row.ok = true;

    if (opts.plan) {
      // Printed before planning, so a planning timeout still keeps the load and joint columns.
      if (process.env.BM_BASELINE_CHILD) console.log('\n::row ' + JSON.stringify(row));
      const { buildTimeline } = await import('../../src/anim/timeline');
      const { initializeCollisionKernel } = await import('../../src/anim/collisionKernel');
      await initializeCollisionKernel(readFileSync(join(repo, 'src/anim/kernel/collision.wasm')));
      const planStart = performance.now();
      try {
        const timeline = buildTimeline(asm, metrics, { planner: 'legacy', targetSeconds: 15, heroOrbit: true });
        row.planOk = true;
        row.planFlagged = timeline.units.filter(u => u.uncertified || u.hidden).length;
        // Pieces that land joined to nothing already built. The first piece of each model is exempt.
        const near = new Map<string, Set<string>>();
        for (const [a, b] of edges) { (near.get(a) ?? near.set(a, new Set()).get(a)!).add(b); (near.get(b) ?? near.set(b, new Set()).get(b)!).add(a); }
        const modelOf = new Map(asm.instances.map(i => [i.key, i.model]));
        const placed = new Set<string>(), started = new Set<string>();
        let floating = 0;
        for (const unit of [...timeline.units].sort((a, b) => a.start - b.start)) {
          if (unit.kind !== 'piece') continue;
          const model = modelOf.get(unit.keys[0]) ?? '';
          const joined = unit.keys.some(k => [...(near.get(k) ?? [])].some(n => placed.has(n)));
          if (!joined && started.has(model)) floating++;
          started.add(model);
          for (const k of unit.keys) placed.add(k);
        }
        row.buildFloating = floating;
      } catch (e) {
        row.planOk = false;
        row.error = (e as { code?: string }).code ?? (e as Error).name ?? 'plan-error';
      }
      row.planMs = performance.now() - planStart;
    }
  } catch (e) {
    row.ok = false;
    row.error = (e as Error).message?.slice(0, 300) || 'error';
  }
  return row;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entry = JSON.parse(process.argv[2]) as CorpusEntry;
  const row = await auditModel(entry, { plan: !process.argv.includes('--no-plan') });
  console.log('\n::row ' + JSON.stringify(row));
  process.exit(0);
}
