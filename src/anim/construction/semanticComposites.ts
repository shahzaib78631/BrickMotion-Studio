/**
 * Treat a connected run of LDraw render segments as the ONE preformed flexible
 * component that it represents. A segment is a tessellation control point,
 * not a separately purchasable LEGO brick that can be inserted on its own.
 *
 * The recognition is conservative: classification uses part *descriptions*,
 * siblings must share one authored step, and adjacent pieces must meet locally
 * and have compatible tangents. Nothing else is grouped, and external contacts
 * are still checked using every triangle of every member during motion.
 */
import type { PartMetrics } from '../../ldraw/metrics';
import { dot, norm, pos, sub, union, unit, vector } from './math';
import type { V3 } from './math';
import type { ConstructionNode } from './types';

const semanticDescription = (part: string, m: PartMetrics): string =>
  m.description ?? (['755', '756'].includes(part.toLowerCase().replace(/\.dat$/, ''))
    ? 'Hose Flexible Segment Section' : '');

export function isFlexibleSegment(part: string, metrics: PartMetrics): boolean {
  const text = semanticDescription(part, metrics).toLowerCase();
  // Do NOT treat an entire flexible hose or a rigid bend as one of its render
  // segments. Only explicitly labelled *segments* qualify for aggregation.
  return /\b(flexible|flex|hose|pneumatic|cable|string)\b/.test(text) &&
    /\b(segment|section)\b/.test(text);
}

// Segment origins lie on the authored centreline. Mesh-box midpoints are
// unreliable for end sections, whose tapered outer geometry is asymmetric.
function anchor(n: ConstructionNode): V3 { return pos(n.matrix); }

function segmentTangent(n: ConstructionNode): V3 {
  // LDraw hose/cable segment authoring convention: local Y is the centreline.
  // Radius may exceed length, so choosing the longest AABB axis is wrong.
  return unit(vector(n.matrix, [0, 1, 0]));
}

export type CompositeResult = { nodes: ConstructionNode[]; groups: number; segments: number };
export function semanticComposites(nodes: ConstructionNode[], metrics: (part: string) => PartMetrics): CompositeResult {
  let groups = 0, segments = 0;
  const nested = nodes.map(n => {
    if (!n.children || n.atomic) return n;
    const child = semanticComposites(n.children, metrics);
    groups += child.groups; segments += child.segments;
    return { ...n, children: child.nodes };
  });
  const candidates = nested.map((n, index) => ({ n, index })).filter(({ n }) => !n.children?.length && !!n.part && isFlexibleSegment(n.part, metrics(n.part)));
  if (candidates.length < 3) return { nodes: nested, groups, segments };
  const parents = candidates.map((_, i) => i);
  const find = (i: number): number => parents[i] === i ? i : parents[i] = find(parents[i]);
  const connect = (i: number, j: number) => { const a = find(i), b = find(j); if (a !== b) parents[b] = a; };
  const locations = candidates.map(({ n }) => anchor(n));
  const tangents = candidates.map(({ n }) => segmentTangent(n));
  // Binning avoids O(N^2) across large models with hundreds of curved segments.
  const cellSize = 10;
  const hash = (p: V3) => p.map(v => Math.floor(v / cellSize)).join('|');
  const cells = new Map<string, number[]>();
  candidates.forEach(({ n }, i) => {
    const p = locations[i];
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      const key = hash([p[0] + dx * cellSize, p[1] + dy * cellSize, p[2] + dz * cellSize]);
      for (const j of cells.get(key) ?? []) {
        const other = candidates[j].n;
        if (other.step !== n.step || other.model !== n.model) continue;
        const distance = norm(sub(p, locations[j]));
        if (distance < 0.3 || distance > 8.5) continue;
        if (Math.abs(dot(tangents[i], tangents[j])) < 0.7) continue;
        // Nearby parallel segments at the same location can be distinct hoses.
        // Requiring displacement mostly along the tangent avoids fusing them.
        const along = Math.max(Math.abs(dot(unit(sub(p, locations[j])), tangents[i])),
                               Math.abs(dot(unit(sub(p, locations[j])), tangents[j])));
        if (along < 0.65) continue;
        connect(i, j);
      }
    }
    const key = hash(p);
    const list = cells.get(key) ?? [];
    list.push(i); cells.set(key, list);
  });
  const components = new Map<number, number[]>();
  candidates.forEach((_, i) => { const key = find(i); const list = components.get(key) ?? []; list.push(i); components.set(key, list); });
  const replacements = new Map<number, ConstructionNode>();
  const consumed = new Set<number>();
  const occupiedIds = new Set(nested.map(n => n.id));
  for (const component of components.values()) {
    if (component.length < 3) continue;
    const members = component.map(i => candidates[i].n).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    // Avoid aggregating isolated render shells that are merely near each other.
    // Consecutive original order is a strong signal of a tessellated curve.
    const ordered = [...members].sort((a, b) => a.order - b.order);
    if (!ordered.some((n, i) => i > 0 && n.order === ordered[i - 1].order + 1)) continue;
    const root = members[0];
    let id = `$composite:${root.id}`;
    while (occupiedIds.has(id)) id += '$';
    occupiedIds.add(id);
    const combined = members.map(n => n.bounds).reduce(union);
    const group: ConstructionNode = {
      id, model: root.model, step: root.step, order: root.order,
      matrix: [...root.matrix], bounds: combined,
      body: members.map(n => n.body).reduce(union),
      children: members, leaves: members.flatMap(n => n.leaves),
      atomic: 'preformed-flexible',
    };
    const first = Math.min(...component.map(i => candidates[i].index));
    replacements.set(first, group);
    component.forEach(i => consumed.add(candidates[i].index));
    groups++; segments += group.leaves.length;
  }
  if (!replacements.size) return { nodes: nested, groups, segments };
  return {
    nodes: nested.flatMap((n, i) => replacements.has(i) ? [replacements.get(i)!] : consumed.has(i) ? [] : [n]),
    groups, segments,
  };
}
