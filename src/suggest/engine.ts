import * as THREE from 'three';
import type { PartMetrics } from '../ldraw/metrics';
import { collisionWorld, type CollisionWorld, type Solid } from '../plan/collision';
import { partConnectors, worldConnectors, type Connector } from '../plan/connectors';
import { freeTargets, seat, type Quarter, type Target } from '../plan/placementEngine';
import { MODEL_COUNT, NEXT_PART, RELATIONS } from '../data/suggestRelations.generated';
import { TECHNIQUES, type Face, type Technique } from './techniques';
import { WEDGES } from './geometry';

/**
 * Next-piece suggestions ("autocomplete" for building). Every suggestion is a set of ghost
 * pieces that seats on at least one free connector of the model and sits inside nothing,
 * checked with the editor's own connectors and collision test. Four sources:
 *
 * - habit: where builders put a part relative to the anchor part, mined from real models
 *   (src/data/suggestRelations.generated.ts);
 * - mirror: the model is symmetric and the anchor's counterpart is missing;
 * - repeat: the last pieces form a row; continue it;
 * - technique: a recipe from techniques.ts, solved step by step on the anchor.
 *
 * All poses are LDU in the model's LDraw frame (Y down), matrices column-major.
 */

export type Placed = { key: string; part: string; color: number; world: THREE.Matrix4 };
export type Ghost = { part: string; color: number; world: number[] };
export type SuggestionKind = 'habit' | 'mirror' | 'repeat' | 'technique';
export type Suggestion = {
  id: string;
  kind: SuggestionKind;
  title: string;
  why: string;
  pieces: Ghost[];
  score: number;
  /** the anchor piece it builds on */
  anchor: string;
  technique?: string;
  /** connections the pieces make */
  links: number;
};
export type SuggestInput = {
  pieces: readonly Placed[];
  /** keys of the pieces to build on (the selection, or the last placed); empty: the last piece */
  anchors: readonly string[];
  /** null while a part is not loaded yet (the caller loads `wanted` and asks again) */
  metrics: (part: string) => PartMetrics | null;
  /** human name of a part */
  name?: (part: string) => string;
  limit?: number;
  /** give up on more candidates after this long (ms) */
  budgetMs?: number;
  /** technique suggestions kept (recipes fit almost anywhere); default 3 */
  maxTechniques?: number;
};
export type SuggestOutput = { suggestions: Suggestion[]; wanted: string[] };

/** How far round the anchor (LDU) pieces count for collision and free connectors. */
const NEAR = 240;
const YAWS: Quarter[] = [0, 90, 180, 270];
const EPS = 0.75;

const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mates = (c: Connector, t: Connector) => c.gender !== t.gender && c.type === t.type && dist3(c.pos, t.pos) < 1 && dot3(c.axis, t.axis) < -0.999;
const posOf = (m: THREE.Matrix4) => [m.elements[12], m.elements[13], m.elements[14]];

function solidOf(id: string, m: PartMetrics, world: ArrayLike<number>): Solid {
  return { id, world, body: m.body, studs: m.studs, snaps: m.snaps, mesh: m.mesh };
}

/** Which face of its own part a connector is on: its axis in part space. */
function faceOf(c: Connector): Face | null {
  if (Math.abs(c.axis[1]) < 0.5) return 'side';
  if (c.gender === 'M' && c.axis[1] < -0.9) return 'top';
  if (c.gender === 'F' && c.axis[1] > 0.9) return 'under';
  return null;
}

/** Same part at (nearly) the same pose: already there. */
function samePose(a: THREE.Matrix4, b: THREE.Matrix4): boolean {
  const x = a.elements, y = b.elements;
  for (let i = 0; i < 16; i++) if (Math.abs(x[i] - y[i]) > (i >= 12 ? EPS : 1e-3)) return false;
  return true;
}

type Scene = {
  near: Placed[];
  world: CollisionWorld;
  targets: Target[];
  conns: Map<string, Connector[]>;
  local: Map<string, Connector[]>;
};

function sceneAround(pieces: readonly Placed[], centre: number[], metrics: SuggestInput['metrics']): Scene {
  const near = pieces.filter((p) => dist3(posOf(p.world), centre) < NEAR && metrics(p.part));
  const solids = near.map((p) => solidOf(p.key, metrics(p.part)!, p.world.elements));
  const conns = new Map<string, Connector[]>(), local = new Map<string, Connector[]>();
  for (const p of near) {
    const l = partConnectors(metrics(p.part)!);
    local.set(p.key, l);
    conns.set(p.key, worldConnectors(l, p.world.elements));
  }
  return { near, world: collisionWorld(solids), targets: freeTargets(near.map((p) => ({ list: conns.get(p.key)!, owner: p.key })), solids), conns, local };
}

