import * as THREE from 'three';
import type { PartMetrics } from '../ldraw/metrics';
import { partConnectors, worldConnectors, type Connector } from '../plan/connectors';
import { seat, type Quarter, type Target } from '../plan/placementEngine';
import { fit, mates, posOf, samePose, sceneAround, type Placed, type Scene, type Suggestion } from './engine';

/**
 * "What fits here?": the parts that physically fit one free connection of a piece, ranked by
 * how often builders join them there. The habits are mined from the 67k BrickNet models
 * (python/bricknet/habits.py → public/data/suggest/habits.json): for each part, where other
 * parts sit on it and in how many models. Every answer is checked with the editor's own
 * connectors and collision test: it mates the spot and sits inside nothing.
 *
 * Also finds the open spots of a build: free Technic holes, pins, clips, bars, hinges and
 * balls (free studs are everywhere, so they are not flagged).
 */

/** [other part (index into parts), rotation (index into rots), tx, ty, tz, models, same colour %, joint kind] */
export type Habit = [number, number, number, number, number, number, number, string];
export type Habits = {
  models: number;
  source: string;
  parts: string[];
  /** row-major 3×3 */
  rots: number[][];
  habits: Record<string, Habit[]>;
  /** per BrickNet joint kind: [part index, models] */
  partners: Record<string, [number, number][]>;
};

let loading: Promise<Habits | null> | null = null;
/** The habit table, fetched once (null when it is not there). */
export function loadHabits(url = '/data/suggest/habits.json'): Promise<Habits | null> {
  loading ??= fetch(url).then((r) => (r.ok ? (r.json() as Promise<Habits>) : null)).catch(() => null);
  return loading;
}

/** A free connection of a piece. */
export type Spot = { key: string; conn: Target; label: string };

export type FitsInput = {
  pieces: readonly Placed[];
  /** the piece asked about */
  key: string;
  /** the pointed spot (model LDU); the free connection nearest it is used. Omitted: `spot`. */
  point?: readonly number[];
  spot?: Target;
  metrics: (part: string) => PartMetrics | null;
  habits: Habits | null;
  name?: (part: string) => string;
  limit?: number;
  budgetMs?: number;
};
export type FitsOutput = { spot: Spot | null; fits: Suggestion[]; wanted: string[] };

const YAWS: Quarter[] = [0, 90, 180, 270];
const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** What a connection is called, from the side that is free. */
export function spotLabel(c: Pick<Connector, 'type' | 'gender' | 'axis'>): string {
  switch (c.type) {
    case 'stud': return c.gender === 'M' ? 'free stud' : 'open underside';
    case 'pin': return c.gender === 'F' ? 'Technic hole' : 'Technic pin';
    case 'bar': return c.gender === 'F' ? 'clip' : 'bar';
    case 'hinge': case 'knuckle': return 'hinge';
    case 'ball': return c.gender === 'M' ? 'ball' : 'ball socket';
  }
}

/** BrickNet's joint kinds for one of our connection types. */
const KINDS: Record<Connector['type'], string[]> = {
  stud: ['stud'], pin: ['axle', 'fixed'], bar: ['hole', 'fixed'], hinge: ['hinge'], knuckle: ['hinge'], ball: ['ball'],
};

/** Common parts for a free connection, when the data has too few: what the spot takes. */
const STAPLES: Record<string, string[]> = {
  'stud:M': ['3024', '3023', '3710', '3020', '3022', '3070b', '3069b', '3005', '3004', '3001', '6141'],
  'stud:F': ['3024', '3023', '3710', '3022', '3020', '3005', '3004', '3001', '3062b', '6141'],
  'pin:F': ['2780', '3673', '6558', '4274', '43093', '32054', '18654', '3749'],
  'pin:M': ['3700', '18654', '43857', '32523', '32316', '32524', '3701', '32064', '6536'],
  'bar:F': ['87994', '30374', '99207', '4697b', '3957a'],
  'bar:M': ['4085c', '63868', '60478', '15712', '11476', '4735'],
};

