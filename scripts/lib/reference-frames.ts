import { Matrix4 } from 'three';
import { normalizeName, type LDrawFile, type Mat3, type Vec3 } from '../../src/ldraw/parse';
import type { ShadowLookup } from '../../src/ldraw/shadow';
import { referenceFramePolicy } from './reference-frame-policy';

const matrix = (m: Mat3, p: Vec3) => new Matrix4().set(
  m[0], m[1], m[2], p[0], m[3], m[4], m[5], p[1], m[6], m[7], m[8], p[2], 0, 0, 0, 1);
const frame = (world: Matrix4) => {
  const e = world.elements;
  return { m: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]] as Mat3,
    pos: [e[12], e[13], e[14]] as Vec3 };
};

/** Preserve complete transformed definitions, including keyed roll and source
 * section semantics. No max-radius approximation or connector-family guessing. */
export function referenceFrames(root: LDrawFile, lookup: (name: string) => LDrawFile | null, shadow: ShadowLookup) {
  const definitions: { sourceFile: string; definitionIndex: number; definition: unknown; frame: ReturnType<typeof frame> }[] = [];
  const issues = new Set<string>();
  const excluded: { sourceFile: string; definitionIndex: number; reason: string }[] = [];
  const collect = (name: string, world: Matrix4, dropped: 'all' | string[], chain: string[] = []) => {
    if (dropped === 'all') return;
    const key = normalizeName(name), info = shadow(key);
    if (!info) return;
    if (chain.includes(key) || chain.length > 8) { issues.add(`Unresolved reference include: ${key}`); return; }
    info.snaps.forEach((def, definitionIndex) => {
      if (def.id && dropped.includes(def.id.toLowerCase())) return;
      const { frames, ...definition } = def;
      for (const f of frames) {
        const placed = referenceFramePolicy(world, f, definition as { scale?: string; mirror?: string });
        if (!placed.matrix) { excluded.push({ sourceFile: key, definitionIndex, reason: placed.reason! }); continue; }
        definitions.push({ sourceFile: key, definitionIndex, definition, frame: frame(placed.matrix) });
      }
    });
    for (const inc of info.includes) for (const f of inc.frames) {
      if (!shadow(inc.ref)) issues.add(`Missing reference include: ${inc.ref}`);
      collect(inc.ref, world.clone().multiply(matrix(f.m, f.pos)), dropped, [...chain, key]);
    }
  };
  const walk = (file: LDrawFile, world: Matrix4, dropped: 'all' | string[], stack: string[]) => {
    if (stack.length > 32 || stack.includes(file.name)) { issues.add(`Unresolved geometry hierarchy: ${file.name}`); return; }
    collect(file.name, world, dropped);
    const clear = shadow(file.name)?.clear;
    const below = dropped === 'all' || clear === null ? 'all' : [...dropped, ...[...(clear ?? [])].map(id => id.toLowerCase())];
    for (const cmd of file.cmds) if (cmd.t === 'ref') {
      const child = lookup(cmd.file);
      if (!child) { issues.add(`Missing geometry: ${cmd.file}`); continue; }
      walk(child, world.clone().multiply(matrix(cmd.m, cmd.pos)), below, [...stack, file.name]);
    }
  };
  walk(root, new Matrix4(), [], []);
  return { definitions, issues: [...issues].sort(), excluded };
}