/**
 * Whether `part` at `world` fits: it sits inside nothing (the scene, or `extra` ghosts) and
 * mates at least one free connector. Returns how many it mates (0 = does not fit).
 */
function fit(sc: Scene, m: PartMetrics, world: THREE.Matrix4, extra: { solids: Solid[]; conns: Connector[] }): number {
  const s = solidOf('ghost', m, world.elements);
  if (sc.world.hits([s]).size) return 0;
  if (extra.solids.length && collisionWorld(extra.solids).hits([s]).size) return 0;
  const mine = worldConnectors(partConnectors(m), world.elements);
  let n = 0;
  for (const c of mine) if (sc.targets.some((t) => mates(c, t)) || extra.conns.some((t) => mates(c, t))) n++;
  return n;
}

const MIRROR: Record<string, string> = Object.fromEntries(WEDGES.flatMap((w) => [[w.left, w.right], [w.right, w.left]]));

/** A mirror plane the model is (mostly) symmetric about: x = c or z = c (LDU), if any. */
export function symmetryPlane(pieces: readonly Placed[]): { axis: 0 | 2; at: number } | null {
  if (pieces.length < 4) return null;
  let best: { axis: 0 | 2; at: number; share: number } | null = null;
  for (const axis of [0, 2] as const) {
    const xs = pieces.map((p) => p.world.elements[12 + axis]);
    const centre = Math.round(((Math.min(...xs) + Math.max(...xs)) / 2) / 10) * 10;
    for (const at of [centre - 10, centre, centre + 10]) {
      let hit = 0;
      for (const p of pieces) {
        const q = posOf(p.world);
        q[axis] = 2 * at - q[axis];
        if (pieces.some((o) => (o.part === p.part || MIRROR[o.part] === p.part) && dist3(posOf(o.world), q) < EPS)) hit++;
      }
      const share = hit / pieces.length;
      if (!best || share > best.share) best = { axis, at, share };
    }
  }
  return best && best.share >= 0.6 ? { axis: best.axis, at: best.at } : null;
}

function mirrored(p: Placed, plane: { axis: 0 | 2; at: number }): THREE.Matrix4 {
  const S = new THREE.Matrix4().makeScale(plane.axis === 0 ? -1 : 1, 1, plane.axis === 2 ? -1 : 1);
  const T = new THREE.Matrix4().makeTranslation(plane.axis === 0 ? 2 * plane.at : 0, 0, plane.axis === 2 ? 2 * plane.at : 0);
  // reflect the position, keep the part right-handed: R' = S R S
  const m = T.multiply(S).multiply(p.world.clone()).multiply(S.clone());
  return m;
}

function relMatrix(r: number[]): THREE.Matrix4 {
  // r: [r00..r22 row-major, tx, ty, tz]
  return new THREE.Matrix4().set(r[0], r[1], r[2], r[9], r[3], r[4], r[5], r[10], r[6], r[7], r[8], r[11], 0, 0, 0, 1);
}

/** Poses tried per recipe step before backing up, and pose checks per recipe in all. */
const STEP_TRIES = 12;
const RECIPE_CHECKS = 1500;

/**
 * Solve a technique recipe on `anchor`: each step seats its part on a free connector of
 * the step it names, on the named face of that piece. Poses are tried best first (mating
 * most, then sitting closest to that piece); when a later step finds no room, the search
 * backs up and tries the earlier step's next pose. Null when no arrangement fits.
 */
