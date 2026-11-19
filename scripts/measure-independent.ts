/** Usage: npx tsx scripts/measure-independent.ts [--ldraw DIR] [--out FILE] [--all | PART ...] */
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { independentShadowLookup } from './lib/independent-shadow';
import { dirname, resolve } from 'node:path';
import { measureIndependentPart } from './lib/independent-measurements';

let directory = resolve('public/ldraw');
let output = resolve('.cache/measurements/geometry.json');
let all = false;
let stream = false;
let mechanical = true;
let shadowPath: string | undefined;
const parts: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--ldraw' || arg === '--out' || arg === '--shadow' || arg === '--part-list') {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${arg} needs a path`);
    if (arg === '--ldraw') directory = resolve(value);
    else if (arg === '--shadow') shadowPath = resolve(value);
    else if (arg === '--part-list') {
      const list = JSON.parse(readFileSync(resolve(value), 'utf8'));
      if (!Array.isArray(list) || list.some(id => typeof id !== 'string')) throw new Error('Part list must be an array of IDs');
      parts.push(...list);
    }
    else output = resolve(value);
  } else if (arg === '--all') all = true;
  else if (arg === '--jsonl') stream = true;
  else if (arg === '--connectors-only') mechanical = false;
  else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
  else parts.push(arg);
}
if (all && parts.length) throw new Error('Choose --all or specific part IDs');
const ids = [...new Set(all
  ? readdirSync(resolve(directory, 'parts')).filter(name => /\.dat$/i.test(name)).map(name => name.slice(0, -4))
  : parts.length ? parts : ['3001', '3005', '3024', '4070', '87087', '2780', '3700', '3743', '4143', '42610', '51011'])].sort();
const results = [];
const shadowBytes = shadowPath ? readFileSync(shadowPath) : undefined;
const shadowData = shadowBytes ? JSON.parse(shadowBytes.toString('utf8')) : undefined;
if (shadowData && (!shadowData.files || typeof shadowData.files !== 'object')) throw new Error('Invalid shadow library');
// Keep upstream provenance exact: the application's lookup adds local patches.
const shadow = shadowData ? independentShadowLookup(shadowData.files) : undefined;
const summary = { requested: ids.length, measured: 0, unresolved: 0 };
mkdirSync(dirname(output), { recursive: true });
const fd = stream ? openSync(output + '.tmp', 'w') : undefined;
try {
  for (const [i, id] of ids.entries()) {
    let result;
    try { result = measureIndependentPart(directory, id, shadow, mechanical); }
    catch (error) { result = { id, status: 'error', issues: [String(error)], measurements: null }; }
    if (result.status === 'measured') summary.measured++; else summary.unresolved++;
    if (fd !== undefined) writeSync(fd, JSON.stringify(result) + '\n'); else results.push(result);
    if ((i + 1) % 100 === 0) console.log(`Measured ${i + 1}/${ids.length}`);
  }
} finally { if (fd !== undefined) closeSync(fd); }
const report = {
  format: 'brickmotion-independent-measurements', version: 1,
  method: shadow ? 'CAD geometry plus separately attributed LDCad reference connectors' : 'CAD geometry and primitive recognition; no connector or material tables',
  reference: shadowBytes ? { path: shadowPath, sha256: createHash('sha256').update(shadowBytes).digest('hex'),
    source: shadowData.source, commit: shadowData.commit, license: shadowData.license } : null,
  units: 'LDU', coordinateSystem: 'LDraw, Y down',
  inputDirectory: directory,
  caveat: 'Input hashes record identity, not origin. Use a separately verified official library before claiming independent provenance. Candidates are not certified connections or physical measurements.',
  notMeasured: ['insertion force', 'friction', 'joint limits', 'actuator screw lead', 'colour', 'roughness', 'IOR', 'transmission'],
  summary, mechanicsMeasured: mechanical, ...(stream ? { records: output } : { parts: results }),
};
if (stream) renameSync(output + '.tmp', output);
writeFileSync(stream ? output + '.manifest.json' : output, JSON.stringify(report, null, 2) + '\n');
console.log(`${JSON.stringify(summary)} -> ${output}`);
if (summary.unresolved) process.exitCode = 2;
