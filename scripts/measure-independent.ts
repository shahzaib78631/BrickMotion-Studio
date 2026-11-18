/** Usage: npx tsx scripts/measure-independent.ts [--ldraw DIR] [--out FILE] [--all | PART ...] */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { measureIndependentPart } from './lib/independent-measurements';

let directory = resolve('public/ldraw');
let output = resolve('.cache/measurements/geometry.json');
let all = false;
const parts: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--ldraw' || arg === '--out') {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} needs a path`);
    if (arg === '--ldraw') directory = resolve(value); else output = resolve(value);
  } else if (arg === '--all') all = true;
  else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
  else parts.push(arg);
}
if (all && parts.length) throw new Error('Choose --all or specific part IDs');
const ids = [...new Set(all
  ? readdirSync(resolve(directory, 'parts')).filter(name => /\.dat$/i.test(name)).map(name => name.slice(0, -4))
  : parts.length ? parts : ['3001', '3005', '3024', '4070', '87087', '2780', '3700', '3743', '4143', '42610', '51011'])].sort();
const results = [];
for (const [i, id] of ids.entries()) {
  try { results.push(measureIndependentPart(directory, id)); }
  catch (error) { results.push({ id, status: 'error', issues: [String(error)], measurements: null }); }
  if ((i + 1) % 100 === 0) console.log(`Measured ${i + 1}/${ids.length}`);
}
const summary = {
  requested: ids.length,
  measured: results.filter(row => row.status === 'measured').length,
  unresolved: results.filter(row => row.status !== 'measured').length,
};
const report = {
  format: 'brickmotion-independent-measurements', version: 1,
  method: 'CAD geometry and primitive recognition; no connector or material tables',
  units: 'LDU', coordinateSystem: 'LDraw, Y down',
  inputDirectory: directory,
  caveat: 'Input hashes record identity, not origin. Use a separately verified official library before claiming independent provenance. Candidates are not certified connections or physical measurements.',
  notMeasured: ['insertion force', 'friction', 'joint limits', 'actuator screw lead', 'colour', 'roughness', 'IOR', 'transmission'],
  summary, parts: results,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(`${JSON.stringify(summary)} -> ${output}`);
if (summary.unresolved) process.exitCode = 2;
