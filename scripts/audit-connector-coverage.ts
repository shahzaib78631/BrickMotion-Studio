import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { matchesEmptyEntryReview, type EmptyEntryReview } from './lib/empty-entry-review';

const directory = resolve(process.argv[2] ?? '.cache/measurements');
const inventory = JSON.parse(readFileSync(resolve(directory, 'coverage.json'), 'utf8'));
const expected = new Set<string>(inventory.parts.map((p: { id: string }) => p.id));
const reviews: EmptyEntryReview[] = JSON.parse(readFileSync(resolve('docs/data/independent-connector-reviews.json'), 'utf8')).reviews;
const emptyReviews = new Map(reviews.map(review => [review.id, review]));
if (emptyReviews.size !== reviews.length) throw new Error('Duplicate empty-entry reviews');
const seen = new Set<string>();
const referenceParts = new Set<string>();
const errors: { part: string; issue: string }[] = [];
let records = 0;
const inheritanceExclusions: Record<string, number> = {};
const referenceIssues: { part: string; issues: string[] }[] = [];
for await (const line of createInterface({ input: createReadStream(resolve(directory, 'reference-library.jsonl')), crlfDelay: Infinity })) {
  const row = JSON.parse(line);
  if (!expected.has(row.id)) errors.push({ part: row.id, issue: 'Outside frozen inventory' });
  if (seen.has(row.id)) errors.push({ part: row.id, issue: 'Duplicate part' });
  seen.add(row.id);
  for (const exclusion of row.frames.excluded ?? []) {
    inheritanceExclusions[exclusion.reason] = (inheritanceExclusions[exclusion.reason] ?? 0) + 1;
  }
  if (row.frames.issues.length) referenceIssues.push({ part: row.id, issues: row.frames.issues });
  if (row.connectors.length) referenceParts.add(row.id);
  if (row.connectors.length !== row.frames.definitions.length) errors.push({ part: row.id, issue: 'Placed/full-frame count mismatch' });
  for (const connector of row.connectors) {
    records++;
    const vector = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
    if (!vector(connector.start) || !vector(connector.axis) || Math.abs(Math.hypot(...connector.axis) - 1) > 1e-5 ||
      !Number.isFinite(connector.radius) || connector.radius < 0 || !Number.isFinite(connector.length) || connector.length < 0)
      errors.push({ part: row.id, issue: 'Invalid connector frame or dimension' });
  }
}
for (const id of expected) if (!seen.has(id)) errors.push({ part: id, issue: 'Missing reference export row' });
const geometryParts = new Set<string>();
const geometryCandidates: string[] = [], noEvidence: string[] = [], incomplete: string[] = [];
const reviewedEmpty: string[] = [];
for await (const line of createInterface({ input: createReadStream(resolve(directory, 'unreferenced-geometry.jsonl')), crlfDelay: Infinity })) {
  const row = JSON.parse(line);
  if (geometryParts.has(row.id)) errors.push({ part: row.id, issue: 'Duplicate geometry row' });
  geometryParts.add(row.id);
  if (!expected.has(row.id) || referenceParts.has(row.id)) errors.push({ part: row.id, issue: 'Geometry row outside unreferenced inventory' });
  const m = row.measurements;
  const review = emptyReviews.get(row.id);
  if (review && matchesEmptyEntryReview(review, row)) reviewedEmpty.push(row.id);
  else if (!m) incomplete.push(row.id);
  else if (m.studs.length || m.connectorSurfaces.length || m.sphericalSurfaces.length) geometryCandidates.push(row.id);
  else noEvidence.push(row.id);
}
for (const id of expected) if (!referenceParts.has(id) && !geometryParts.has(id)) errors.push({ part: id, issue: 'Unreferenced part not measured' });
function optionalEvidence<T>(filename: string): T | null {
  const path = resolve(directory, filename);
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return null;
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.inventoryHash !== inventory.inventoryHash) throw new Error(`Stale independent evidence: ${filename}`);
  return data;
}
const assembly = optionalEvidence<{
  documented: { host: string; resolvedInsert: string; evidence: string; mirrored: boolean }[];
  modelCandidates: { host: string; insert: string; kind: string }[];
}>('assembly-use-cases.json');
const catalog = optionalEvidence<{
  source: { sha256: string };
  supplementalQueue: { id: string }[];
}>('assembly-reference-label-comparison.json');
const matched = optionalEvidence<{
  labelsSha256: string;
  parts: { id: string; status: string }[];
}>('assembly-reference-label-geometry.json');
if (matched && matched.labelsSha256 !== catalog?.source.sha256) throw new Error('Geometry match has no corresponding catalogue comparison');
const mechanical = optionalEvidence<{
  records: { id: string }[];
}>('mechanical-reference-candidates.json');
const documented = assembly?.documented.filter(p => !p.mirrored && p.evidence === 'part-author-placement');
const modelPairs = assembly?.modelCandidates.filter(p => p.kind !== 'nearby-surfaces');
const measureQueue = (ids: string[] | undefined) => ids ? [...new Set(ids)].filter(id => expected.has(id)).sort() : null;
const supplementalQueues = {
  documentedAssemblyParts: measureQueue(documented?.flatMap(p => [p.host, p.resolvedInsert])),
  targetedModelObservationParts: measureQueue(modelPairs?.flatMap(p => [p.host, p.insert])),
  catalogLabelsOnPartsWithoutShadow: measureQueue(catalog?.supplementalQueue.map(p => p.id)),
  catalogLabelsInMatchingGeometryAndFrame: measureQueue(matched?.parts.filter(p => p.status === 'same-geometry-and-frame').map(p => p.id)),
  mechanicalReferenceParts: measureQueue(mechanical?.records.map(p => p.id)),
};
const report = {
  inventoryHash: inventory.inventoryHash,
  fullCoverage: false,
  summary: { parts: expected.size, referenceParts: referenceParts.size, referenceRecords: records,
    geometryCandidateParts: geometryCandidates.length, noConnectorEvidence: noEvidence.length,
    incompleteGeometry: incomplete.length, reviewedEmptyEntries: reviewedEmpty.length, structuralErrors: errors.length, validatedParts: 0 },
  warning: 'Structural validity and detected geometry do not establish complete connector coverage or physical mating validity.',
  errors, reviewedEmpty, inheritanceExclusions, referenceIssues,
  supplementalEvidence: {
    counts: Object.fromEntries(Object.entries(supplementalQueues).map(([name, ids]) => [name, ids?.length ?? null])),
    queues: supplementalQueues,
    limitation: 'Each queue contains candidates for independent review. Part counts may overlap.',
  },
  queues: { geometryCandidates, noEvidence, incomplete },
};
writeFileSync(resolve(directory, 'coverage-audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary));
if (errors.length) process.exitCode = 1;
