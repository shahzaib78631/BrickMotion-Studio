import { normalizeName } from '../../src/ldraw/parse';
import { parseShadow, snapParams, type ShadowInfo, type ShadowLookup } from '../../src/ldraw/shadow';

/** Measurement-only interpretation of the independent library. Never applies
 * app patches. Resolve include clears and type-specific defaults before using
 * the shared geometry walker; retain modifiers needed by full-frame consumers.
 * Reference: https://www.melkert.net/LDCad/tech/meta */
export function independentShadowLookup(files: Record<string, string>): ShadowLookup {
  const parsed = new Map<string, ShadowInfo>();
  for (const [file, text] of Object.entries(files)) {
    const normalized = text.split(/\r?\n/).map(line => {
      const command = /^\s*0\s+!LDCAD\s+(SNAP_\w+)\b/i.exec(line)?.[1].toUpperCase();
      if (!command) return line;
      if (!['SNAP_CYL', 'SNAP_CLP', 'SNAP_FGR', 'SNAP_GEN', 'SNAP_INCL', 'SNAP_CLEAR'].includes(command)) throw new Error(`Unsupported reference command ${command}: ${file}`);
      const params = snapParams(line);
      if (command === 'SNAP_FGR' && !params.has('center')) line += ' [center=true]';
      if (command === 'SNAP_CLP') {
        if (!params.has('radius')) line += ' [radius=4]';
        if (!params.has('length')) line += ' [length=8]';
      }
      return line;
    }).join('\n');
    const info = parseShadow(normalized);
    // The app parser does not retain mirror on all definitions, or scale on
    // non-cylinder definitions. Full-frame export must not discard them.
    info.snaps = normalized.split('\n').flatMap(line => {
      const params = snapParams(line);
      return parseShadow(line).snaps.map(def => Object.assign(def,
        params.has('mirror') ? { mirror: params.get('mirror') } : {},
        params.has('scale') ? { scale: params.get('scale') } : {}));
    });
    const key = normalizeName(file);
    if (parsed.has(key)) throw new Error(`Duplicate normalized reference file: ${key}`);
    parsed.set(key, info);
  }
  const resolved = new Map<string, ShadowInfo>();
  const heights = new Map<string, number>();
  const resolve = (key: string, stack: string[]): ShadowInfo => {
    if (stack.includes(key)) throw new Error(`Reference include cycle: ${[...stack, key].join(' -> ')}`);
    if (resolved.has(key)) return resolved.get(key)!;
    const info = parsed.get(key);
    if (!info) throw new Error(`Missing reference include: ${key}`);
    let clear = info.clear === null ? null : info.clear === undefined ? undefined : new Set([...info.clear].map(id => id.toLowerCase()));
    let height = 0;
    for (const include of info.includes) {
      const name = normalizeName(include.ref), child = resolve(name, [...stack, key]);
      height = Math.max(height, 1 + heights.get(name)!);
      if (child.clear === null) clear = null;
      else if (clear !== null && child.clear) {
        clear ??= new Set();
        for (const id of child.clear) clear.add(id.toLowerCase());
      }
    }
    if (height > 8) throw new Error(`Reference include depth limit: ${key}`);
    const result = { ...info, clear };
    resolved.set(key, result); heights.set(key, height);
    return result;
  };
  for (const key of parsed.keys()) resolve(key, []);
  return name => resolved.get(normalizeName(name)) ?? null;
}
