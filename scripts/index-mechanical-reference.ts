/** Index Kinebrick's authored corrections. The generated shadow-derived tables
 * are excluded because they do not provide a separate source of evidence. */
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeName } from '../src/ldraw/parse';
import { snapParams } from '../src/ldraw/shadow';
import { measureIndependentPart } from './lib/independent-measurements';
import { accessoryGeometry } from './lib/accessory-geometry';
import { radialPeriodicity } from './lib/radial-periodicity';

const commit = '82176b455d82b9d59ecba68cb54ad2121b72e457';
const directory = resolve(process.argv[2] ?? '.cache/measurements');
const input = resolve(directory, 'source-downloads/kinebrick/corrections.ldr');
const inventory = JSON.parse(readFileSync(resolve(directory, 'coverage.json'), 'utf8'));
const ids = new Set<string>(inventory.parts.map((part: { id: string }) => part.id));
const bytes = readFileSync(input);
const sourceHash = createHash('sha256').update(bytes).digest('hex');
if (sourceHash !== '5baca0e0131221035f04f9a9fdd0a9cd251e40dce4a74e922be6641f9ecb833e') {
  throw new Error('Kinebrick corrections differ from the pinned source');
}
const lines = bytes.toString('utf8').split(/\r?\n/);
const records = [], commandCounts: Record<string, number> = {};
let id = '';
for (const [index, line] of lines.entries()) {
  const block = /^0 FILE +(.+)\.dat\s*$/i.exec(line);
  if (block) { id = normalizeName(block[1]); continue; }
  const meta = /^0 !(LDCAD|KINEBRICK) +(\w+)\b/.exec(line);
  if (!meta) continue;
  const [, namespace, command] = meta;
  if (!id) throw new Error(`Record outside part block at line ${index + 1}`);
  const parameters = Object.fromEntries(snapParams(line));
  if (!Object.keys(parameters).length && command !== 'SNAP_CLEAR') throw new Error(`Missing fields at line ${index + 1}`);
  commandCounts[command] = (commandCounts[command] ?? 0) + 1;
  records.push({ id, namespace, command, line: index + 1, parameters,
    status: ids.has(id) ? 'reference-candidate' : 'outside-frozen-inventory',
    action: command === 'SNAP_CLEAR' || command === 'SNAP_INCL' ? 'inheritance-rule-needs-review' : 'review-geometry-and-motion' });
}
const summary = { records: records.length, distinctParts: new Set(records.map(record => record.id)).size,
  partsInFrozenInventory: new Set(records.filter(record => ids.has(record.id)).map(record => record.id)).size, commands: commandCounts };
const gears = new Map<string, ReturnType<typeof measureIndependentPart>>();
// Verify the repeated outer shape separately on the three parts the general
// detector misses. Coordinates select mesh sections, not a target repeat count.
const radialProbes = new Map<string, { axis: 'Y' | 'Z'; stations: number[] }>([
  ['32072', { axis: 'Z', stations: [-1.5, 0.5, 1.5] }],
  ['2855', { axis: 'Y', stations: [9.5, 11.5, 13.5] }],
  ['48168', { axis: 'Y', stations: [-22.5, -20.5, -18.5] }],
]);
const gearComparisons = records.filter(record => record.command === 'GEAR' && ids.has(record.id)).map(record => {
  if (!gears.has(record.id)) gears.set(record.id, measureIndependentPart(inventory.root, record.id));
  const part = gears.get(record.id)!;
  for (const [path, hash] of Object.entries(part.sources)) {
    if (inventory.sources[path] !== hash) throw new Error(`Gear CAD source differs from frozen inventory: ${path}`);
  }
  const count = Number(record.parameters.teeth), radius = Number(record.parameters.radius);
  if (!Number.isFinite(count) || !Number.isFinite(radius)) throw new Error(`Invalid gear at line ${record.line}`);
  const candidates = part.measurements?.candidates?.teeth ?? [];
  const toothMatches = candidates.filter(candidate => candidate.teeth === count);
  const probe = radialProbes.get(record.id);
  const sectionProfile = probe ? radialPeriodicity(accessoryGeometry(inventory.root, `${record.id}.dat`).triangles, probe.axis, probe.stations) : undefined;
  return { id: record.id, sourceLine: record.line, referenceToothCount: count, referencePitchRadiusLdu: radius,
    sameToothCountAndPitchWithinHalfLdu: toothMatches.some(candidate => Math.abs(candidate.pitchRadius - radius) <= 0.5),
    candidates, radialProbe: probe && { axis: probe.axis, sections: sectionProfile }, geometrySources: part.sources, geometryIssues: part.issues };
});
const result = { format: 'brickmotion-mechanical-reference-candidates', version: 1, fullCoverage: false,
  inventoryHash: inventory.inventoryHash, summary: { ...summary, gearComparisons: gearComparisons.length,
    toothAndPitchAgreement: gearComparisons.filter(gear => gear.sameToothCountAndPitchWithinHalfLdu).length }, source: {
    name: 'Kinebrick authored correction data by Erik Larsen and contributors', commit,
    url: `https://github.com/erik-larsen/kinebrick/blob/${commit}/data/corrections.ldr`,
    license: 'CC BY-SA 4.0', licenseUrl: `https://github.com/erik-larsen/kinebrick/blob/${commit}/data/LICENSE.md`,
    sha256: sourceHash,
  }, records, gearComparisons,
  limitations: ['Source parameters remain in their original notation. Coordinates, physical travel and mating are unverified.',
    'Inheritance rules are evidence. They do not overwrite the existing connector set.'],
};
const output = resolve(directory, 'mechanical-reference-candidates.json');
writeFileSync(`${output}.tmp`, JSON.stringify(result, null, 2) + '\n');
renameSync(`${output}.tmp`, output);
console.log(JSON.stringify(result.summary));
