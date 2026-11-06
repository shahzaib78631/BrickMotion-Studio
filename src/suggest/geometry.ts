/**
 * The maths behind the building techniques (Brick Builder's Handbook, see techniques.ts), as
 * calculators the editor can answer questions with: which triangle gives this wall angle,
 * how many hinge plates close this circle, which wedge plate makes this angle.
 *
 * Units: studs (1 stud = 20 LDU = 2.5 plates), plates (8 LDU), bricks (3 plates).
 */

export const PLATES_PER_STUD = 2.5;
export const PLATES_PER_BRICK = 3;

const deg = (r: number) => (r * 180) / Math.PI;

/** Exact integer right triangles with every side ≤ max (legs a < b, span c). */
export function pythagoreanTriples(max = 25): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let a = 1; a <= max; a++)
    for (let b = a + 1; b <= max; b++) {
      const c = Math.hypot(a, b);
      if (c <= max && Math.abs(c - Math.round(c)) < 1e-9) out.push([a, b, Math.round(c)]);
    }
  return out;
}

/**
 * "Near triples": close enough when hinges give a little play. The handbook lists these
 * (the first four are 45°); the half-stud ones need jumper plates. (3.5, 3.5, 5) is the
 * handbook's untested suggestion.
 */
export const NEAR_TRIPLES: { legs: [number, number]; span: number; note: string }[] = [
  { legs: [5, 5], span: 7, note: '45°, used for chamfered tower corners' },
  { legs: [7, 7], span: 10, note: '45°, octagon corners' },
  { legs: [12, 12], span: 17, note: '45°, LEGO 10264 Corner Garage facade' },
  { legs: [17, 17], span: 24, note: '45°' },
  { legs: [4, 7], span: 8, note: 'about 60°' },
  { legs: [4, 8], span: 9, note: 'about 63°' },
  { legs: [8.5, 8.5], span: 12, note: '45°, needs jumper plates (half of 17-17-24)' },
  { legs: [3.5, 3.5], span: 5, note: '45°, needs jumper plates; suggested, not tested in the handbook' },
];

export type WallPlan = {
  /** how far along and across the grid the wall runs, in studs */
  legs: [number, number];
  /** distance between the two connection points, in studs */
  span: number;
  /** the wall's angle to the grid */
  angle: number;
  /** how far from the angle asked for */
  error: number;
  exact: boolean;
  /** what joins the two ends */
  how: string;
};

/**
 * A wall at `angle`° to the grid: the triangle (exact or near) closest to that angle with a
 * span ≤ maxSpan. Exact triangles can use 1×1 plate spacers under a brick; near ones need
 * hinge plates (two 1×4 hinge plates bridged by a plate as long as the span).
 */
