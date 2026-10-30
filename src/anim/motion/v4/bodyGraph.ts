/**
 * The mechanism graph seen as rigid bodies: each rigid cluster is one body,
 * joined to others by its movable joints. Used to work out what a moving
 * body carries with it (wheels on an axle, a trailer on a turntable).
 */
import type { MechanismEdge, MechanismGraph } from './mechanismGraph';

export type BodyLink = { to: string; edge: MechanismEdge };
export type BodyGraph = {
  /** Body id (first member key) of a part. */
  of(key: string): string;
  members(body: string): readonly string[];
  links(body: string): readonly BodyLink[];
};

export function bodyGraph(graph: MechanismGraph): BodyGraph {
  const cluster = new Map<string, readonly string[]>();
  for (const c of graph.rigidClusters) for (const k of c) cluster.set(k, c);
  const of = (key: string) => (cluster.get(key) ?? [key])[0];
  const links = new Map<string, BodyLink[]>();
  for (const edge of graph.edges) {
    const a = of(edge.a), b = of(edge.b);
    if (a === b) continue;
    for (const [x, y] of [[a, b], [b, a]]) {
      const list = links.get(x) ?? [];
      list.push({ to: y, edge });
      links.set(x, list);
    }
  }
  return { of, members: body => cluster.get(body) ?? [body], links: body => links.get(body) ?? [] };
}

export type Carried = {
  /** Bodies that move with the start body (start included). */
  bodies: string[];
  /** Part keys of all those bodies. */
  parts: string[];
  /** Joints from a carried body (not the start) into a stop body: a closed loop. */
  loops: BodyLink[];
};

/**
 * Everything attached to `start` that is not on the far side of a stop body.
 * Returns null when it grows past `maxParts`, which usually means the start
 * is part of the main structure rather than a moving piece.
 */
export function carriedBodies(g: BodyGraph, start: string, stop: ReadonlySet<string>, maxParts: number): Carried | null {
  const seen = new Set([start]), queue = [start], loops: BodyLink[] = [];
  let parts = g.members(start).length;
  while (queue.length) {
    const body = queue.pop()!;
    for (const link of g.links(body)) {
      if (stop.has(link.to)) { if (body !== start) loops.push(link); continue; }
      if (seen.has(link.to)) continue;
      seen.add(link.to); queue.push(link.to);
      parts += g.members(link.to).length;
      if (parts > maxParts) return null;
    }
  }
  const bodies = [...seen];
  return { bodies, parts: bodies.flatMap(b => [...g.members(b)]), loops };
}
