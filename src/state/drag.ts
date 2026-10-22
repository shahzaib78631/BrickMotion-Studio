/** Turns a drag on the floor (world points, studs, +Y up) into a whole-stud plan move; plan z is world −z. */
export function dragDelta(from: { x: number; z: number }, to: { x: number; z: number }): { x: number; y: number; z: number } {
  const r = (v: number) => Math.round(v) || 0;
  return { x: r(to.x - from.x), y: 0, z: r(-(to.z - from.z)) };
}