export function angledWall(angle: number, maxSpan = 25): WallPlan[] {
  const rows: WallPlan[] = [];
  const add = (a: number, b: number, c: number, exact: boolean) => {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const ang = deg(Math.atan2(y, x));
      rows.push({
        legs: [x, y], span: c, angle: ang, error: Math.abs(ang - angle), exact,
        how: exact
          ? `1×1 plates ${x} and ${y} studs from the corner, bridged by a 1×${c + 1} brick (its end studs ${c} apart); or two 1×4 hinge plates bridged by a 1×${c} plate`
          : `two 1×4 hinge plates bridged by a 1×${Math.ceil(c)} plate (hinges take up the ${Math.abs(Math.hypot(x, y) - c).toFixed(2)} stud mismatch)`,
      });
    }
  };
  for (const [a, b, c] of pythagoreanTriples(maxSpan)) add(a, b, c, true);
  for (const n of NEAR_TRIPLES) if (n.span <= maxSpan) add(n.legs[0], n.legs[1], n.span, false);
  // scaled triples are the same angle, longer: keep the shortest per angle
  const seen = new Set<string>();
  return rows.sort((p, q) => p.error - q.error || p.span - q.span)
    .filter((r) => { const k = `${r.angle.toFixed(2)}:${r.exact}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 5);
}

export type RoundWall = { hinges: number; sides: number; turn: number; inner: number; outer: number; fit: number; note: string };

/**
 * A round wall of 1×4 hinge plates: each plate is two 2-stud sides of the polygon, so the
 * inner circumference π·d needs about π·d / 4 plates, each pair turned 360 / (2n) degrees.
 * Handbook example: d = 18 → 14 plates, 28 sides, 12.86°.
 */
export function roundWall(innerDiameter: number): RoundWall {
  const exact = (Math.PI * innerDiameter) / 4;
  const n = Math.max(3, Math.round(exact));
  const odd = innerDiameter % 2 === 1;
  return {
    hinges: n, sides: 2 * n, turn: 360 / (2 * n), inner: innerDiameter, outer: innerDiameter + 2, fit: exact - n,
    note: odd ? 'odd diameter: one axis sits half a stud off the grid; attach with jumper plates'
      : Math.abs(exact - n) > 0.25 ? 'the circle does not close cleanly at this diameter; try one stud more or less' : 'closes cleanly',
  };
}

/** Wedge plates (left, right), their legs in studs, and the angle of the sloped edge. */
export const WEDGES: { size: string; left: string; right: string; rise: number; run: number }[] = [
  { size: '2×2', left: '24299', right: '24307', rise: 1, run: 2 },
  { size: '3×2', left: '43723a', right: '43722a', rise: 1, run: 3 },
  { size: '4×2', left: '41770a', right: '41769a', rise: 1, run: 4 },
  { size: '6×2', left: '78443', right: '78444', rise: 1, run: 6 },
  { size: '6×3', left: '54384', right: '54383', rise: 2, run: 6 },
  { size: '6×4', left: '48208', right: '48205', rise: 3, run: 6 },
  { size: '8×3', left: '3544', right: '3545', rise: 2, run: 8 },
  { size: '12×3', left: '47397', right: '47398', rise: 2, run: 12 },
];
export const wedgeAngle = (w: { rise: number; run: number }) => deg(Math.atan2(w.rise, w.run));

/**
 * The wedge plate (or a mirrored pair, which doubles the angle — the "mirrored hypotenuse"
 * technique, e.g. two 6×3 wedges give the 3-4-5 wall's 36.87°) closest to `angle`.
 */
export function wedgeFor(angle: number): { wedge: (typeof WEDGES)[number]; pair: boolean; angle: number; error: number }[] {
  const out = WEDGES.flatMap((w) => [false, true].map((pair) => {
    const a = wedgeAngle(w) * (pair ? 2 : 1);
    return { wedge: w, pair, angle: a, error: Math.abs(a - angle) };
  }));
  return out.sort((a, b) => a.error - b.error || a.wedge.run - b.wedge.run).slice(0, 4);
}

/** Technic angle connectors: their angle between the two axle holes. */
export const TECHNIC_ANGLES: { n: number; part: string; angle: number }[] = [
  { n: 2, part: '32034', angle: 180 },
  { n: 3, part: '32016', angle: 157.5 },
  { n: 4, part: '32192', angle: 135 },
  { n: 5, part: '32015', angle: 112.5 },
  { n: 6, part: '32014', angle: 90 },
];

/**
 * A regular polygon from Technic angle connectors: its interior angle must be one of the
 * connectors' (octagon 135° → #4, hexadecagon 157.5° → #3, square 90° → #6). Apothem from
 * a = s / (2 tan(180/n)).
 */
export function technicPolygon(sides: number, sideStuds: number): { connector: (typeof TECHNIC_ANGLES)[number] | null; interior: number; apothem: number; axle: number } {
  const interior = 180 - 360 / sides;
  const connector = TECHNIC_ANGLES.find((c) => Math.abs(c.angle - interior) < 0.01) ?? null;
  // a #2-sized connector is 3 studs end to end, axles go 1 stud in: the axle between two is side − 1
  return { connector, interior, apothem: sideStuds / (2 * Math.tan(Math.PI / sides)), axle: sideStuds - 1 };
}

/**
 * Lowell sphere: a SNOT cube core with six identical curved panels of plates. Diameter =
 * core + 2 × panel thickness, with the thickness in plates (2.5 per stud). Handbook: core
 * 16, panels 14 plates → 16 + 28 / 2.5 = 27.2 studs.
 */
export function lowellSphere(diameter: number): { core: number; panelPlates: number; actual: number } {
  // the panels curve right only when the core is about 4/6.8 of the diameter (Lowell's
  // original 4 in 6.8; the handbook's 16 in 27.2): take the even core nearest that
  const core = Math.max(2, 2 * Math.round((diameter * (4 / 6.8)) / 2));
  const plates = Math.max(1, Math.round(((diameter - core) * PLATES_PER_STUD) / 2));
  return { core, panelPlates: plates, actual: Math.round((core + (2 * plates) / PLATES_PER_STUD) * 100) / 100 };
}

/**
 * SNOT spacing: side studs line up with the grid every 2 studs = 5 plates (a brick + 2
 * plates). How many plates to put between side-stud layers for `studs` of spacing, and the
 * half-plate offset needed when `studs` is odd.
 */
export function snotSpacing(studs: number): { plates: number; fill: string; halfPlate: boolean } {
  const plates = studs * PLATES_PER_STUD;
  const whole = Math.floor(plates);
  const bricks = Math.floor(whole / PLATES_PER_BRICK);
  const rest = whole - bricks * PLATES_PER_BRICK;
  return {
    plates,
    fill: `${bricks ? `${bricks} brick${bricks > 1 ? 's' : ''}` : ''}${bricks && rest ? ' + ' : ''}${rest ? `${rest} plate${rest > 1 ? 's' : ''}` : ''}`,
    halfPlate: plates !== whole,
  };
}

/**
 * Tapering a tower: plain bricks and plates step in 1 stud per side about every 4 floors;
 * 2×2 jumper plates step half a stud per side every 2 floors (handbook, Transamerica).
 */
export function taper(from: number, to: number, floors: number): { step: number; every: number; jumpers: boolean } {
  const studs = Math.abs(from - to);
  const plain = studs / 2;
  const every = plain > 0 ? floors / plain : Infinity;
  if (every >= 4) return { step: 2, every: Math.floor(every), jumpers: false };
  return { step: 1, every: Math.max(1, Math.floor(floors / studs)), jumpers: true };
}
