import type { ANode } from '../../model/assemblyTypes';
import type { Plan, PlanItem } from '../../plan/types';
import type { PartMetrics } from '../../ldraw/metrics';
import { gridToPlacement, tidyPlacement } from '../../plan/placement';
import { identity, multiply, placement, transformBox, union, validMatrix, vector, bounds } from './math';
import type { M4 } from './math';
import { ConstructionError, type ConstructionModel, type ConstructionNode } from './types';
const EMPTY = { min: [0, 0, 0] as [
        number,
        number,
        number
    ], max: [0, 0, 0] as [
        number,
        number,
        number
    ] };
/** Shared by the application bridge and the CLI. Nested IDs always retain their scope. */
export function modelFromNodes(nodes: ANode[], metrics: (id: string) => PartMetrics): ConstructionModel {
    const parts = new Map<string, ConstructionNode>(), seen = new Set<string>();
    const validBox = (box: typeof EMPTY) => box && box.min.length === 3 && box.max.length === 3 && box.min.every((v, k) => Number.isFinite(v) && Number.isFinite(box.max[k]) && v <= box.max[k]);
    const visit = (list: ANode[], parent: M4, prefix: string): ConstructionNode[] => list.map(n => {
        const id = prefix ? `${prefix}/${n.itemId}` : n.itemId;
        if (typeof n.itemId !== 'string' || !n.itemId || seen.has(id) || id.startsWith('$mechanical:') || id === '$root')
            throw new ConstructionError('invalid-input', `Invalid, duplicate, or reserved node ID ${id}.`);
        seen.add(id);
        const matrix = multiply(parent, placement(n.local));
        if (!validMatrix(matrix))
            throw new ConstructionError('invalid-input', `Invalid placement for ${id}.`, { items: [id] });
        const children = n.kind === 'sub' ? visit(n.children, matrix, id) : undefined;
        const measured = n.kind === 'piece' ? metrics(n.part) : undefined;
        if (!validBox(n.body) || (measured && !validBox(measured.full)))
            throw new ConstructionError('invalid-input', `Invalid part bounds for ${id}.`);
        // Expand broad-phase bounds to include the actual supplied triangles; a stale
        // metrics envelope must never create a collision-checking blind spot.
        const b = measured?.mesh?.length ? union(measured.full, bounds(measured.mesh)) : measured?.full ?? n.body;
        const box = children?.length ? children.map(c => c.bounds).reduce(union) : transformBox(b, matrix);
        const node: ConstructionNode = { id, part: n.kind === 'piece' ? n.part : undefined, model: n.model, step: n.step, order: n.order, matrix, bounds: box, body: transformBox(n.body, matrix), hints: n.assembly ? { ...n.assembly, insertionAxis: n.assembly.insertionAxis ? vector(parent, n.assembly.insertionAxis) : undefined } : undefined, children, leaves: children ? children.flatMap(c => c.leaves) : [id] };
        if (n.kind === 'piece') {
            const m = metrics(n.part);
            if (m.placeholder || !m.mesh?.length || m.mesh.length % 9 || m.mesh.some(v => !Number.isFinite(v)))
                throw new ConstructionError('missing-geometry', `Missing or invalid collision mesh for ${id} (${n.part}).`, { items: [id] });
            if (parts.has(id))
                throw new ConstructionError('invalid-input', `Duplicate part key ${id}.`);
            parts.set(id, node);
        }
        return node;
    });
    const result = visit(nodes, identity(), '');
    return { nodes: result, parts, bounds: result.length ? result.map(n => n.bounds).reduce(union) : EMPTY, metrics };
}
/** CLI imports the same ANode representation consumed by modelFromNodes. No math adapter. */
export function modelFromPlan(plan: Plan, metrics: (id: string) => PartMetrics): ConstructionModel {
    const build = (steps: Plan['steps'], model: string, stack: string[]): ANode[] => steps.flatMap((step, si) => step.pieces.map((item: PlanItem, order) => {
        const itemId = item.id ?? `${model}:${si}:${order}`;
        const common = { itemId, model, step: si, order, pauseAfter: step.pauseAfter, assembly: item.assembly };
        if ('submodel' in item) {
            const name = item.submodel, definition = plan.submodels?.[name];
            if (!definition || stack.includes(name) || stack.length >= 16)
                throw new ConstructionError('invalid-input', `Missing, recursive, or excessively nested submodel ${name}.`);
            const children = build(definition.steps, name, [...stack, name]);
            const body = children.length ? children.map(c => transformBox(c.body, placement(c.local))).reduce(union) : EMPTY;
            const local = 'rot' in item ? gridToPlacement(item, body) : tidyPlacement({ pos: item.ldu, m: item.matrix });
            return { ...common, kind: 'sub' as const, submodel: name, children, body, local };
        }
        const m = metrics(item.part), local = 'rot' in item ? gridToPlacement(item, m.body) : tidyPlacement({ pos: item.ldu, m: item.matrix });
        return { ...common, kind: 'piece' as const, part: item.part, color: 16, placeholder: m.placeholder, grid: 'rot' in item, body: m.body, local };
    }));
    return modelFromNodes(build(plan.steps, '', []), metrics);
}
