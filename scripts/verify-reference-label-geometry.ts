/** Match supplemental labels to the frozen CAD without changing part frames. */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { measureIndependentPart } from './lib/independent-measurements';

const [referenceRoot, archive, outputArg = '.cache/measurements'] = process.argv.slice(2);
if (!referenceRoot || !archive) throw new Error('Usage: tsx scripts/verify-reference-label-geometry.ts BRICKNET_LDRAW_ROOT DOWNLOAD_ARCHIVE [OUTPUT]');
const output = resolve(outputArg);
const inventory = JSON.parse(readFileSync(resolve(output, 'coverage.json'), 'utf8'));
const comparison = JSON.parse(readFileSync(resolve(output, 'assembly-reference-label-comparison.json'), 'utf8')) as {
  inventoryHash: string;
  source: { sha256: string };
  supplementalQueue: { id: string; labelCount: number }[];
};
if (comparison.inventoryHash !== inventory.inventoryHash) throw new Error('Stale label comparison');
const sha = createHash('sha256');
for await (const bytes of createReadStream(archive)) sha.update(bytes);
const ids = new Set<string>(inventory.parts.map((part: { id: string }) => part.id));
const result = [];
for (const { id, labelCount } of comparison.supplementalQueue) {
  if (!ids.has(id)) throw new Error(`Label part is outside the frozen inventory: ${id}`);
  const own = measureIndependentPart(inventory.root, id, undefined, false);
  const reference = measureIndependentPart(referenceRoot, id, undefined, false);
  for (const [path, hash] of Object.entries(own.sources)) {
    if (inventory.sources[path] !== hash) throw new Error(`CAD source differs from frozen inventory: ${path}`);
  }
  for (const [name, path] of Object.entries(own.resolutions)) {
    if (inventory.resolutions[name] !== path) throw new Error(`CAD source resolution changed: ${name}`);
  }
  const frozenSignature = own.measurements?.geometrySignature ?? null;
  const referenceSignature = reference.measurements?.geometrySignature ?? null;
  const status = !frozenSignature || !referenceSignature ? 'unresolved-geometry'
    : frozenSignature !== referenceSignature ? 'geometry-differs' : 'same-geometry-and-frame';
  const frozenBounds = own.measurements?.fullBoundsLdu;
  const referenceBounds = reference.measurements?.fullBoundsLdu;
  const maximumBoundsDifferenceLdu = frozenBounds && referenceBounds
    ? Math.max(...(['min', 'max'] as const).flatMap(k => frozenBounds[k].map((value, i) => Math.abs(value - referenceBounds[k][i]))))
    : null;
  result.push({ id, labelCount, status, frozenSignature, referenceSignature,
    maximumBoundsDifferenceLdu,
    frozenIssues: own.issues, referenceIssues: reference.issues,
    frozenSources: own.sources, referenceSources: reference.sources });
}
const same = result.filter(row => row.status === 'same-geometry-and-frame');
const summary = { comparedParts: result.length, sameGeometryAndFrame: same.length,
  labelsWithVerifiedGeometryAndFrame: same.reduce((n, row) => n + row.labelCount, 0),
  differentGeometry: result.filter(row => row.status === 'geometry-differs').length,
  differentGeometryButSameBounds: result.filter(row => row.status === 'geometry-differs' && row.maximumBoundsDifferenceLdu === 0).length,
  unresolvedGeometry: result.filter(row => row.status === 'unresolved-geometry').length };
const report = { format: 'brickmotion-reference-label-geometry-comparison', version: 1, fullCoverage: false,
  inventoryHash: inventory.inventoryHash, labelsSha256: comparison.source.sha256,
  referenceSnapshot: { source: 'https://keeper.mpdl.mpg.de/seafhttp/f/9b4a3c04e88940d1a718/?op=view', archiveSha256: sha.digest('hex') },
  method: 'Strict oriented triangle signature in identical part coordinates. No alignment, rounding, or alias transfer.',
  limitation: 'A matched frame supports transferring reference candidates. Fit, motion and coverage remain unverified.', summary, parts: result };
const path = resolve(output, 'assembly-reference-label-geometry.json');
writeFileSync(`${path}.tmp`, JSON.stringify(report) + '\n');
renameSync(`${path}.tmp`, path);
console.log(JSON.stringify(summary));
