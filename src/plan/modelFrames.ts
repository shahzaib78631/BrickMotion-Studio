/** Where each model sits in the main model's space.
 *
 * A submodel has no stored frame (`src/plan/types.ts:46`): it is written in its own
 * local space and placed by every `SubItem` that uses it. The assembled tree is the
 * only place where the resolved use transforms exist — a grid use needs the
 * submodel's body box to become a matrix (`gridToPlacement`), which only `assemble`
 * has. Moving parts between models therefore reads its frames from there.
 */
import type { Assembly } from '../model/assemble';
import type { ANode } from '../model/assemblyTypes';
import { composePlacement, type Placement } from './placement';

export type ModelFrame = {
  /** that model's local space → the main model's space */
  placement: Placement;
  /** how many uses place this model; more than one makes the frame a choice */
  uses: number;
};

const IDENTITY: Placement = { pos: [0, 0, 0], m: [1, 0, 0, 0, 1, 0, 0, 0, 1] };

/** Frames for every model reachable from the main model. An unused submodel is absent. */
export function modelFrames(assembly: Assembly): Map<string, ModelFrame> {
  const frames = new Map<string, ModelFrame>([['', { placement: IDENTITY, uses: 1 }]]);
  const walk = (nodes: ANode[], parent: Placement) => {
    for (const node of nodes) {
      if (node.kind !== 'sub') continue;
      const frame = composePlacement(parent, node.local);
      const known = frames.get(node.submodel);
      // Keep the first use in build order: a shared definition has one frame only
      // if it is placed once, and `uses` tells callers when it is a choice.
      if (known) known.uses += 1;
      else frames.set(node.submodel, { placement: frame, uses: 1 });
      walk(node.children, frame);
    }
  };
  walk(assembly.nodes, IDENTITY);
  return frames;
}

/** The top-level nodes of one model, as assembled. Empty when it is not placed. */
export function modelNodes(assembly: Assembly, model: string): ANode[] {
  if (!model) return assembly.nodes;
  const search = (nodes: ANode[]): ANode[] | null => {
    for (const node of nodes) {
      if (node.kind !== 'sub') continue;
      if (node.submodel === model) return node.children;
      const deeper = search(node.children);
      if (deeper) return deeper;
    }
    return null;
  };
  return search(assembly.nodes) ?? [];
}
