/**
 * What each part does mechanically, measured from its LDraw geometry
 * (teeth.ts, bores.ts, actuators.ts) and cached per part id.
 *
 * Measuring takes about 20 ms a part, so `npm run data:part-functions` packs
 * the whole LDraw library into public/data/part-functions.json. Once that
 * table is loaded, a library part missing from it is known to have no
 * functions; parts embedded in a model file are measured when they load.
 * Without the table every part is measured when it loads.
 */
import type { FlatPart } from '../../../ldraw/flatten';
import { measureTeeth, type ToothedFeature, type V3 } from './teeth';
import { measureBores, measureRods, measureSeats, roundSurfaces, type Bore, type Rod, type Seat } from './bores';

export type { Bore, Rod, Seat };
/**
 * A screw-driven slide (linear actuator): its piston's direction, lead and
 * stroke in part space, and the part ids of the piston and the input axle.
 */
export type Actuator = { axis: V3; leadLduPerTurn: number; stroke: [number, number]; piston?: string; input?: string };
export type PartFunctions = { teeth: ToothedFeature[]; bores: Bore[]; seats: Seat[]; rods: Rod[]; actuator?: Actuator };
export type PartFunctionTable = {
  format: 'brickmotion-part-functions'; version: 1;
  /** What was scanned (LDraw library version or path) and how many parts. */
  library: string; scanned: number;
  /** Only parts that have functions. */
  parts: Record<string, PartFunctions>;
};

const NONE: PartFunctions = Object.freeze({ teeth: [], bores: [], seats: [], rods: [] }) as PartFunctions;
const cache = new Map<string, PartFunctions>();
let tableLoaded = false;

/** "parts/3743.dat", "3743.DAT", "3743" -> "3743". */
export const partId = (part: string) => part.toLowerCase().replace(/\\/g, '/').replace(/\.dat$/, '').replace(/^.*\//, '');
const hasAny = (f: PartFunctions) => f.teeth.length + f.bores.length + f.seats.length + f.rods.length > 0 || !!f.actuator;

/** `actuator` comes from the part's LDraw shortcut files (actuators.ts), which the flattened part does not carry. */
export function measurePartFunctions(flat: FlatPart | null, actuator?: Actuator | null): PartFunctions {
  if (!flat) return NONE;
  const surfaces = roundSurfaces(flat);
  const f: PartFunctions = { teeth: measureTeeth(flat), bores: measureBores(surfaces), seats: measureSeats(surfaces), rods: measureRods(flat), ...(actuator ? { actuator } : {}) };
  return hasAny(f) ? f : NONE;
}

/** The part's functions if known (from the table or measured), else undefined. */
export const partFunctions = (part: string): PartFunctions | undefined => cache.get(partId(part));

/**
 * The part's functions: cached, or from the table, or measured now from its
 * geometry. With a table loaded, a part it does not list has none, unless
 * `embedded` (defined in the model file itself, so never scanned).
 */
export function ensurePartFunctions(part: string, flat: FlatPart | null, embedded = false, actuator?: Actuator | null): PartFunctions {
  const id = partId(part), known = cache.get(id);
  if (known) return known;
  const f = tableLoaded && !embedded ? NONE : measurePartFunctions(flat, actuator);
  cache.set(id, f);
  return f;
}

/** Forget one part (an embedded part was redefined). */
export const forgetPartFunctions = (part: string) => { cache.delete(partId(part)); };

export function loadPartFunctionTable(table: PartFunctionTable): void {
  if (table.format !== 'brickmotion-part-functions' || table.version !== 1) throw new Error('Not a part-function table');
  // Lists a table from an older scan lacks are empty.
  for (const [id, f] of Object.entries(table.parts)) cache.set(partId(id), { ...f, teeth: f.teeth ?? [], bores: f.bores ?? [], seats: f.seats ?? [], rods: f.rods ?? [] });
  tableLoaded = true;
}

export function packPartFunctions(measured: Record<string, PartFunctions>, about: { library: string; scanned: number }): PartFunctionTable {
  const parts: Record<string, PartFunctions> = {};
  for (const id of Object.keys(measured).sort()) if (hasAny(measured[id])) parts[partId(id)] = measured[id];
  return { format: 'brickmotion-part-functions', version: 1, ...about, parts };
}

/** For tests: forget the table and every measurement. */
export function resetPartFunctions(): void { cache.clear(); tableLoaded = false; }
