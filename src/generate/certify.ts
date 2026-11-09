import { assemble, type Assembly, type Instance } from '../model/assemble';
import { discoverPlacedAttachments } from '../model/attachmentPlacements';
import { modelConnections } from '../plan/connectionGraph';
import type { Warning } from '../model/validate';
import type { Plan } from '../plan/types';
import { ensureParts, getColors, metricsOf, registerInlineParts } from '../state/partService';
import { allChecks, allPartIds } from '../state/useModel';

/**
 * A generated model's certificate: what the editor's own checks say about it. It is
 * buildable when it is one piece (counted on the assembled model's real connections) and
 * nothing floats, overlaps or is an unknown part, and it does not tip over. Weak joints (a big part held by one stud) are counted, not failed.
 */
export type Certificate = {
  buildable: boolean;
  pieces: number;
  /** separate parts it falls into, by real connections (1 = holds together) */
  parts: number;
  /** of those, parts that do not stand on the ground (held up by nothing that holds them) */
  unsupported: number;
  /** a real set's own build: the part count is reported, not held against it */
  realModel: boolean;
  floating: number;
  overlapping: number;
  unknown: number;
  weak: number;
  /** standing parts whose centre of gravity is outside what they stand on: they tip over */
  tipping: number;
  /** the editor's warnings behind the counts, with the items they name */
  warnings: Warning[];
  /** the standing parts that tip over, as their item ids */
  tippingItems: string[][];
};

/** LDU of slack when deciding that a piece lies inside another's box */
const INSIDE = 2;
/** LDU between a part's lowest point and the ground that still counts as standing on it */
const GROUND = 2;

type Metrics = Parameters<typeof modelConnections>[1];

/**
 * The separate parts the assembled model falls into, as groups of its pieces, counting only
 * real connections: a stud in a tube, a pin in a hole, a clip on a bar, and the reviewed slot
 * fits. Pieces that only touch side by side are not joined: that is how a real model comes
 * apart. Independent of whatever made the plan.
 */
export function connectedGroups(asm: Assembly, metrics: Metrics): Instance[][] {
  const live = asm.instances.filter((i) => !i.placeholder);
  const index = new Map(live.map((i, n) => [i.key, n] as const));
  const parent = live.map((_, n) => n);
  const find = (n: number): number => { while (parent[n] !== n) n = parent[n] = parent[parent[n]]; return n; };
  const join = (a?: number, b?: number) => { if (a !== undefined && b !== undefined) parent[find(a)] = find(b); };
  const joined = new Set<string>();
  for (const c of modelConnections(asm, metrics)) {
    join(index.get(c.a.key), index.get(c.b.key));
    joined.add(c.a.key);
    joined.add(c.b.key);
  }
  for (const hit of discoverPlacedAttachments(live.map((i) => ({ id: i.key, part: i.part, world: i.world.elements })))) {
    if (hit.slot.mirrored) continue;
    join(index.get(hit.host), index.get(hit.insert));
    joined.add(hit.host);
    joined.add(hit.insert);
  }
  // Inserts the connector data cannot express: a pane slides into its frame's groove (no
  // connectors at all), a door's hinge sits on the frame's (both recorded as male). A piece
  // with no connection of its own that lies wholly inside another piece's box is held by it.
  const inside = (a: Instance, b: Instance) =>
    [0, 1, 2].every((k) => a.worldBox.min[k] >= b.worldBox.min[k] - INSIDE && a.worldBox.max[k] <= b.worldBox.max[k] + INSIDE);
  for (const a of live) {
    if (joined.has(a.key)) continue;
    const host = live.find((b) => b !== a && inside(a, b));
    if (host) join(index.get(a.key), index.get(host.key));
  }
  const groups = new Map<number, Instance[]>();
  live.forEach((i, n) => {
    const r = find(n);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  });
  return [...groups.values()];
}

export function connectedParts(asm: Assembly, metrics: Metrics): number {
  return connectedGroups(asm, metrics).length;
}

type Point = [number, number];

/** Convex hull (x, z), counter-clockwise, by the monotone chain. */
function hull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (pts: Point[]) => {
    const h: Point[] = [];
    for (const q of pts) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  return [...half(p), ...half(p.reverse())];
}

