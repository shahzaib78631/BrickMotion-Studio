/**
 * Loops in the body graph. Bodies are nodes; lower-pair joints and higher
 * pairs (gear meshes, rack, worm, screw) are edges.
 *
 * Fundamental loops follow the cut-joint form (spec D.1, E): a spanning tree
 * built from joints before higher pairs, so every higher pair that closes a
 * loop is a cut joint and the tree holds lower pairs only (Müller, Mech. Sci.
 * 2015, Fig. 8). Each non-tree edge closes one loop: #loops = edges - bodies
 * + components.
 *
 * Pattern matching wants each loop at its smallest, so `shortestLoop` gives
 * the shortest cycle through one joint.
 */
export type JointEdge = { a: number; b: number };
export type PairEdge = { id: string; a: number; b: number };
export type Loop = { bodies: number[]; joints: number[]; pairs: string[] };

type Edge = { a: number; b: number; joint?: number; pair?: string };

export function fundamentalLoops(bodyCount: number, joints: readonly JointEdge[], pairs: readonly PairEdge[]): Loop[] {
  const edges: Edge[] = [...joints.map((j, n) => ({ a: j.a, b: j.b, joint: n })), ...pairs.map(p => ({ a: p.a, b: p.b, pair: p.id }))];
  const parent = [...Array(bodyCount).keys()];
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const tree: Edge[][] = Array.from({ length: bodyCount }, () => []);
  const cuts: Edge[] = [];
  for (const e of edges) {
    if (e.a === e.b) continue;
    const ra = find(e.a), rb = find(e.b);
    if (ra === rb) { cuts.push(e); continue; }
    parent[ra] = rb;
    tree[e.a].push(e); tree[e.b].push(e);
  }
  return cuts.map(cut => {
    const path = treePath(tree, cut.a, cut.b);
    const all = [...path, cut];
    const bodies = new Set<number>();
    for (const e of all) { bodies.add(e.a); bodies.add(e.b); }
    return {
      bodies: [...bodies],
      joints: all.flatMap(e => (e.joint === undefined ? [] : [e.joint])).sort((x, y) => x - y),
      pairs: all.flatMap(e => (e.pair === undefined ? [] : [e.pair])).sort(),
    };
  });
}

/** Tree edges from a to b (breadth first over the spanning tree). */
function treePath(tree: Edge[][], a: number, b: number): Edge[] {
  const via = new Map<number, Edge>([[a, undefined as never]]);
  const queue = [a];
  while (queue.length && !via.has(b)) {
    const x = queue.shift()!;
    for (const e of tree[x]) { const y = e.a === x ? e.b : e.a; if (!via.has(y)) { via.set(y, e); queue.push(y); } }
  }
  const out: Edge[] = [];
  for (let x = b; x !== a;) { const e = via.get(x)!; out.push(e); x = e.a === x ? e.b : e.a; }
  return out;
}

/** An ordered cycle: joints[i] joins bodies[i] and bodies[i + 1] (wrapping). */
export type Cycle = { bodies: number[]; joints: number[] };

/**
 * The shortest cycle of joints through `joint`, at most `maxJoints` long,
 * not passing through any body in `avoid`; null when there is none.
 */
export function shortestLoop(joints: readonly JointEdge[], around: readonly number[][], joint: number, maxJoints = 6, avoid: ReadonlySet<number> = new Set()): Cycle | null {
  const { a, b } = joints[joint];
  if (a === b) return null;
  // Breadth first from b back to a without using `joint`.
  const via = new Map<number, number>([[b, -1]]), depth = new Map([[b, 0]]);
  const queue = [b];
  while (queue.length && !via.has(a)) {
    const x = queue.shift()!;
    if (depth.get(x)! >= maxJoints - 1) continue;
    for (const e of around[x]) {
      if (e === joint) continue;
      const y = joints[e].a === x ? joints[e].b : joints[e].a;
      if (via.has(y) || (avoid.has(y) && y !== a)) continue;
      via.set(y, e); depth.set(y, depth.get(x)! + 1); queue.push(y);
    }
  }
  if (!via.has(a)) return null;
  // Walk a -> ... -> b, then close with `joint` (b -> a).
  const bodies = [a], path: number[] = [];
  for (let x = a; x !== b;) { const e = via.get(x)!; path.push(e); x = joints[e].a === x ? joints[e].b : joints[e].a; bodies.push(x); }
  return { bodies, joints: [...path, joint] };
}

/** Joint indices around each body. */
export function jointsAround(bodyCount: number, joints: readonly JointEdge[]): number[][] {
  const around: number[][] = Array.from({ length: bodyCount }, () => []);
  joints.forEach((j, n) => { if (j.a !== j.b) { around[j.a].push(n); around[j.b].push(n); } });
  return around;
}

/** Biconnected blocks of the joint graph, as joint index lists (Hopcroft-Tarjan). */
export function blocks(bodyCount: number, joints: readonly JointEdge[]): number[][] {
  const around = jointsAround(bodyCount, joints);
  const order = new Array<number>(bodyCount).fill(-1), low = new Array<number>(bodyCount).fill(0);
  const out: number[][] = [], stack: number[] = [];
  let time = 0;
  for (let root = 0; root < bodyCount; root++) {
    if (order[root] !== -1) continue;
    // Iterative DFS: frames of [body, joint used to enter, next neighbour index].
    const frames: [number, number, number][] = [[root, -1, 0]];
    order[root] = low[root] = time++;
    while (frames.length) {
      const top = frames[frames.length - 1], [x, enter] = top;
      if (top[2] < around[x].length) {
        const e = around[x][top[2]++];
        if (e === enter) continue;
        const y = joints[e].a === x ? joints[e].b : joints[e].a;
        if (order[y] === -1) {
          stack.push(e); order[y] = low[y] = time++; frames.push([y, e, 0]);
        } else if (order[y] < order[x]) {
          stack.push(e); low[x] = Math.min(low[x], order[y]);
        }
        continue;
      }
      frames.pop();
      if (!frames.length) continue;
      const p = frames[frames.length - 1][0];
      low[p] = Math.min(low[p], low[x]);
      if (low[x] >= order[p]) {
        const block: number[] = [];
        for (;;) { const e = stack.pop()!; block.push(e); if (e === enter) break; }
        out.push(block);
      }
    }
  }
  return out;
}
