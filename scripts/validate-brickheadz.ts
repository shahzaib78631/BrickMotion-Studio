/**
 * Mesh-level validator for generated BrickHeadz models (Phase 3).
 *
 *   npx tsx scripts/validate-brickheadz.ts <ldraw-dir> <file-or-dir> [--json=out.json]
 *
 * `<file-or-dir>` may be a .mpd / .plan.json file, or a directory scanned for
 * both. Exits non-zero if any model is not CLEAR.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { importLDraw } from '../src/io/ldrawImport';
import { exportLDraw } from '../src/io/ldrawExport';
import { certifyModel, offendingIds } from '../src/anim/brickheadz/mesh';
import { loadNodeLibrary } from './brickheadz-node';
import type { Plan } from '../src/plan/types';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const jsonFlag = process.argv.find((a) => a.startsWith('--json'));
const repairsFlag = process.argv.find((a) => a.startsWith('--repairs'));
const emitMpd = process.argv.includes('--emit-mpd');
if (positional.length < 2) {
  console.error('Usage: npx tsx scripts/validate-brickheadz.ts <ldraw-dir> <file-or-dir> [--json=out.json] [--repairs=out.json] [--emit-mpd]');
  process.exit(2);
}
const library = resolve(positional[0]);
const target = resolve(positional[1]);
const lib = loadNodeLibrary(library);

const repairs: Record<string, string[]> = {};
const checkFile = (path: string) => {
  const name = path.split(/[\\/]/).pop() ?? path;
  const text = readFileSync(path, 'utf8');
  const isPlan = path.toLowerCase().endsWith('.plan.json');
  const plan: Plan = isPlan ? (JSON.parse(text) as Plan) : importLDraw(text, name);
  const measures = lib.measurePlan(plan);
  if (emitMpd && isPlan) {
    // Emit the MPD from the plan through the studio's own placement, so the two
    // representations are identical (Python matrix placement can differ for parts
    // with unusual origins).
    const mpd = exportLDraw(plan, (id: string) => measures.get(id)!, lib.colors);
    writeFileSync(path.replace(/\.plan\.json$/i, '.mpd'), mpd);
  }
  const report = certifyModel(plan, measures, lib.colors);
  if (repairsFlag && report.verdict === 'BLOCKED') repairs[name] = offendingIds(report);
  return { name, ...report };
};

const targets: string[] = [];
if (statSync(target).isDirectory()) {
  for (const entry of readdirSync(target).sort()) if (/\.(mpd|plan\.json)$/i.test(entry)) targets.push(join(target, entry));
} else {
  targets.push(target);
}

const reports = targets.map(checkFile);
let blocked = 0;
for (const r of reports) {
  if (r.verdict !== 'CLEAR') blocked++;
  const detail = r.verdict === 'ERROR' ? `ERROR: ${r.note}` : `overlaps=${r.overlaps.length} floating=${r.floating.length} pieces=${r.pieces}`;
  console.log(`${r.verdict.padEnd(7)} ${r.name}  (${detail})`);
  for (const o of r.overlaps.slice(0, 8)) console.log(`    mesh overlap: ${o.parts}  ${o.a} / ${o.b}`);
}
console.log(`\n${reports.length - blocked}/${reports.length} CLEAR`);
if (jsonFlag) writeFileSync(resolve(jsonFlag.split('=')[1]), JSON.stringify({ reports }, null, 2) + '\n');
if (repairsFlag) writeFileSync(resolve(repairsFlag.split('=')[1]), JSON.stringify({ repairs }, null, 2) + '\n');
process.exit(blocked ? 1 : 0);
