import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { flattenPart } from '../../src/ldraw/flatten';
import { normalizeName, parseLDraw, type LDrawFile } from '../../src/ldraw/parse';
import { measurePartFunctions } from '../../src/anim/motion/parts/partFunctions';
import { connectorPrimitives } from './connector-primitives';

/** Geometry-only measurement. Deliberately bypasses PartLibrary, connector tables,
 * shadow metadata, saved metrics and material tables. No application data is written.
 * Results describe the supplied CAD files, not manufacturing tolerances or fit. */
export function measureIndependentPart(directory: string, part: string) {
  const root = realpathSync(directory);
  const id = normalizeName(part).replace(/\.dat$/, '');
  const files = new Map<string, LDrawFile | null>();
  const sources = new Map<string, string>();
  const issues = new Set<string>();
  const inside = (path: string) => {
    const rel = relative(root, path);
    return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
  };
  const getFile = (name: string): LDrawFile | null => {
    const key = normalizeName(name);
    if (files.has(key)) return files.get(key)!;
    for (const prefix of ['parts/', 'p/', 'models/', '']) {
      const path = resolve(root, prefix + key);
      if (!inside(path) || !statSync(path, { throwIfNoEntry: false })?.isFile()) continue;
      const real = realpathSync(path);
      if (!inside(real)) continue;
      const bytes = readFileSync(real);
      sources.set(relative(root, real), createHash('sha256').update(bytes).digest('hex'));
      const file = parseLDraw(bytes.toString('utf8'), key);
      files.set(key, file);
      return file;
    }
    files.set(key, null);
    issues.add(`Missing file: ${key}`);
    return null;
  };
  // Check every reachable path, including repeated subassemblies at different depths.
  // The flattener caps depth at 32; never certify a silently truncated part.
  const visitedDepth = new Map<string, number>();
  const visit = (name: string, stack: Set<string>, depth: number): void => {
    const key = normalizeName(name);
    if (stack.has(key)) { issues.add(`Cyclic reference: ${key}`); return; }
    if (depth > 32) { issues.add(`Depth limit: ${key}`); return; }
    if ((visitedDepth.get(key) ?? -1) >= depth) return;
    visitedDepth.set(key, depth);
    const file = getFile(key);
    if (!file) return;
    const next = new Set(stack).add(key);
    for (const cmd of file.cmds) if (cmd.t === 'ref') visit(cmd.file, next, depth + 1);
  };
  visit(`${id}.dat`, new Set(), 0);
  const file = getFile(`${id}.dat`);
  const provenance = () => Object.fromEntries([...sources].sort(([a], [b]) => a.localeCompare(b)));
  if (!file || issues.size) return {
    id, status: file ? 'incomplete' as const : 'missing' as const,
    issues: [...issues].sort(), sources: provenance(), measurements: null,
  };
  const flat = flattenPart(id, file, getFile, name => issues.add(`Missing file: ${name}`));
  const functions = measurePartFunctions(flat);
  const primitives = connectorPrimitives(file, getFile);
  if (!flat.fullBox) issues.add('No measurable geometry');
  const measurements = {
    description: flat.description,
    fullBoundsLdu: flat.fullBox,
    bodyBoundsLdu: flat.bodyBox,
    // Primitive recognition gives transformed stud bases, tips and radii.
    studs: primitives.studs,
    connectorSurfaces: primitives.cylinders,
    rejectedPrimitiveFrames: primitives.rejected,
    connectorCoverage: 'unreviewed' as const,
    // These are geometric candidates; an empty list is not proof of absence.
    candidates: functions,
  };
  if (!JSON.stringify(measurements, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) issues.add('Non-finite measurement');
    return value;
  })) issues.add('Unserializable measurement');
  return {
    id, status: issues.size ? 'incomplete' as const : 'measured' as const,
    issues: [...issues].sort(), sources: provenance(),
    measurements: issues.size ? null : measurements,
  };
}
