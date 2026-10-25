/**
 * V4 rigid-cluster decomposition.
 *
 * The planner moves whole rigid clusters, not arbitrary leaf groups. A cluster
 * is one part, a measured tyre/rim pair, or one preformed flexible-hose run.
 * The hose rule intentionally ignores authored step/model boundaries: the four
 * 5590 runs are split across steps and submodels by the exporter but are one
 * physical part in the model.
 */
import { norm, pos, sub, union, vector, dot, unit } from '../../math';
import type { V3 } from '../../math';
import type { Box } from '../../../../ldraw/flatten';
import { mateAxis, worldSnaps } from '../../../snapMates';
import type { ConstructionModel, ConstructionNode } from '../../types';
import type { V4Cluster } from '../types';

const canonical = (part: string | undefined): string =>
    (part ?? '').toLowerCase().replace(/\.dat$/, '').split('/').pop() ?? '';
const HOSE = new Set(['752', '755', '756']);

type Raw = { node: ConstructionNode; part: string };

function unionBoxes(boxes: Box[]): Box {
    return boxes.reduce(union);
}

function makeCluster(id: number, key: string, name: string, members: Raw[], module: V4Cluster['module']): V4Cluster {
    const first = members[0].node;
    return {
        id,
        key,
        name,
        leaves: members.flatMap(m => [m.node.id]),
        parts: [...new Set(members.map(m => m.part))],
        model: first.model,
        step: Math.min(...members.map(m => m.node.step)),
        order: Math.min(...members.map(m => m.node.order)),
        bounds: unionBoxes(members.map(m => m.node.bounds)),
        body: unionBoxes(members.map(m => m.node.body)),
        module,
    };
}

function hoseComponents(parts: Raw[]): Raw[][] {
    const candidates = parts.filter(p => HOSE.has(canonical(p.part)));
    if (candidates.length < 3) return [];
    const parent = candidates.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const join = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[y] = x; };
    const centre = candidates.map(p => pos(p.node.matrix));
    const tangent = candidates.map(p => {
        const v = vector(p.node.matrix, [0, 1, 0]);
        return unit(v);
    });
    for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
        const d = norm(sub(centre[i], centre[j]));
        if (d < 0.2 || d > 12.5) continue;
        if (Math.abs(dot(tangent[i], tangent[j])) < 0.7) continue;
        const along = Math.abs(dot(unit(sub(centre[i], centre[j])), tangent[i]));
        if (along < 0.55) continue;
        join(i, j);
    }
    const groups = new Map<number, Raw[]>();
    candidates.forEach((p, i) => {
        const key = find(i);
        const list = groups.get(key) ?? [];
        list.push(p);
        groups.set(key, list);
    });
    return [...groups.values()].filter(g => g.length >= 3);
}

function wheelPairs(parts: Raw[], used: Set<string>, metrics: ConstructionModel['metrics']): Raw[][] {
    const candidates = parts.filter(p => !used.has(p.node.id));
    const tyre = candidates.filter(p => /tyre|tire/i.test(metrics(p.part).description ?? ''));
    const rim = candidates.filter(p => /rim/i.test(metrics(p.part).description ?? ''));
    const out: Raw[][] = [];
    const taken = new Set<string>();
    for (const t of tyre) {
        if (taken.has(t.node.id)) continue;
        const tSnaps = worldSnaps(metrics(t.part).snaps, t.node.matrix);
        let best: { rim: Raw; d: number } | undefined;
        for (const r of rim) {
            if (taken.has(r.node.id)) continue;
            const rSnaps = worldSnaps(metrics(r.part).snaps, r.node.matrix);
            if (!tSnaps.some(a => rSnaps.some(b => mateAxis(a, b)))) continue;
            const d = norm(sub(pos(t.node.matrix), pos(r.node.matrix)));
            if (d < 0.2 || d > 30) continue;
            if (!best || d < best.d) best = { rim: r, d };
        }
        if (!best) continue;
        taken.add(t.node.id); taken.add(best.rim.node.id);
        out.push([t, best.rim]);
    }
    return out;
}

export function decomposeClusters(model: ConstructionModel): { clusters: V4Cluster[]; leafToCluster: Map<string, number> } {
    const parts: Raw[] = [...model.parts.values()]
        .filter((n): n is ConstructionNode & { part: string } => !!n.part)
        .map(n => ({ node: n, part: n.part }));
    const used = new Set<string>();
    const groups: { name: string; module: V4Cluster['module']; members: Raw[]; key: string }[] = [];

    // Small authored submodel uses are genuine rigid modules (the 5590
    // underside assemblies, for example). A top-level 300–500 piece scope is
    // not: those stay granular so the animation still builds individual bricks.
    const subassembly = (node: ConstructionNode): void => {
        if (!node.children?.length) return;
        if (node.leaves.length >= 2 && node.leaves.length <= 40) {
            const members = node.leaves.map(id => model.parts.get(id)).filter((n): n is ConstructionNode & { part: string } => !!n?.part).map(n => ({ node: n, part: n.part }));
            if (members.length === node.leaves.length) {
                members.forEach(m => used.add(m.node.id));
                groups.push({ name: `Subassembly ${node.id}`, module: 'subassembly', members, key: `sub:${node.id}` });
                return;
            }
        }
        for (const child of node.children) subassembly(child);
    };
    for (const node of model.nodes) subassembly(node);

    for (const members of hoseComponents(parts.filter(p => !used.has(p.node.id)))) {
        members.forEach(m => used.add(m.node.id));
        const ordered = [...members].sort((a, b) => a.node.order - b.node.order || a.node.id.localeCompare(b.node.id));
        groups.push({ name: `Hose run ${ordered[0].node.id}`, module: 'hose', members: ordered, key: `hose:${ordered[0].node.id}` });
    }
    for (const members of wheelPairs(parts.filter(p => !used.has(p.node.id)), used, model.metrics)) {
        members.forEach(m => used.add(m.node.id));
        const ordered = [...members].sort((a, b) => a.node.id.localeCompare(b.node.id));
        groups.push({ name: `Wheel ${ordered[0].node.id}`, module: 'wheel', members: ordered, key: `wheel:${ordered[0].node.id}` });
    }

    const clusters: V4Cluster[] = [];
    const leafToCluster = new Map<string, number>();
    for (const group of groups) {
        const cluster = makeCluster(clusters.length, group.key, group.name, group.members, group.module);
        clusters.push(cluster);
        group.members.forEach(m => leafToCluster.set(m.node.id, cluster.id));
    }
    for (const part of parts) {
        if (used.has(part.node.id)) continue;
        const cluster = makeCluster(clusters.length, part.node.id, part.node.id, [part], 'part');
        clusters.push(cluster);
        leafToCluster.set(part.node.id, cluster.id);
    }
    return { clusters, leafToCluster };
}

