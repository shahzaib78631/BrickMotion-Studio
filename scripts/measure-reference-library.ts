/** Export every part's independently sourced connector metadata without loading
 * application fallback tables. Output is a review dataset, never a coverage certificate. */
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { normalizeName, parseLDraw, type LDrawFile } from '../src/ldraw/parse';
import { independentShadowLookup } from './lib/independent-shadow';
import { referencePorts } from './lib/reference-ports';
import { referenceFrames } from './lib/reference-frames';
import { measurementPaths } from './lib/measurement-paths';
import { referenceConnectors } from './lib/reference-connectors';

const root = resolve(process.argv[2] ?? 'public/ldraw');
const referencePath = resolve(process.argv[3] ?? '.cache/measurements/independent-shadow.json');
const output = resolve(process.argv[4] ?? '.cache/measurements/reference-library.jsonl');
const bytes = readFileSync(referencePath);
const reference = JSON.parse(bytes.toString('utf8'));
if (!reference.files || typeof reference.files !== 'object') throw new Error('Missing reference files');
const shadow = independentShadowLookup(reference.files);
// Includes must not be silently truncated by ownSnaps' depth limit.
function checkIncludes(key: string, stack: string[] = []) {
  if (stack.includes(key)) throw new Error(`Reference include cycle: ${[...stack, key].join(' -> ')}`);
  if (stack.length > 8) throw new Error(`Reference include depth limit: ${key}`);
  const info = shadow(key);
  if (!info) throw new Error(`Missing reference include: ${key}`);
  for (const inc of info.includes) checkIncludes(normalizeName(inc.ref), [...stack, key]);
}
for (const key of Object.keys(reference.files)) checkIncludes(key);
const files = new Map<string, LDrawFile | null>();
const hashes: Record<string, string> = {};
const resolutions: Record<string, string> = {};
function load(name: string): LDrawFile | null {
  const key = normalizeName(name);
  if (files.has(key)) return files.get(key)!;
  for (const candidate of measurementPaths(key)) {
    const path = resolve(root, candidate);
    if (!path.startsWith(root + '/') || !statSync(path, { throwIfNoEntry: false })?.isFile()) continue;
    const data = readFileSync(path), file = parseLDraw(data.toString('utf8'), key);
    const resolvedPath = relative(root, path);
    hashes[resolvedPath] = createHash('sha256').update(data).digest('hex');
    resolutions[key] = resolvedPath;
    // Preserve the exact hierarchy and BFC commands; triangles are unnecessary
    // for placing explicit metadata. This is not geometry measurement.
    file.cmds = file.cmds.filter(c => c.t === 'ref' || c.t === 'bfc');
    files.set(key, file); return file;
  }
  files.set(key, null); return null;
}
mkdirSync(dirname(output), { recursive: true });
const fd = openSync(output + '.tmp', 'w');
const summary = { parts: 0, partsWithConnectors: 0, connectors: 0, entrances: 0, partsWithMissingGeometry: 0, validatedParts: 0 };
try {
  for (const name of readdirSync(resolve(root, 'parts')).filter(n => /\.dat$/i.test(n)).sort()) {
    const rootFile = load(name)!;
    const frames = referenceFrames(rootFile, load, shadow);
    const missing = frames.issues.filter(issue => issue.startsWith('Missing geometry: ')).map(issue => issue.slice('Missing geometry: '.length));
    const connectors = referenceConnectors(frames.definitions), entrances = referencePorts(connectors);
    summary.parts++;
    summary.partsWithConnectors += Number(connectors.length > 0);
    summary.connectors += connectors.length;
    summary.entrances += entrances.length;
    summary.partsWithMissingGeometry += Number(missing.length > 0);
    writeSync(fd, JSON.stringify({ id: name.slice(0, -4), status: 'unreviewed', connectors, entrances, frames,
      missingGeometry: missing.sort(), geometryValidated: false }) + '\n');
    if (summary.parts % 5000 === 0) console.log(`Placed reference connectors for ${summary.parts} parts`);
  }
} finally { closeSync(fd); }
renameSync(output + '.tmp', output);
writeFileSync(output + '.manifest.json', JSON.stringify({ format: 'brickmotion-reference-connectors', version: 1,
  summary, fullCoverage: false, interpretation: 'independent-shadow-v2', reference: { path: referencePath, source: reference.source,
    commit: reference.commit, license: reference.license, sha256: createHash('sha256').update(bytes).digest('hex') },
  inputGeometryHashes: hashes, resolutions,
  limitations: ['Connector existence is not completeness', 'No physical fit validation', 'Use full frames for keyed roll; axis-only profiles are insufficient'],
}, null, 2) + '\n');
console.log(JSON.stringify({ ...summary, output }));