const part = (h: Habits, i: number) => h.parts[i];
/** The habits for a part: its own, or those of the same mould without the variant letter. */
function habitsOf(h: Habits | null, id: string): Habit[] {
  if (!h) return [];
  return h.habits[id] ?? h.habits[id.replace(/[a-z]$/, '')] ?? h.habits[`${id}b`] ?? h.habits[`${id}a`] ?? [];
}

function relOf(h: Habits, x: Habit): THREE.Matrix4 {
  const r = h.rots[x[1]];
  return new THREE.Matrix4().set(r[0], r[1], r[2], x[2], r[3], r[4], r[5], x[3], r[6], r[7], r[8], x[4], 0, 0, 0, 1);
}

/** Free connections of `key`, nearest the point first. */
export function freeSpots(sc: Scene, key: string, point?: readonly number[]): Target[] {
  const own = sc.targets.filter((t) => t.owner === key);
  return point ? own.sort((a, b) => dist3(a.pos, point) - dist3(b.pos, point)) : own;
}

/** Parts that fit the spot, best first. */
export function fitsAt(input: FitsInput): FitsOutput {
  const { pieces, metrics, habits } = input;
  const name = input.name ?? ((p: string) => p);
  const limit = input.limit ?? 8;
  const t0 = performance.now(), budget = input.budgetMs ?? 250;
  const wanted = new Set<string>();
  const anchor = pieces.find((p) => p.key === input.key);
  if (!anchor || !metrics(anchor.part)) return { spot: null, fits: [], wanted: anchor ? [anchor.part] : [] };
  const sc = sceneAround(pieces, posOf(anchor.world), metrics);
  const target = input.spot ?? freeSpots(sc, anchor.key, input.point)[0];
  if (!target) return { spot: null, fits: [], wanted: [] };
  const spot: Spot = { key: anchor.key, conn: target, label: spotLabel(target) };
  const anchorName = name(anchor.part);
  const total = habits?.models ?? 0;
  const counts = new Map<number, number>();
  for (const p of pieces) counts.set(p.color, (counts.get(p.color) ?? 0) + 1);
  const otherColour = [...counts.entries()].filter(([k]) => k !== anchor.color).sort((a, b) => b[1] - a[1])[0]?.[0] ?? anchor.color;
  const exists = (id: string, w: THREE.Matrix4) => pieces.some((p) => p.part === id && samePose(p.world, w));
  const onSpot = (m: PartMetrics, w: THREE.Matrix4) => worldConnectors(partConnectors(m), w.elements).some((c) => mates(c, target));
  const best = new Map<string, Suggestion>();
  const offer = (s: Omit<Suggestion, 'id' | 'kind' | 'anchor'>) => {
    const id = s.pieces[0].part;
    const had = best.get(id);
    if (had && had.score >= s.score) return;
    best.set(id, { ...s, id: `fit:${id}@${s.pieces[0].world.slice(12, 15).map(Math.round).join(',')}`, kind: 'fit', anchor: anchor.key });
  };
  const mine = habitsOf(habits, anchor.part);

  // 1. exactly where builders put a part on this one, when that is the spot
  for (const x of mine) {
    if (performance.now() - t0 > budget) break;
    const other = part(habits!, x[0]);
    const w = anchor.world.clone().multiply(relOf(habits!, x));
    const m = metrics(other);
    if (!m) { wanted.add(other); continue; }
    if (exists(other, w) || !onSpot(m, w)) continue;
    const links = fit(sc, m, w, { solids: [], conns: [] });
    if (!links) continue;
    offer({
      title: name(other),
      why: `Builders put a ${name(other)} right here on a ${anchorName} in ${x[5].toLocaleString()} of ${total.toLocaleString()} BrickNet models.`,
      pieces: [{ part: other, color: x[6] >= 50 ? anchor.color : otherColour, world: Array.from(w.elements) }],
      score: 4 + Math.log2(1 + x[5]) + links * 0.05, links,
    });
  }

  // 2. parts that join this part (or this kind of connection) anywhere, seated on the spot
  const withAnchor = new Map<string, { models: number; same: number }>();
  for (const x of mine) {
    const id = part(habits!, x[0]);
    const had = withAnchor.get(id);
    if (!had || had.models < x[5]) withAnchor.set(id, { models: x[5], same: x[6] });
  }
  const byKind = new Map<string, number>();
  for (const k of KINDS[target.type]) for (const [i, n] of habits?.partners[k] ?? []) byKind.set(part(habits!, i), Math.max(byKind.get(part(habits!, i)) ?? 0, n));
  const want = target.gender === 'M' ? 'F' : 'M';
  const staples = STAPLES[`${target.type}:${target.gender}`] ?? [];
  const candidates = [...new Set([...[...withAnchor.keys()].slice(0, 14), ...staples, ...[...byKind.keys()].slice(0, 8)])];
  for (const other of candidates) {
    if (performance.now() - t0 > budget) break;
    const m = metrics(other);
    if (!m) { wanted.add(other); continue; }
    const grips = partConnectors(m).filter((g) => g.gender === want && g.type === target.type && g.fit === target.fit);
    let top: { w: THREE.Matrix4; links: number; d: number } | null = null;
    // grips nearest the part's middle first: a plate centred on a stud, not hanging off it
    const mid = new THREE.Vector3().addVectors(new THREE.Vector3(...m.body.min), new THREE.Vector3(...m.body.max)).multiplyScalar(0.5);
    const order = grips.map((g) => ({ g, d: dist3(g.pos, [mid.x, mid.y, mid.z]) })).sort((a, b) => a.d - b.d).slice(0, 8);
    for (const { g } of order) for (const yaw of YAWS) {
      const w = seat(g, target, yaw);
      if (exists(other, w)) continue;
      const links = fit(sc, m, w, { solids: [], conns: [] });
      if (!links) continue;
      // fewer overhangs: the part's middle close to the spot
      const c = new THREE.Vector3().copy(mid).applyMatrix4(w);
      const d = c.distanceTo(new THREE.Vector3(...target.pos));
      if (!top || links > top.links || (links === top.links && d < top.d - 1e-6)) top = { w, links, d };
    }
    if (!top) continue;
    const ha = withAnchor.get(other), kind = byKind.get(other) ?? 0;
    const why = ha
      ? `Fits this ${spot.label}. Builders join a ${name(other)} to a ${anchorName} in ${ha.models.toLocaleString()} BrickNet models.`
      : kind
        ? `Fits this ${spot.label}; one of the parts most often joined this way (${kind.toLocaleString()} BrickNet models).`
        : `Fits this ${spot.label}: a common part for it.`;
    offer({
      title: name(other), why,
      pieces: [{ part: other, color: ha ? (ha.same >= 50 ? anchor.color : otherColour) : target.type === 'pin' ? otherColour : anchor.color, world: Array.from(top.w.elements) }],
      score: 1 + (ha ? Math.log2(1 + ha.models) : 0) + Math.log2(1 + kind) * 0.3 + (staples.includes(other) ? 0.5 : 0) + top.links * 0.1,
      links: top.links,
    });
  }
  const fits = [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return { spot, fits, wanted: [...wanted] };
}

/** Spots worth flagging on the pieces: free non-stud connections (one per hole, not one per end). */
export function openSpots(pieces: readonly Placed[], keys: readonly string[], metrics: FitsInput['metrics'], max = 12): Spot[] {
  const out: Spot[] = [];
  const done = new Set<string>();
  for (const key of keys) {
    const p = pieces.find((x) => x.key === key);
    if (!p || !metrics(p.part)) continue;
    const sc = sceneAround(pieces, posOf(p.world), metrics);
    for (const t of freeSpots(sc, key)) {
      if (t.type === 'stud' || done.has(`${t.owner}:${t.pos.map(Math.round)}`)) continue;
      // both ends of one through hole: keep the first
      if (out.some((o) => o.key === key && o.conn.type === t.type && o.conn.gender === t.gender && onLine(o.conn, t))) continue;
      done.add(`${t.owner}:${t.pos.map(Math.round)}`);
      out.push({ key, conn: t, label: spotLabel(t) });
      if (out.length >= max) return out;
    }
  }
  return out;
}

function onLine(a: Connector, b: Connector): boolean {
  const d = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len > 60) return false;
  if (len < 1) return true;
  const along = Math.abs(d[0] * a.axis[0] + d[1] * a.axis[1] + d[2] * a.axis[2]) / len;
  return along > 0.999;
}
