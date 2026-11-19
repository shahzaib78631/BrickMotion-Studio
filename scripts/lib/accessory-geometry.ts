import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { flattenPart } from '../../src/ldraw/flatten';
import { normalizeName, parseLDraw, type LDrawFile } from '../../src/ldraw/parse';
import { measurementPaths } from './measurement-paths';

export function accessoryGeometry(root: string, name: string) {
  root = resolve(root);
  const files = new Map<string, LDrawFile>();
  const sources: Record<string, string> = {};
  const load = (name: string): LDrawFile => {
    const key = normalizeName(name);
    if (files.has(key)) return files.get(key)!;
    for (const candidate of measurementPaths(key)) {
      const path = resolve(root, candidate);
      if (!path.startsWith(root + '/') || !statSync(path, { throwIfNoEntry: false })?.isFile()) continue;
      const bytes = readFileSync(path);
      sources[relative(root, path)] = createHash('sha256').update(bytes).digest('hex');
      const file = parseLDraw(bytes.toString('utf8'), key);
      files.set(key, file); return file;
    }
    throw new Error(`Missing accessory geometry: ${key}`);
  };
  const visit = (name: string, stack: string[]) => {
    const file = load(name);
    if (stack.includes(file.name) || stack.length > 32) throw new Error(`Unresolved accessory hierarchy: ${file.name}`);
    for (const cmd of file.cmds) if (cmd.t === 'ref') visit(cmd.file, [...stack, file.name]);
  };
  visit(name, []);
  const flat = flattenPart(name, load(name), load);
  const triangles = [...flat.tris.values(), ...flat.doubleSided.values()].flat();
  if (!triangles.length || !triangles.every(Number.isFinite)) throw new Error(`Empty/invalid accessory geometry: ${name}`);
  return { triangles, bounds: flat.fullBox!, sources };
}

/** Exact triangle/plane intersection segments, in the XZ plane at a given Y.
 * Coplanar faces are excluded; sample inside the blade, not at its end caps.
 * Bounds describe the section envelope, not a circular connector or clearance. */
export function sectionAtY(triangles: readonly number[], y: number) {
  if (triangles.length % 9 || !triangles.every(Number.isFinite) || !Number.isFinite(y)) throw new Error('Invalid section input');
  const segments: number[][][] = [];
  for (let i = 0; i < triangles.length; i += 9) {
    const points: number[][] = [];
    for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) {
      const ay = triangles[i + a + 1], by = triangles[i + b + 1];
      if (ay === by || y < Math.min(ay, by) || y > Math.max(ay, by)) continue;
      const t = (y - ay) / (by - ay);
      const p = [triangles[i + a] + t * (triangles[i + b] - triangles[i + a]),
        triangles[i + a + 2] + t * (triangles[i + b + 2] - triangles[i + a + 2])];
      if (!points.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-8)) points.push(p);
    }
    if (points.length === 2) segments.push(points);
  }
  if (!segments.length) return { y, segments, boundsXZ: null };
  const points = segments.flat();
  return { y, segments, boundsXZ: {
    min: [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1]))],
    max: [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))],
  } };
}
