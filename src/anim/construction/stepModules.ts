/**
 * Build-step-local preassembly candidates inferred from *matched* LDCad
 * cylindrical mates. These are planning scopes, NOT prebuilt/hidden geometry:
 * every child is still animated and validated at the group's own work bay.
 * An authored STEP is required, and only connected components within that
 * exact step can be grouped. Disconnected or different-step parts never merge.
 * No graph edge here is a motion collision exception.
 */
import { union } from './math';
import type { Connection, ConstructionNode, Dependency } from './types';

const contains = (node: ConstructionNode, key: string): boolean => node.leaves.includes(key);
const fixedMate = (c: Connection) => c.id.startsWith('profiled:') &&
  c.kind === 'mechanical' && !!c.staticOnly && !!c.regions?.length && !!c.outward;

export type StepModuleResult = { nodes: ConstructionNode[]; modules: number; members: number };
/** Conservative cap: a full vehicle chassis is never auto-grouped as one step. */
export function authoredStepModules(
  nodes: readonly ConstructionNode[],
  connections: readonly Connection[],
  dependencies: readonly Dependency[],
  maxMembers = 8,
): StepModuleResult {
  let modules = 0, members = 0;
  const nested = nodes.map(node => {
    if (!node.children?.length || node.atomic) return node;
    const inside = authoredStepModules(node.children, connections, dependencies, maxMembers);
    modules += inside.modules; members += inside.members;
    return { ...node, children: inside.nodes, leaves: inside.nodes.flatMap(n => n.leaves) };
  });
  const eligible = nested.filter(n => !n.children?.length && !n.atomic && n.leaves.length === 1);
  const byId = new Map(eligible.map(n => [n.id,n]));
  const adjacency = new Map(eligible.map(n => [n.id,new Set<string>()]));
  for (const c of connections) {
    if (!fixedMate(c)) continue;
    const a = byId.get(c.parent), b = byId.get(c.child);
    if (!a || !b || a === b || a.step !== b.step || a.model !== b.model) continue;
    adjacency.get(a.id)!.add(b.id);
    adjacency.get(b.id)!.add(a.id);
  }
  const visited = new Set<string>();
  const replacements = new Map<string, ConstructionNode>();
  const consumed = new Set<string>();
  for (const start of eligible) {
    if (visited.has(start.id)) continue;
    const queue = [start.id], connected: ConstructionNode[] = [];
    while (queue.length) {
      const id=queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      connected.push(byId.get(id)!);
      for (const peer of adjacency.get(id) ?? []) if (!visited.has(peer)) queue.push(peer);
    }
    if (connected.length < 2 || connected.length > Math.max(2,Math.min(16,maxMembers))) continue;
    connected.sort((a,b)=>a.order-b.order || a.id.localeCompare(b.id));
    const ids = new Set(connected.map(n=>n.id));
    // External prerequisites of non-root children would force a workbench
    // operation to happen before its prerequisite. Don't create such a group.
    const root = connected.find(n => !dependencies.some(d => ids.has(d.parent) && d.child===n.id)) ?? connected[0];
    if (dependencies.some(d => ids.has(d.child) && !ids.has(d.parent) && d.child !== root.id)) continue;
    const groupId=`$step:${start.model}:${start.step}:${root.id}`;
    const group: ConstructionNode={
      id:groupId,model:root.model,step:root.step,order:root.order,
      matrix:[...root.matrix],bounds:connected.map(n=>n.bounds).reduce(union),
      body:connected.map(n=>n.body).reduce(union),children:connected,
      leaves:connected.flatMap(n=>n.leaves),
    };
    replacements.set(root.id,group);
    connected.forEach(n=>{ if(n!==root) consumed.add(n.id); });
    modules++; members += connected.length;
  }
  return {
    nodes:nested.filter(n=>!consumed.has(n.id)).map(n=>replacements.get(n.id)??n),
    modules,members,
  };
}
