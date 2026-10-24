import { assemblyRole } from '../assemblyGraph';
import { union } from './math';
import type { ConstructionNode, Connection, Dependency } from './types';

const owns = (node: ConstructionNode, id: string): boolean => node.id === id || node.leaves.includes(id) || !!node.children?.some(n => owns(n, id));
const leafRoles = (nodes: ConstructionNode[]): Map<string, ReturnType<typeof assemblyRole>> => {
    const out = new Map<string, ReturnType<typeof assemblyRole>>();
    const walk = (n: ConstructionNode) => {
        if (n.children?.length) n.children.forEach(walk);
        else out.set(n.id, n.hints?.role ?? assemblyRole(n.part));
    };
    nodes.forEach(walk);
    return out;
};
const makeGroup = (id: string, root: ConstructionNode, members: ConstructionNode[]): ConstructionNode => ({
    id,
    model: root.model,
    step: root.step,
    order: root.order,
    matrix: [...root.matrix],
    bounds: members.map(n => n.bounds).reduce(union),
    body: members.map(n => n.body).reduce(union),
    children: members,
    leaves: members.flatMap(n => n.leaves),
});

/** Hierarchical candidates from mechanical branches, never a blocked-part escape
 * hatch. Every member is still assembled individually at the group's work bay;
 * no member starts preassembled or disappears. Original leaf keys are retained.
 *
 * Minifigures are deliberately split into two construction modules:
 *   lower body: hips -> legs
 *   upper body: torso -> arms -> hands, then neck/head/headwear
 * The upper body is attached to the hips only after both modules are complete.
 * This prevents a hand from finishing at the figure before its arm exists and
 * avoids threading arms/legs through already-finished opposite body halves.
 */
