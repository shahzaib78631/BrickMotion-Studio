import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeName, parseLDraw } from '../src/ldraw/parse';
import { referenceSignature } from './lib/reference-equivalence';

const directory = resolve(process.argv[2] ?? '.cache/measurements');
const inventory = JSON.parse(readFileSync(resolve(directory, 'coverage.json'), 'utf8'));
const referenceManifest = JSON.parse(readFileSync(resolve(directory, 'reference-library.jsonl.manifest.json'), 'utf8'));
for (const [name, hash] of Object.entries(referenceManifest.inputGeometryHashes)) {
  const path = relative(inventory.root, resolve(inventory.root, name));
  if (inventory.sources[path] !== hash) throw new Error(`Reference geometry differs from frozen inventory: ${name}`);
}
const closures = new Map<string, Set<string>>();
const verifiedSources = new Map<string, string[]>();
function sourceClosure(name: string, stack = new Set<string>()): Set<string> {
  const key = normalizeName(name);
  if (stack.has(key)) throw new Error(`Geometry cycle while verifying identity: ${key}`);
  if (closures.has(key)) return closures.get(key)!;
  const path = inventory.resolutions[key];
  if (!path) throw new Error(`Missing frozen resolution: ${key}`);
  if (!verifiedSources.has(path)) {
    const bytes = readFileSync(resolve(inventory.root, path));
    if (createHash('sha256').update(bytes).digest('hex') !== inventory.sources[path]) throw new Error(`Source changed since inventory freeze: ${path}`);
    verifiedSources.set(path, parseLDraw(bytes.toString('utf8'), key).cmds.flatMap(cmd => cmd.t === 'ref' ? [cmd.file] : []));
  }
  const result = new Set<string>([path]);
  for (const child of verifiedSources.get(path)!) for (const file of sourceClosure(child, new Set(stack).add(key))) result.add(file);
  closures.set(key, result);
  return result;
}
const expected = new Set<string>(inventory.parts.map((p: { id: string }) => p.id));
const geometry = new Map<string, { signature: string; sourceDigest: string }>();
const indexedIds = new Set<string>();
for await (const line of createInterface({ input: createReadStream(resolve(directory, 'geometry-index.jsonl')), crlfDelay: Infinity })) {
  const row = JSON.parse(line);
  if (row.inventoryHash !== inventory.inventoryHash || !expected.has(row.id) || indexedIds.has(row.id)) throw new Error(`Invalid/stale geometry index row: ${row.id}`);
  indexedIds.add(row.id);
  if (row.status === 'measured' && row.signature) {
    const sources = Object.fromEntries([...sourceClosure(`${row.id}.dat`)].sort((a, b) => a.localeCompare(b)).map(path => [path, inventory.sources[path]]));
    const digest = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
    if (digest !== row.sourceDigest) throw new Error(`Geometry identity uses a different source closure: ${row.id}`);
    geometry.set(row.id, row);
  }
}
if (indexedIds.size !== expected.size) throw new Error('Geometry index does not cover the frozen inventory');
const donors = new Map<string, { id: string; referenceSignature: string }[]>();
const withoutReference: string[] = [];
const referenceWithoutGeometry: string[] = [];
const referenceIds = new Set<string>();
for await (const line of createInterface({ input: createReadStream(resolve(directory, 'reference-library.jsonl')), crlfDelay: Infinity })) {
  const row = JSON.parse(line), g = geometry.get(row.id);
  if (!expected.has(row.id) || referenceIds.has(row.id)) throw new Error(`Invalid reference row: ${row.id}`);
  referenceIds.add(row.id);
  if (!row.connectors.length) { withoutReference.push(row.id); continue; }
  if (!g || row.missingGeometry.length || row.frames.issues.length) { referenceWithoutGeometry.push(row.id); continue; }
  const list = donors.get(g.signature) ?? [];
  list.push({ id: row.id, referenceSignature: referenceSignature(row.frames.definitions) });
  donors.set(g.signature, list);
}
if (referenceIds.size !== expected.size) throw new Error('Incomplete reference export');
const matches = [], conflicts = [], unmatched = [];
for (const id of withoutReference) {
  const g = geometry.get(id), candidates = g ? donors.get(g.signature) : undefined;
  if (!candidates?.length) { unmatched.push(id); continue; }
  const evidence = { id, geometrySignature: g!.signature, sourceDigest: g!.sourceDigest, donors: candidates };
  if (new Set(candidates.map(d => d.referenceSignature)).size !== 1) conflicts.push(evidence);
  else matches.push({ ...evidence, status: 'geometry-equivalent-reference-candidate' });
}
const report = { inventoryHash: inventory.inventoryHash, fullCoverage: false,
  method: 'Exact oriented triangle multiset in identical part coordinates; no filename inference, rounding or alignment',
  limitation: 'Reference transfer candidates do not establish completeness, material equivalence or validated physical fit',
  summary: { unreferencedParts: withoutReference.length, matches: matches.length, conflicts: conflicts.length, unmatched: unmatched.length,
    referencePartsWithoutCompleteGeometry: referenceWithoutGeometry.length },
  matches, conflicts, unmatched, referenceWithoutGeometry };
writeFileSync(resolve(directory, 'equivalent-references.json'), JSON.stringify(report, null, 2) + '\n');
// Materialize the small, conflict-free candidate layer for mating tests. It is
// deliberately not imported by either application engine.
const selected = new Set(matches.map(match => match.donors[0].id));
const payloads = new Map<string, { connectors: unknown[]; entrances: unknown[]; frames: unknown }>();
for await (const line of createInterface({ input: createReadStream(resolve(directory, 'reference-library.jsonl')), crlfDelay: Infinity })) {
  const row = JSON.parse(line);
  if (selected.has(row.id)) payloads.set(row.id, row);
}
const transferred = matches.map(match => {
  const donor = match.donors[0], payload = payloads.get(donor.id);
  if (!payload) throw new Error(`Missing equivalent donor payload: ${donor.id}`);
  return { id: match.id, status: 'reference-transfer-candidate', referenceFrom: donor.id,
    geometrySignature: match.geometrySignature, targetSourceDigest: match.sourceDigest,
    donorSourceDigest: geometry.get(donor.id)!.sourceDigest, referenceSignature: donor.referenceSignature,
    connectors: payload.connectors, entrances: payload.entrances, frames: payload.frames };
});
writeFileSync(resolve(directory, 'equivalent-connectors.json'), JSON.stringify({
  format: 'brickmotion-equivalent-connector-candidates', version: 1,
  inventoryHash: inventory.inventoryHash, reference: referenceManifest.reference,
  interpretation: referenceManifest.interpretation,
  fullCoverage: false, parts: transferred,
}, null, 2) + '\n');
console.log(JSON.stringify(report.summary));