/** How far a point is inside a convex polygon (negative: outside), in LDU. */
function depthInside(poly: Point[], q: Point): number {
  if (poly.length === 1) return -Math.hypot(q[0] - poly[0][0], q[1] - poly[0][1]);
  let d = Infinity;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // left of each counter-clockwise edge is inside
    d = Math.min(d, ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) / len);
  }
  return poly.length === 2 ? Math.min(d, -Math.abs(d)) : d;
}

/** LDU a centre of gravity may sit past the edge of the footprint (the boxes are rough) */
const BALANCE = 2;

/**
 * Whether pieces standing on the ground stay up as one rigid body under their own weight:
 * the centre of gravity (each piece weighs its box's volume, as bricky's unbalanced-group
 * rule does with a uniform density) must lie over the footprint, the convex hull of the
 * pieces touching the ground. Joints are taken as rigid: whether a stud grips hard enough
 * is a separate question this does not answer.
 */
export function balances(pieces: Instance[], ground: number): boolean {
  let w = 0, x = 0, z = 0;
  const feet: Point[] = [];
  for (const i of pieces) {
    const { min, max } = i.worldBox;
    const v = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
    w += v;
    x += v * (min[0] + max[0]) / 2;
    z += v * (min[2] + max[2]) / 2;
    if (ground - max[1] <= GROUND) feet.push([min[0], min[2]], [max[0], min[2]], [max[0], max[2]], [min[0], max[2]]);
  }
  if (!feet.length || w <= 0) return true; // nothing on the ground: the floating checks say so
  return depthInside(hull(feet), [x / w, z / w]) >= -BALANCE;
}

export type CertifyOptions = {
  /** the generator's own part count: only cross-checked, the assembled model decides */
  generatorParts?: number;
  /**
   * A real set, as its designer built it (a remix only changes colours): it may be several
   * builds side by side (a car and its driver), and the connector data does not know every
   * real joint (a minifig's arms, a tyre on its rim), so the part count is not held against
   * it. The editor's checks decide: nothing floating, nothing overlapping, every part known.
   */
  realModel?: boolean;
};

export async function certify(plan: Plan, opts: CertifyOptions | number = {}): Promise<Certificate> {
  const { generatorParts, realModel = false } = typeof opts === 'number' ? { generatorParts: opts } : opts;
  registerInlineParts(plan.parts); // parts an imported model carries inside its file
  await ensureParts(allPartIds(plan));
  const asm = assemble(plan, metricsOf, getColors());
  const warnings = allChecks(asm);
  const groups = connectedGroups(asm, metricsOf);
  const parts = groups.length;
  if (generatorParts !== undefined && generatorParts !== parts) {
    console.warn(`certify: the generator counted ${generatorParts} parts, the assembled model has ${parts}`);
  }
  // LDraw's y points down: a part's lowest point is its largest y
  const lowest = (is: Instance[]) => is.reduce((m, i) => Math.max(m, i.worldBox.max[1]), -Infinity);
  const ground = lowest(groups.flat());
  const onGround = groups.filter((g) => ground - lowest(g) <= GROUND);
  const standing = onGround.length;
  // the whole model when it is one part, else each part that stands on the ground
  const tips = (parts === 1 ? groups : onGround).filter((g) => !balances(g, ground));
  const tipping = tips.length;
  const count = (k: string) => warnings.filter((w) => w.kind === k).length;
  const c = {
    pieces: asm.instances.filter((i) => !i.placeholder).length,
    parts,
    unsupported: parts - standing,
    floating: count('floating'),
    overlapping: count('overlap'),
    unknown: count('unknown-part'),
    weak: count('weak'),
    tipping,
  };
  const held = realModel || parts === 1;
  // a real set's balance is reported, not failed: its weights are only box estimates
  const stands = realModel || tipping === 0;
  return { ...c, realModel, warnings, tippingItems: tips.map((g) => [...new Set(g.map((i) => i.itemId))]), buildable: held && stands && c.floating === 0 && c.overlapping === 0 && c.unknown === 0 };
}