export function mechanicalSubassemblies(nodes: ConstructionNode[], connections: Connection[], dependencies: Dependency[]): ConstructionNode[] {
    const nested = nodes.map(n => n.children ? { ...n, children: mechanicalSubassemblies(n.children, connections, dependencies) } : n);
    const roles = leafRoles(nested);

    // Phase 0: hard mechanical components are genuine preassemblies. A hard
    // mechanical dependency means the child is physically part of the parent
    // module (for example a trolley wheelset in its frame, or a wheelset in a
    // bogie), not merely touching it in the completed scene. Build such a module
    // at its work bay and move it rigidly afterward. Soft mechanical contacts
    // (hand grips, hinges, scene contact) are deliberately excluded.
    const hardMechanical = connections.filter(c => c.kind === 'mechanical' && dependencies.some(d => d.parent === c.parent && d.child === c.child && d.reason === 'mechanical'));
    const mechanicalAdj = new Map(nested.map(n => [n, new Set<ConstructionNode>()]));
    for (const c of hardMechanical) {
        const a = nested.find(n => owns(n, c.parent)), b = nested.find(n => owns(n, c.child));
        if (!a || !b || a === b) continue;
        mechanicalAdj.get(a)!.add(b); mechanicalAdj.get(b)!.add(a);
    }
    const consumedMechanical = new Set<ConstructionNode>(), mechanicalReplacement = new Map<ConstructionNode, ConstructionNode>();
    for (const seed of nested) {
        if (consumedMechanical.has(seed) || !(mechanicalAdj.get(seed)?.size)) continue;
        const component: ConstructionNode[] = [], queue = [seed], seen = new Set<ConstructionNode>();
        while (queue.length) {
            const n = queue.shift()!; if (seen.has(n)) continue; seen.add(n); component.push(n);
            for (const next of mechanicalAdj.get(n) ?? []) if (!seen.has(next)) queue.push(next);
        }
        if (component.length < 2) continue;
        const ids = new Set(component.flatMap(n => n.leaves));
        // Do not preassemble a module whose member has an external hard parent;
        // that would move a prerequisite inside the work bay before it exists.
        if (dependencies.some(d => ids.has(d.child) && !ids.has(d.parent))) continue;
        const root = component.find(n => !dependencies.some(d => ids.has(d.parent) && ids.has(d.child) && owns(n, d.child))) ?? component[0];
        let groupId = `$mechanical:${root.id}`;
        while (nested.some(n => n.id === groupId)) groupId += '$';
        mechanicalReplacement.set(root, makeGroup(groupId, root, component));
        component.forEach(n => { if (n !== root) consumedMechanical.add(n); });
    }
    const mechanical = nested.filter(n => !consumedMechanical.has(n)).map(n => mechanicalReplacement.get(n) ?? n);

    // Phase 0.5: head + headwear is a legitimate workbench subassembly. Hair,
    // hats and helmets are normally seated on the head before the head module is
    // lowered onto the neck. Keeping headwear as an independent flight inside an
    // already-populated upper-body scope can force it through backpacks/neckwear
    // that are correctly installed before the head. This group does not include
    // neckwear: torso -> neckwear -> completed head module remains the forward
    // order, while the headwear/head connection is still assembled visibly at
    // the module's own work bay.
    const consumedHeadwear = new Set<ConstructionNode>(), headReplacement = new Map<ConstructionNode, ConstructionNode>();
    for (const head of mechanical) {
        if (head.children || (head.hints?.role ?? assemblyRole(head.part)) !== 'head') continue;
        const hats = mechanical.filter(n => !n.children && (n.hints?.role ?? assemblyRole(n.part)) === 'headwear'
            && connections.some(c => c.parent === head.id && c.child === n.id && c.kind === 'anatomical'));
        if (!hats.length) continue;
        const members = [head, ...hats], ids = new Set(members.flatMap(n => n.leaves));
        // External prerequisites of the head (torso/neckwear) are intentionally
        // allowed: they govern when the finished head module may attach. An
        // external prerequisite on the headwear itself would make this isolated
        // workbench assembly invalid, so leave that case ungrouped.
        if (dependencies.some(d => hats.some(h => owns(h, d.child)) && !ids.has(d.parent))) continue;
        let groupId = `$head:${head.id}`;
        while (mechanical.some(n => n.id === groupId)) groupId += '$';
        headReplacement.set(head, makeGroup(groupId, head, members));
        hats.forEach(n => consumedHeadwear.add(n));
    }
    const withHeads = mechanical.filter(n => !consumedHeadwear.has(n)).map(n => headReplacement.get(n) ?? n);

    // Phase 1: lower-body groups. Arms are intentionally NOT grouped with hands;
    // the upper-body scope below lets dependency order produce torso -> arm -> hand.
    const consumedLower = new Set<string>(), lowerGroups = new Map<string, ConstructionNode>();
    for (const root of withHeads) {
        const rootRole = root.hints?.role ?? assemblyRole(root.part);
        if (root.children || rootRole !== 'hips') continue;
        const legs = withHeads.filter(n => !n.children && (n.hints?.role ?? assemblyRole(n.part)) === 'leg'
            && connections.some(c => c.parent === root.id && c.child === n.id && c.kind === 'anatomical'));
        if (!legs.length) continue;
        const members = [root, ...legs], ids = new Set(members.flatMap(n => n.leaves));
        if (dependencies.some(d => ids.has(d.child) && d.child !== root.id && !ids.has(d.parent))) continue;
        let groupId = `$lower:${root.id}`;
        while (nested.some(n => n.id === groupId)) groupId += '$';
        lowerGroups.set(root.id, makeGroup(groupId, root, members));
        legs.forEach(n => consumedLower.add(n.id));
    }
    const first = withHeads.filter(n => !consumedLower.has(n.id)).map(n => lowerGroups.get(n.id) ?? n);

    // Phase 2: upper-body connected components anchored at a torso. Generic
    // accessories (cups, tools, backpacks not explicitly classified as neckwear,
    // scenery) stay outside and are attached only after the body exists.
    // Hands also stay outside: their only withdrawal axis follows the posed
    // wrist, so a hanging hand would force the entire torso fixture off the
    // bench. The arm -> hand dependency already orders them after the torso in
    // forward construction, so they attach once the upper body is in place.
    const upperRoles = new Set(['torso', 'arm', 'head', 'headwear', 'neckwear']);
    const eligible = (n: ConstructionNode) => n.leaves.length > 0 && n.leaves.every(id => upperRoles.has(roles.get(id) ?? 'generic'));
    const upperNodes = first.filter(eligible), consumedUpper = new Set<ConstructionNode>(), replacements = new Map<ConstructionNode, ConstructionNode>();
    const adjacency = new Map(upperNodes.map(n => [n, new Set<ConstructionNode>()]));
    for (const c of connections) {
        if (c.kind !== 'anatomical' && c.kind !== 'support') continue;
        const a = upperNodes.find(n => owns(n, c.parent)), b = upperNodes.find(n => owns(n, c.child));
        if (!a || !b || a === b) continue;
        adjacency.get(a)!.add(b); adjacency.get(b)!.add(a);
    }
    for (const torsoNode of upperNodes) {
        if (consumedUpper.has(torsoNode) || !torsoNode.leaves.some(id => roles.get(id) === 'torso')) continue;
        const component: ConstructionNode[] = [], queue = [torsoNode], seen = new Set<ConstructionNode>();
        while (queue.length) {
            const n = queue.shift()!; if (seen.has(n)) continue; seen.add(n); component.push(n);
            for (const next of adjacency.get(n) ?? []) if (!seen.has(next)) queue.push(next);
        }
        if (component.length < 2) continue;
        const ids = new Set(component.flatMap(n => n.leaves));
        const torsoIds = new Set(torsoNode.leaves.filter(id => roles.get(id) === 'torso'));
        // An external prerequisite on a non-torso member means that member cannot
        // be safely moved into this isolated work scope. The torso's hips parent
        // is intentionally external: it is the later upper-to-lower attachment.
        if (dependencies.some(d => ids.has(d.child) && !torsoIds.has(d.child) && !ids.has(d.parent))) continue;
        let groupId = `$upper:${[...torsoIds][0] ?? torsoNode.id}`;
        while (first.some(n => n.id === groupId)) groupId += '$';
        const group = makeGroup(groupId, torsoNode, component);
        replacements.set(torsoNode, group);
        component.forEach(n => { if (n !== torsoNode) consumedUpper.add(n); });
    }
    return first.filter(n => !consumedUpper.has(n)).map(n => replacements.get(n) ?? n);
}
