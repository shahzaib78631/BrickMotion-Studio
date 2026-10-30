/** Measures part functions (gears, racks) from the real LDraw library for tests that place gears. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PartLibrary } from '../../src/ldraw/library';
import { ensurePartFunctions } from '../../src/anim/motion/parts/partFunctions';

const LDRAW = join(__dirname, '..', '..', 'public', 'ldraw');
export const ldrawInstalled = existsSync(join(LDRAW, 'parts', '3647.dat'));
const lib = new PartLibrary(async p => { const f = join(LDRAW, p); return existsSync(f) ? readFileSync(f, 'utf8') : null; });

/** Measures each part once (cached); does nothing without the LDraw library. */
export async function measureParts(ids: string[]): Promise<void> {
  if (!ldrawInstalled) return;
  for (const id of ids) ensurePartFunctions(id, await lib.loadPart(`${id.replace(/\.dat$/i, '')}.dat`));
}
