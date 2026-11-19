/** Freeze the supported library inventory. Discovery is never counted as validation. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { normalizeName, parseLDraw, type LDrawFile } from '../src/ldraw/parse';
import { measurementPaths } from './lib/measurement-paths';

const root = resolve(process.argv[2] ?? 'public/ldraw');
const output = resolve(process.argv[3] ?? '.cache/measurements/coverage.json');
const files = new Map<string, { file: LDrawFile; hash: string; path: string } | null>();
const resolutions: Record<string, string> = {};
function load(name: string) {
  const key = normalizeName(name);
  if (files.has(key)) return files.get(key)!;
  for (const candidate of measurementPaths(key)) {
    const path = resolve(root, candidate);
    if (!path.startsWith(root + '/') || !statSync(path, { throwIfNoEntry: false })?.isFile()) continue;
    const bytes = readFileSync(path);
    resolutions[key] = relative(root, path);
    const item = { file: parseLDraw(bytes.toString('utf8'), key),
      hash: createHash('sha256').update(bytes).digest('hex'), path: relative(root, path) };
    files.set(key, item); return item;
  }
  files.set(key, null); return null;
}
type Reach = { primitives: Set<string>; missing: Set<string>; cyclic: boolean };
const cache = new Map<string, Reach>();
function reach(name: string, stack = new Set<string>()): Reach {
  const key = normalizeName(name);
  if (stack.has(key)) return { primitives: new Set(), missing: new Set(), cyclic: true };
  if (cache.has(key)) return cache.get(key)!;
  const item = load(key);
  const result: Reach = { primitives: new Set(), missing: new Set(), cyclic: false };
  if (!item) result.missing.add(key);
  else {
    if (item.path.startsWith('p/') && /stud|axle|peg|clip|hing|ball|joint|socket/i.test(key)) result.primitives.add(key);
    const next = new Set(stack).add(key);
    for (const cmd of item.file.cmds) if (cmd.t === 'ref') {
      const child = reach(cmd.file, next);
      for (const p of child.primitives) result.primitives.add(p);
      for (const p of child.missing) result.missing.add(p);
      result.cyclic ||= child.cyclic;
    }
  }
  if (!result.cyclic) cache.set(key, result);
  return result;
}
const ids = readdirSync(resolve(root, 'parts')).filter(name => /\.dat$/i.test(name)).sort();
const parts = ids.map(name => {
  const item = load(name), found = reach(name);
  return { id: name.slice(0, -4), sourceHash: item?.hash,
    description: item?.file.description, status: 'unreviewed',
    connectorPrimitives: [...found.primitives].sort(),
    missingFiles: [...found.missing].sort(), cyclic: found.cyclic,
    meshReviewRequired: true };
});
const primitiveUsage: Record<string, string[]> = {};
for (const part of parts) for (const primitive of part.connectorPrimitives)
  (primitiveUsage[primitive] ??= []).push(part.id);
const sources = Object.fromEntries([...files.values()].filter(x => x !== null)
  .map(x => [x.path, x.hash]).sort(([a], [b]) => a.localeCompare(b)));
const inventoryHash = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
const report = { format: 'brickmotion-connector-coverage', version: 1, inventoryHash,
  root, summary: { parts: parts.length, validatedParts: 0, unresolvedParts: parts.length,
    partsWithMissingFiles: parts.filter(x => x.missingFiles.length).length,
    partsWithCycles: parts.filter(x => x.cyclic).length,
    distinctConnectorPrimitives: Object.keys(primitiveUsage).length },
  fullCoverage: false, sources, resolutions, primitiveUsage, parts };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report.summary, inventoryHash, output }));
