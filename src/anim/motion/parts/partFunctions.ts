/**
 * What each part does mechanically, measured from its LDraw geometry
 * (teeth.ts, bores.ts) and cached per part id.
 *
 * Measuring takes about 20 ms a part, so `npm run data:part-functions` packs
 * the whole LDraw library into public/data/part-functions.json. Once that
 * table is loaded, a library part missing from it is known to have no
 * functions; parts embedded in a model file are measured when they load.
 * Without the table every part is measured when it loads.
 */
import type { FlatPart } from '../../../ldraw/flatten';
import { measureTeeth, type ToothedFeature, type V3 } from './teeth';

/** A bore something may slide along (shock absorber cylinder, piston bore); filled by bores.ts. */
export type Bore = { axis: V3; centre: V3; radius: number; shape: string; travel: [number, number] };
/** A round seat that holds another part by its rim (a tyre on a wheel rim); filled by bores.ts. */
export type Seat = { axis: V3; centre: V3; radius: number; width: number; gender: 'M' | 'F' };
export type PartFunctions = { teeth: ToothedFeature[]; bores: Bore[]; seats: Seat[] };
export type PartFunctionTable = {
  format: 'brickmotion-part-functions'; version: 1;
  /** What was scanned (LDraw library version or path) and how many parts. */
  library: string; scanned: number;
  /** Only parts that have functions. */
  parts: Record<string, PartFunctions>;
};

const NONE: PartFunctions = Object.freeze({ teeth: [], bores: [], seats: [] }) as PartFunctions;
const cache = new Map<string, PartFunctions>();
let tableLoaded = false;

/** "parts/3743.dat", "3743.DAT", "3743" -> "3743". */
export const partId = (part: string) => part.toLowerCase().replace(/\\/g, '/').replace(/\.dat$/, '').replace(/^.*\//, '');
const hasAny = (f: PartFunctions) => f.teeth.length + f.bores.length + f.seats.length > 0;

export function measurePartFunctions(flat: FlatPart | null): PartFunctions {
  if (!flat) return NONE;
  const f: PartFunctions = { teeth: measureTeeth(flat), bores: [], seats: [] };
  return hasAny(f) ? f : NONE;
}

/** The part's functions if known (from the table or measured), else undefined. */
export const partFunctions = (part: string): PartFunctions | undefined => cache.get(partId(part));

/**
 * The part's functions: cached, or from the table, or measured now from its
 * geometry. With a table loaded, a part it does not list has none, unless
 * `embedded` (defined in the model file itself, so never scanned).
 */
export function ensurePartFunctions(part: string, flat: FlatPart | null, embedded = false): PartFunctions {
  const id = partId(part), known = cache.get(id);
  if (known) return known;
  const f = tableLoaded && !embedded ? NONE : measurePartFunctions(flat);
  cache.set(id, f);
  return f;
}

/** Forget one part (an embedded part was redefined). */
export const forgetPartFunctions = (part: string) => { cache.delete(partId(part)); };

export function loadPartFunctionTable(table: PartFunctionTable): void {
  if (table.format !== 'brickmotion-part-functions' || table.version !== 1) throw new Error('Not a part-function table');
  for (const [id, f] of Object.entries(table.parts)) cache.set(partId(id), f);
  tableLoaded = true;
}

export function packPartFunctions(measured: Record<string, PartFunctions>, about: { library: string; scanned: number }): PartFunctionTable {
  const parts: Record<string, PartFunctions> = {};
  for (const id of Object.keys(measured).sort()) if (hasAny(measured[id])) parts[partId(id)] = measured[id];
  return { format: 'brickmotion-part-functions', version: 1, ...about, parts };
}

/** For tests: forget the table and every measurement. */
export function resetPartFunctions(): void { cache.clear(); tableLoaded = false; }
