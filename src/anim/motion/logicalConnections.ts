/**
 * Connection-first order proposals for Standard Motion. This is deliberately
 * scoped: it never changes the saved plan, and manual `after`/`attachTo`
 * requirements are NOT removed. The original Standard planner remains intact.
 *
 * A two-sided joint must not be closed before its hub can enter the assembly.
 * For example, install one minifigure leg, bring the hips to that leg, then
 * attach the opposite leg. Joint evidence can supply the same relationship for
 * a generic three-piece mechanism. Candidate orders are subsequently routed
 * and scored against the parts that would actually be installed at that time.
 */
import type { Assembly, ANode } from '../../model/assemble';
import type { MechanicalJoint } from '../construction/mechanicalConstraintGraph';

export type ConnectionChain = {
  first: string;
  hub: string;
  last: string;
  /** 'anatomy' can be detected without external LDraw connector metadata. */
  kind: 'anatomy' | 'joint';
};
export type LogicalProposal = {
  assembly: Assembly;
  label: string;
  /** Dependency in full instance key space: child -> host. */
  guides: Map<string, string>;
  chains: ConnectionChain[];
  /** The actual proposed attachment sequence (not always leg-first). */
  sequences: string[][];
  /** Lower is a preference only, not a substitute for a clear route. */
  preference: number;
};

type Scoped = { scope: string; node: ANode; key: string; box: {
  min: [number, number, number]; max: [number, number, number];
} };
const nearDistance = (a: Scoped['box'], b: Scoped['box']) => Math.sqrt(
  [0, 1, 2].reduce((sum, k) => sum + Math.max(0,
    a.min[k] - b.max[k], b.min[k] - a.max[k]) ** 2, 0));
const position = (n: ANode) => n.local.pos;
const hips = (p: string) => /^3815(?:[a-z]|$)/i.test(p.replace(/\.dat$/i, '').split('/').pop() ?? '');
const leg = (p: string) => /^381[67](?:[a-z]|$)/i.test(p.replace(/\.dat$/i, '').split('/').pop() ?? '');
const center = (box: Scoped['box'], k: number) => (box.min[k] + box.max[k]) / 2;
const acrossHips = (e: Scoped, hub: Scoped) => {
  // First column of the hips' local rotation in the containing model. This
  // continues to work when the whole minifigure is turned sideways.
  const r = hub.node.local.m;
  return [0,1,2].reduce((sum, k) => sum +
    (center(e.box, k) - center(hub.box, k)) * r[k * 3], 0);
};

/** Bounds in the containing model, using the already composed local placement. */
function localBounds(node: ANode): Scoped['box'] {
  const { min, max } = node.body;
  const p = position(node), r = node.local.m;
  const mid = [0, 1, 2].map(k => (min[k] + max[k]) / 2);
  const half = [0, 1, 2].map(k => (max[k] - min[k]) / 2);
  const a = [0, 1, 2].map(k => p[k] + r[3 * k] * mid[0] + r[3 * k + 1] * mid[1] + r[3 * k + 2] * mid[2]);
  const h = [0, 1, 2].map(k => Math.abs(r[3 * k]) * half[0] +
    Math.abs(r[3 * k + 1]) * half[1] + Math.abs(r[3 * k + 2]) * half[2]);
  return { min: a.map((x, k) => x - h[k]) as [number,number,number],
    max: a.map((x, k) => x + h[k]) as [number,number,number] };
}

function groups(asm: Assembly): Map<string, Scoped[]> {
  const out = new Map<string, Scoped[]>();
  const walk = (nodes: ANode[], scope: string) => {
    for (const node of nodes) {
      const key = scope ? `${scope}/${node.itemId}` : node.itemId;
      if (node.kind === 'sub') { walk(node.children, key); continue; }
      const list = out.get(scope) ?? [];
      list.push({ scope, node, key, box: localBounds(node) });
      out.set(scope, list);
    }
  };
  walk(asm.nodes, '');
  return out;
}

/** Detect isolated, two-sided connection hubs without interpreting a box touch as a joint. */
export function detectConnectionChains(asm: Assembly, joints: MechanicalJoint[] = []): ConnectionChain[] {
  const chains: ConnectionChain[] = [];
  const byScope = groups(asm);
  const used = new Set<string>();
  for (const siblings of byScope.values()) {
    const legs = siblings.filter(e => e.node.kind === 'piece' && leg(e.node.part));
    const centres = siblings.filter(e => e.node.kind === 'piece' && hips(e.node.part));
    // Nearest HIP first. Each leg belongs to only one nearby hips connector.
    for (const hub of centres) {
      if (used.has(hub.key)) continue;
      const options = legs.filter(e => !used.has(e.key) && nearDistance(e.box, hub.box) <= 12)
        .sort((a, b) => nearDistance(a.box, hub.box) - nearDistance(b.box, hub.box) || a.key.localeCompare(b.key));
      if (options.length < 2) continue;
      // Only join two sides of the same hub. Two nearby legs both on the
      // left of one hips part may actually belong to adjacent figures.
      const pairs = options.flatMap((a, i) => options.slice(i + 1).map(b => ({ a, b,
        left: acrossHips(a, hub), right: acrossHips(b, hub),
        distance: nearDistance(a.box, hub.box) + nearDistance(b.box, hub.box),
      }))).filter(p => p.left * p.right < -1)
        .sort((a, b) => a.distance - b.distance || a.a.key.localeCompare(b.a.key));
      if (!pairs.length) continue;
      const paired = [pairs[0].a, pairs[0].b].sort((a, b) => acrossHips(a, hub) - acrossHips(b, hub));
      for (const e of [hub, ...paired]) used.add(e.key);
      chains.push({ first: paired[0].key, hub: hub.key, last: paired[1].key, kind: 'anatomy' });
    }
  }
  // Typed mechanical connectors, not arbitrary bounding-box overlap. Avoid
  // large studs/brick networks: consider only compact, independent 2-ended hubs.
  const neighbors = new Map<string, Set<string>>();
  for (const j of joints) {
    if (!['hinge', 'clip', 'ball-socket', 'pin-hole', 'axle-hole', 'cylindrical'].includes(j.type)) continue;
    for (const [a, b] of [[j.male, j.female], [j.female, j.male]]) {
      const list = neighbors.get(a) ?? new Set<string>();
      list.add(b); neighbors.set(a, list);
    }
  }
  for (const siblings of byScope.values()) {
    const all = new Map(siblings.map(n => [n.key, n]));
    for (const hub of siblings) {
      if (used.has(hub.key) || hub.node.assembly?.root) continue;
      const neighborsHere = [...(neighbors.get(hub.key) ?? [])].filter(key => all.has(key) && !used.has(key)).sort();
      if (neighborsHere.length !== 2) continue;
      const [a,b] = neighborsHere;
      if (neighbors.get(a)?.has(b) || nearDistance(all.get(a)!.box, all.get(b)!.box) > 100) continue;
      if (all.get(a)!.node.assembly?.root || all.get(b)!.node.assembly?.root) continue;
      chains.push({ first: a, hub: hub.key, last: b, kind: 'joint' });
      for (const key of [a, hub.key, b]) used.add(key);
    }
  }
  return chains;
}