export function solveRecipe(t: Technique, anchor: Placed, sc: Scene, metrics: SuggestInput['metrics'], wanted: Set<string>): { pieces: Ghost[]; links: number } | null {
  const recipe = t.recipe;
  if (!recipe) return null;
  const ms: PartMetrics[] = [];
  for (const step of recipe) {
    const m = metrics(step.part);
    if (!m) wanted.add(step.part);
    else ms.push(m);
  }
  if (ms.length !== recipe.length) return null;
  type Done = { world: THREE.Matrix4; solid: Solid; conns: Connector[]; n: number };
  const done: Done[] = [];
  let checks = 0;

  const options = (i: number): { world: THREE.Matrix4; n: number; d: number }[] => {
    const step = recipe[i], m = ms[i];
    const base = step.on < 0 ? { world: anchor.world, local: sc.local.get(anchor.key) ?? [] }
      : { world: done[step.on].world, local: partConnectors(ms[step.on]) };
    const others = done.flatMap((d, j) => (j === step.on ? [] : d.conns));
    const mineSoFar = done.flatMap((d) => d.conns);
    // free connectors of the base piece on the wanted face
    const baseWorld = worldConnectors(base.local, base.world.elements);
    const free = base.local.map((c, k) => ({ c, w: baseWorld[k] })).filter(({ c, w }) => faceOf(c) === step.face
      && !others.some((o) => mates(w, o) || (dist3(w.pos, o.pos) < 1 && w.gender === o.gender))
      && (step.on >= 0 || sc.targets.some((t2) => t2.owner === anchor.key && dist3(t2.pos, w.pos) < 1 && dot3(t2.axis, w.axis) > 0.999)));
    const grips = partConnectors(m);
    const ghosts = done.length ? collisionWorld(done.map((d) => d.solid)) : null;
    const centre = new THREE.Vector3().setFromMatrixPosition(base.world);
    const out: { world: THREE.Matrix4; n: number; d: number; natural: boolean }[] = [];
    for (const { w } of free) for (const g of grips) {
      if (g.gender === w.gender || g.type !== w.type) continue;
      // the usual way round: the new part's underside onto a stud, its studs into a socket
      const natural = faceOf(g) === (w.gender === 'M' ? 'under' : 'top');
      for (const yaw of YAWS) {
        if (++checks > RECIPE_CHECKS) return out;
        const world = seat(g, w, yaw);
        if (out.some((o) => samePose(o.world, world))) continue;
        // the ghost must fit the scene and the steps so far
        const s = solidOf('ghost', m, world.elements);
        if (sc.world.hits([s]).size || ghosts?.hits([s]).size) continue;
        const mine = worldConnectors(grips, world.elements);
        const n = mine.filter((c) => sc.targets.some((t2) => mates(c, t2)) || mineSoFar.some((o) => mates(c, o))).length;
        out.push({ world, n: Math.max(1, n), d: new THREE.Vector3().setFromMatrixPosition(world).distanceTo(centre), natural });
      }
    }
    return out.sort((a, b) => Number(b.natural) - Number(a.natural) || b.n - a.n || a.d - b.d).slice(0, STEP_TRIES);
  };

  const go = (i: number): boolean => {
    if (i === recipe.length) return true;
    for (const o of options(i)) {
      done.push({ world: o.world, n: o.n, solid: solidOf(`g${i}`, ms[i], o.world.elements), conns: worldConnectors(partConnectors(ms[i]), o.world.elements) });
      if (go(i + 1)) return true;
      done.pop();
      if (checks > RECIPE_CHECKS) return false;
    }
    return false;
  };
  if (!go(0)) return null;
  return {
    pieces: done.map((d, i) => ({ part: recipe[i].part, color: anchor.color, world: Array.from(d.world.elements) })),
    links: done.reduce((s, d) => s + d.n, 0),
  };
}

