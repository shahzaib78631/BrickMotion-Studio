import type { Snap } from '../../src/ldraw/shadow';
import type { Vec3 } from '../../src/ldraw/parse';

/** Separate entrances of an explicitly open female cylinder. Each entrance
 * retains its own ordered section profile; maximum radius is never substituted
 * for the mouth radius. Axis points inward from that entrance. */
export function referencePorts(snaps: readonly Snap[]) {
  return snaps.flatMap((snap, connectorIndex) => {
    const caps = snap.caps?.toLowerCase();
    if (snap.kind !== 'cyl' || snap.gender !== 'F' || !snap.sections?.length ||
      !['one', 'none', 'a', 'b'].includes(caps ?? '')) return [];
    const near = { connectorIndex, end: 'start' as 'start' | 'end', position: [...snap.start] as Vec3,
      inward: [...snap.axis] as Vec3, sections: snap.sections.map(s => ({ ...s })) };
    const far = { connectorIndex, end: 'end' as const,
      position: snap.start.map((v, k) => v + snap.axis[k] * snap.length) as Vec3,
      inward: snap.axis.map(v => -v || 0) as Vec3,
      sections: [...snap.sections].reverse().map(s => ({ ...s, start: snap.length - s.start - s.length })) };
    return caps === 'none' ? [near, far] : caps === 'a' ? [far] : [near];
  });
}
