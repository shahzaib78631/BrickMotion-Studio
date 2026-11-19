import { placeSnap, type SnapDef } from '../../src/ldraw/shadow';
import type { Mat3, Vec3 } from '../../src/ldraw/parse';

/** Project policy-checked full frames into the app's inspection shape. Raw
 * definitions remain authoritative for keyed roll and generic matching. */
export function referenceConnectors(definitions: readonly { definition: unknown; frame: { m: Mat3; pos: Vec3 } }[]) {
  return definitions.flatMap(row => placeSnap({ ...(row.definition as SnapDef), frames: [row.frame] },
    [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]));
}
