/**
 * Scope-local immutable broad-phase for construction motions.
 *
 * It indexes *occupied* geometry, not staging work areas. The broad phase may
 * return false positives; it must NEVER eliminate an obstacle whose box can
 * intersect a continuous translation/turn. MeshOracle remains authoritative.
 * Rebuilt only after a successful removal, not for each route waypoint.
 */
import type { Box } from '../../ldraw/flatten';
import { centre, overlaps, sweptBox, union } from './math';
import type { M4, V3 } from './math';
import { stagedBounds } from './rigidStaging';
import type { ConstructionNode } from './types';

export type IndexedObstacle = {
  node: ConstructionNode;
  pose: M4;
  staged: boolean;
  box: Box;
};

type Branch = {
  box: Box;
  children?: [Branch, Branch];
  items?: IndexedObstacle[];
};

const boxUnion = (items: readonly IndexedObstacle[]): Box =>
  items.map(i => i.box).reduce(union);

function makeBranch(items: IndexedObstacle[]): Branch {
  const box = boxUnion(items);
  if (items.length <= 8) return { box, items };
  const extent = [0, 1, 2].map(k => box.max[k] - box.min[k]);
  const axis = extent.indexOf(Math.max(...extent));
  items.sort((a, b) => centre(a.box)[axis] - centre(b.box)[axis] || a.node.id.localeCompare(b.node.id));
  const half = Math.floor(items.length / 2);
  return { box, children: [makeBranch(items.slice(0, half)), makeBranch(items.slice(half))] };
}

export class ScopeSceneIndex {
  private readonly root: Branch | null;
  readonly size: number;
  constructor(remaining: readonly ConstructionNode[], staged: readonly {node: ConstructionNode; pose: M4}[], scopePose: M4) {
    const items: IndexedObstacle[] = [
      ...remaining.map(node => ({ node, pose: scopePose, staged: false, box: stagedBounds(node.bounds, scopePose) })),
      ...staged.map(({node, pose}) => ({ node, pose, staged: true, box: stagedBounds(node.bounds, pose) })),
    ];
    this.size = items.length;
    this.root = items.length ? makeBranch(items) : null;
  }

  /** Full continuous translation broad phase (slab interval test). */
  swept(start: Box, delta: V3, excludeId?: string): IndexedObstacle[] {
    if (!this.root) return [];
    const result: IndexedObstacle[] = [], stack = [this.root];
    while (stack.length) {
      const branch = stack.pop()!;
      if (!sweptBox(start, branch.box, delta, -1e-6)) continue;
      if (branch.items) {
        for (const item of branch.items) {
          if (item.node.id !== excludeId && sweptBox(start, item.box, delta, -1e-6)) result.push(item);
        }
      } else stack.push(...branch.children!);
    }
    // Stable ordering makes diagnostics and benchmarks reproducible.
    result.sort((a, b) => a.node.id.localeCompare(b.node.id));
    return result;
  }

  /** Conservative overlap test for the whole swept rotation sphere. */
  touching(box: Box, excludeId?: string): IndexedObstacle[] {
    if (!this.root) return [];
    const result: IndexedObstacle[] = [], stack = [this.root];
    while (stack.length) {
      const branch = stack.pop()!;
      if (!overlaps(box, branch.box)) continue;
      if (branch.items) {
        for (const item of branch.items)
          if (item.node.id !== excludeId && overlaps(box, item.box)) result.push(item);
      } else stack.push(...branch.children!);
    }
    result.sort((a, b) => a.node.id.localeCompare(b.node.id));
    return result;
  }
}