/** Suggestions for what to place next on the anchors, best first. */
export function suggest(input: SuggestInput): SuggestOutput {
  const { pieces, metrics } = input;
  const name = input.name ?? ((p: string) => p);
  const limit = input.limit ?? 6;
  const t0 = performance.now(), budget = input.budgetMs ?? 120;
  const wanted = new Set<string>();
  const out: Suggestion[] = [];
  if (!pieces.length) return { suggestions: [], wanted: [] };
  const byKey = new Map(pieces.map((p) => [p.key, p]));
  const anchors = (input.anchors.length ? input.anchors : [pieces[pieces.length - 1].key]).map((k) => byKey.get(k)).filter((p): p is Placed => !!p);
  if (!anchors.length) return { suggestions: [], wanted: [] };
  const anchor = anchors[0];
  const sc = sceneAround(pieces, posOf(anchor.world), metrics);
  const exists = (part: string, w: THREE.Matrix4) => pieces.some((p) => p.part === part && samePose(p.world, w));
  const seen = new Set<string>();
  const add = (s: Omit<Suggestion, 'id'>) => {
    const id = `${s.kind}:${s.pieces.map((g) => `${g.part}@${g.world.slice(12, 15).map(Math.round).join(',')}`).join('+')}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ ...s, id });
  };
  const counts = new Map<number, number>();
  for (const p of pieces) counts.set(p.color, (counts.get(p.color) ?? 0) + 1);
  const otherColour = (c: number) => [...counts.entries()].filter(([k]) => k !== c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? c;

  // ---- mirror: strongest signal when the model is symmetric
  const plane = symmetryPlane(pieces);
  if (plane) {
    for (const a of anchors.concat(pieces.slice(-4).reverse())) {
      const w = mirrored(a, plane);
      const part = MIRROR[a.part] ?? a.part;
      if (dist3(posOf(w), posOf(a.world)) < EPS || exists(part, w)) continue;
      const m = metrics(part);
      if (!m) { wanted.add(part); continue; }
      const n = fit(sc, m, w, { solids: [], conns: [] });
      if (!n) continue;
      add({ kind: 'mirror', title: `Mirror ${name(part)}`, why: `The model is symmetric about ${plane.axis === 0 ? 'X' : 'Z'}; this is the other side of a piece you placed.`, pieces: [{ part, color: a.color, world: Array.from(w.elements) }], score: 6 + n * 0.1, anchor: a.key, links: n });
    }
  }

  // ---- repeat: the last two pieces of one part make a step; take it again
  const last = pieces[pieces.length - 1], prev = [...pieces].reverse().find((p) => p !== last && p.part === last.part);
  if (prev) {
    const dR = prev.world.clone().invert().multiply(last.world);
    const next = last.world.clone().multiply(dR);
    const step = dist3(posOf(next), posOf(last.world));
    const m = metrics(last.part);
    if (step > EPS && step < 200 && m && !exists(last.part, next)) {
      const n = fit(sc.near.includes(last) ? sc : sceneAround(pieces, posOf(last.world), metrics), m, next, { solids: [], conns: [] });
      if (n) add({ kind: 'repeat', title: `Continue the row of ${name(last.part)}`, why: `Same step as your last two ${name(last.part)} pieces.`, pieces: [{ part: last.part, color: last.color, world: Array.from(next.elements) }], score: 5 + n * 0.1, anchor: last.key, links: n });
    }
  }

  // ---- habits from real models
  const following = new Map((NEXT_PART[anchor.part] ?? []).map(([p, n]) => [p, n]));
  for (const a of anchors) {
    for (const r of RELATIONS[a.part] ?? []) {
      if (performance.now() - t0 > budget) break;
      const [other, models, sameShare] = r as [string, number, number];
      const w = a.world.clone().multiply(relMatrix(r.slice(3) as number[]));
      if (exists(other, w)) continue;
      const m = metrics(other);
      if (!m) { wanted.add(other); continue; }
      const n = fit(sc, m, w, { solids: [], conns: [] });
      if (!n) continue;
      const colour = sameShare >= 0.5 ? a.color : otherColour(a.color);
      const next = following.get(other) ?? 0;
      add({
        kind: 'habit', title: `${name(other)}`,
        why: `Builders put this here on a ${name(a.part)} in ${models} of ${MODEL_COUNT} models${next ? `, and often place it right after one (${next}×)` : ''}.`,
        pieces: [{ part: other, color: colour, world: Array.from(w.elements) }],
        score: 2 + Math.log2(1 + models) * 0.6 + Math.log2(1 + next) * 0.3 + n * 0.05, anchor: a.key, links: n,
      });
    }
  }

  // ---- techniques
  const snotty = pieces.some((p) => ['87087', '4070', '47905', '26604', '4733', '99781', '99780', '32952', '99206'].includes(p.part));
  for (const t of TECHNIQUES) {
    if (!t.recipe || performance.now() - t0 > budget * 2) continue;
    const r = solveRecipe(t, anchor, sc, metrics, wanted);
    if (!r) continue;
    const relevant = (t.parts.includes(anchor.part) ? 1 : 0) + (snotty && t.tags.includes('snot') ? 0.5 : 0);
    add({ kind: 'technique', title: t.name, why: `${t.goal} ${t.rule}`, pieces: r.pieces, score: 1.5 + relevant + Math.min(1, r.pieces.length * 0.2), anchor: anchor.key, technique: t.id, links: r.links });
  }

  // mix the kinds: the best of each first, then the rest by score
  out.sort((a, b) => b.score - a.score);
  const firsts = new Map<SuggestionKind, Suggestion>();
  for (const s of out) if (!firsts.has(s.kind)) firsts.set(s.kind, s);
  const head = [...firsts.values()].sort((a, b) => b.score - a.score);
  // recipes fit almost anywhere: keep at most three, unless they use the anchor's own part
  let techniques = head.filter((s) => s.kind === 'technique').length;
  const rest = out.filter((s) => !head.includes(s)).filter((s) => {
    if (s.kind !== 'technique' || TECHNIQUES.find((t) => t.id === s.technique)?.parts.includes(anchor.part)) return true;
    return ++techniques <= (input.maxTechniques ?? 3);
  });
  return { suggestions: [...head, ...rest].slice(0, limit), wanted: [...wanted] };
}