/** Rewrites ONLY inferred order. A specified attachment/after is immutable. */
function applyChains(asm: Assembly, chains: ConnectionChain[], variant: 'first' | 'reverse' | 'hub'): LogicalProposal | null {
  const required = new Map<string, string[]>();
  const guides = new Map<string, string>();
  const motif: ConnectionChain[] = [];
  const sequences: string[][] = [];
  const find = new Map<string, ANode>();
  const visit = (nodes: ANode[], scope: string) => {
    for (const node of nodes) {
      const key = scope ? `${scope}/${node.itemId}` : node.itemId;
      find.set(key, node);
      if (node.kind === 'sub') visit(node.children, key);
    }
  };
  visit(asm.nodes, '');
  const add = (prev: string, next: string, matingHost = true) => {
    const list = required.get(next) ?? [];
    list.push(prev); required.set(next, list);
    if (matingHost) guides.set(next, prev);
  };
  for (const chain of chains) {
    const c = variant === 'reverse' ? { ...chain, first: chain.last, last: chain.first } : chain;
    const order = variant === 'hub' ? [c.hub, c.first, c.last] : [c.first, c.hub, c.last];
    if (order.some(key => !find.has(key))) continue;
    // An explicit user-specified order that contradicts this motif must win.
    const original = new Map(order.map(key => [key, find.get(key)!]));
    const earlier = (key: string, target: string) => {
      const node = original.get(key)!;
      return node.assembly?.attachTo === target || (node.assembly?.after ?? []).includes(target);
    };
    if (order.some((key, i) => order.slice(i + 1).some(later => earlier(key, find.get(later)!.itemId)))) continue;
    if (order.slice(1).some(key => original.get(key)!.assembly?.root)) continue;
    motif.push(c);
    sequences.push(order);
    add(order[0], order[1]);
    if (variant === 'hub') {
      add(order[0], order[2]);
      // A deterministic visual sequence, even if the editor listed the right
      // side first. The last leg still mates to the hips, not the first leg.
      add(order[1], order[2], false);
    } else add(order[1], order[2]);
  }
  if (!motif.length) return null;
  const rewrite = (nodes: ANode[], scope: string): ANode[] => nodes.map(node => {
    const key = scope ? `${scope}/${node.itemId}` : node.itemId;
    if (node.kind === 'sub') return { ...node, children: rewrite(node.children, key) };
    const prerequisites = required.get(key) ?? [];
    const inMotif = motif.some(c => [c.first, c.hub, c.last].includes(key));
    if (!inMotif) return node;
    return { ...node, assembly: { ...node.assembly,
      // Minifigure AABBs do not describe where the hip pins enter. Avoid
      // inferred bottom-up support edges that require *both* legs first.
      ...(motif.some(c => c.kind === 'anatomy' && [c.first, c.hub, c.last].includes(key)) ? { root: true } : {}),
      after: [...new Set([...(node.assembly?.after ?? []), ...prerequisites.map(k => find.get(k)!.itemId)])],
    } };
  });
  const label = variant === 'hub' ? 'centre → sides' : 'first side → joint → opposite side';
  return { assembly: { ...asm, nodes: rewrite(asm.nodes, '') }, label, guides,
    chains: motif, sequences, preference: variant === 'hub' ? 1 : 0 };
}

/** Test both directions and hub-first; Standard alone is a fallback candidate. */
export function logicalAssemblyProposals(asm: Assembly, joints: MechanicalJoint[] = []): LogicalProposal[] {
  const chains = detectConnectionChains(asm, joints);
  if (!chains.length) return [];
  const possibilities = ['first', 'reverse', 'hub'] as const;
  const proposals = possibilities.map(variant => applyChains(asm, chains, variant))
    .filter((p): p is LogicalProposal => !!p);
  // Avoid identical/empty replan work when explicit overrides suppress a chain.
  const signatures = new Set<string>();
  return proposals.filter(p => {
    const sig = [...p.guides].sort().map(([k,v]) => `${k}:${v}`).join('|');
    if (signatures.has(sig)) return false;
    signatures.add(sig); return true;
  });
}
