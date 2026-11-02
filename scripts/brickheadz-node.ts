/**
 * Node-side LDraw loading for offline BrickHeadz validation: reads a filesystem
 * library plus the vendored LDCad shadow metadata and measures every part a plan
 * references. No browser, rendering, or global LDraw install needed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseLDConfig, type ColorDef } from '../src/ldraw/colors';
import { flattenPart } from '../src/ldraw/flatten';
import { measurePart, type PartMetrics } from '../src/ldraw/metrics';
import { parseLDraw, type LDrawFile } from '../src/ldraw/parse';
import { shadowLookupFrom, type ShadowLookup } from '../src/ldraw/shadow';
import type { Plan, Step } from '../src/plan/types';

export type NodeLibrary = {
  colors: Map<number, ColorDef>;
  measurePlan(plan: Plan): Map<string, PartMetrics>;
};

export function loadNodeLibrary(library: string): NodeLibrary {
  if (!existsSync(join(library, 'parts')) || !existsSync(join(library, 'p'))) {
    throw new Error(`Missing LDraw library under ${library}. Expected parts/ and p/.`);
  }
  const files = new Map<string, LDrawFile>();
  const load = (folder: string) => {
    for (const entry of readdirSync(folder)) {
      const file = join(folder, entry);
      if (statSync(file).isDirectory()) load(file);
      else if (entry.toLowerCase().endsWith('.dat')) files.set(relative(library, file).replace(/\\/g, '/').toLowerCase(), parseLDraw(readFileSync(file, 'utf8'), entry));
    }
  };
  load(library);
  const lookup = (ref: string) => {
    const id = ref.replace(/\\/g, '/').toLowerCase();
    return files.get(`parts/${id}`) ?? files.get(`p/${id}`) ?? files.get(id) ?? null;
  };
  const colors = parseLDConfig(existsSync(join(library, 'LDConfig.ldr')) ? readFileSync(join(library, 'LDConfig.ldr'), 'utf8') : '');

  const shadowFiles: Record<string, string> = {};
  for (const root of ['p', 'parts']) {
    const base = join('vendor/LDCadShadowLibrary', root);
    if (!existsSync(base)) continue;
    const scan = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const file = join(dir, entry);
        if (statSync(file).isDirectory()) scan(file);
        else if (entry.toLowerCase().endsWith('.dat')) {
          const meta = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => /^\s*0\s+!LDCAD\s+SNAP_/i.test(line));
          if (meta.length) shadowFiles[relative(base, file).replace(/\\/g, '/').toLowerCase()] = meta.join('\n');
        }
      }
    };
    scan(base);
  }
  const shadow: ShadowLookup | undefined = Object.keys(shadowFiles).length ? shadowLookupFrom(shadowFiles) : undefined;

  const measurePlan = (plan: Plan): Map<string, PartMetrics> => {
    const refs = new Set<string>();
    const walk = (steps: Step[]) => {
      for (const step of steps) for (const item of step.pieces) if ('part' in item) refs.add(item.part);
    };
    walk(plan.steps);
    for (const sub of Object.values(plan.submodels ?? {})) walk(sub.steps);
    const out = new Map<string, PartMetrics>();
    for (const id of refs) {
      const root = lookup(`${id}.dat`);
      out.set(id, measurePart(root ? flattenPart(id, root, lookup, () => {}, shadow) : null, id));
    }
    return out;
  };

  return { colors, measurePlan };
}
