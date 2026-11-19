import { createHash } from 'node:crypto';
import type { FlatPart } from '../../src/ldraw/flatten';

/** Strict triangle identity in the same part frame. Colour, record order and
 * cyclic vertex order do not affect physical geometry. Winding, sidedness,
 * every coordinate and duplicate surfaces remain significant. No rounding,
 * bounds-only matching, name inference or alignment is performed. */
export function geometrySignature(part: Pick<FlatPart, 'tris' | 'doubleSided'>): string | null {
  const triangles: string[] = [];
  for (const [kind, batches] of [['one', part.tris], ['two', part.doubleSided]] as const) {
    for (const points of batches.values()) {
      if (points.length % 9) throw new Error('Incomplete triangle in geometry signature');
      for (let i = 0; i < points.length; i += 9) {
        const values = points.slice(i, i + 9);
        if (!values.every(Number.isFinite)) throw new Error('Non-finite geometry signature input');
        const vertices = [0, 3, 6].map(offset => values.slice(offset, offset + 3).map(v => String(v || 0)).join(','));
        const cyclic = [0, 1, 2].map(offset => [vertices[offset], vertices[(offset + 1) % 3], vertices[(offset + 2) % 3]].join('|'));
        triangles.push(`${kind}:${cyclic.sort()[0]}`);
      }
    }
  }
  if (!triangles.length) return null;
  const hash = createHash('sha256').update('brickmotion-oriented-triangles-v1\n');
  for (const triangle of triangles.sort()) hash.update(triangle).update('\n');
  return hash.digest('hex');
}
