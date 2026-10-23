import type { Box } from '../ldraw/flatten';

/** A piece (or attached submodel) of one step: its id and where it ends up. */
export type OrderItem = { id: string; box: Box };

/** boxes this close (LDU) count as touching */
const TOUCH = 1;
/** bottoms or tops within this (LDU) count as level */
const LEVEL = 2;

const touching = (a: Box, b: Box) =>
  a.min[0] <= b.max[0] + TOUCH && b.min[0] <= a.max[0] + TOUCH &&
  a.min[1] <= b.max[1] + TOUCH && b.min[1] <= a.max[1] + TOUCH &&
  a.min[2] <= b.max[2] + TOUCH && b.min[2] <= a.max[2] + TOUCH;

/**
 * Whether `q` must be placed before `p`: they touch and `q` sits lower (LDraw −Y is
 * up, so a box's bottom is max[1]). With level bottoms, the taller piece goes first —
 * a minifig arm hangs on the torso, not the other way round.
 */
function holds(q: Box, p: Box): boolean {
  if (!touching(q, p)) return false;
  if (q.max[1] > p.max[1] + LEVEL) return true;
  return Math.abs(q.max[1] - p.max[1]) <= LEVEL && q.min[1] < p.min[1] - LEVEL;
}

/**
 * Orders one step's pieces so each is placed after whatever it rests on (no head
 * landing in mid-air before the legs). Otherwise the given order is kept: of the
 * pieces ready to place, the earliest in the plan goes first. If overlapping boxes
 * ever make the rules circular, the earliest remaining piece is taken.
 */
export function bottomUpOrder<T extends OrderItem>(items: T[]): T[] {
  const n = items.length;
  if (n < 2) return items.slice();
  const waits = new Array<number>(n).fill(0);
  const next: number[][] = items.map(() => []);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (i !== j && holds(items[j].box, items[i].box)) {
        waits[i]++;
        next[j].push(i);
      }
  const done = new Array<boolean>(n).fill(false);
  const out: T[] = [];
  while (out.length < n) {
    let pick = -1;
    for (let i = 0; i < n; i++) if (!done[i] && waits[i] === 0) { pick = i; break; }
    if (pick < 0) pick = done.indexOf(false);
    done[pick] = true;
    out.push(items[pick]);
    for (const k of next[pick]) waits[k]--;
  }
  return out;
}

/**
 * A buildable order for one step, found by taking the finished step apart: keep
 * removing a piece that can leave (`canLeave`, judged on real shapes against the
 * pieces still there); the reverse is an order in which every piece can go on.
 * Removing a piece never traps another, so this only fails when the shapes truly
 * lock (then the piece is taken anyway). Of the pieces free to leave, the one
 * `preferred` builds last leaves first, so the preferred order is kept wherever
 * the shapes allow it — a minifig's hips go on before its legs, which clip on from the sides.
 *
 * `canLeave(item, others)` gets only the pieces still there that touch it.
 */
export function assemblyOrder<T extends OrderItem>(preferred: T[], canLeave: (item: T, others: T[]) => boolean): T[] {
  const n = preferred.length;
  if (n < 2) return preferred.slice();
  const near: number[][] = preferred.map(() => []);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (touching(preferred[i].box, preferred[j].box)) {
        near[i].push(j);
        near[j].push(i);
      }
  const present = new Array<boolean>(n).fill(true);
  /** how many touching pieces were still there when a piece was last found stuck */
  const stuckWith = new Array<number>(n).fill(-1);
  const count = (i: number) => near[i].reduce((c, j) => c + (present[j] ? 1 : 0), 0);
  const removal: T[] = [];
  for (let left = n; left > 0; left--) {
    let pick = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (!present[i]) continue;
      const c = count(i);
      if (stuckWith[i] === c) continue; // nothing around it changed since it was stuck
      if (c === 0 || canLeave(preferred[i], near[i].filter((j) => present[j]).map((j) => preferred[j]))) {
        pick = i;
        break;
      }
      stuckWith[i] = c;
    }
    if (pick < 0) for (let i = n - 1; i >= 0 && pick < 0; i--) if (present[i]) pick = i;
    present[pick] = false;
    removal.push(preferred[pick]);
  }
  return removal.reverse();
}
