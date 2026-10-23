/** Structural import tree shared by the renderer and the numeric planner.
 * This module intentionally has no Three.js or browser dependency. */
import type { Box } from '../ldraw/flatten';
import type { Placement } from '../plan/placement';
import type { AssemblyHints } from '../plan/types';
type NodeBase = {
    assembly?: AssemblyHints;
    itemId: string;
    model: string;
    step: number;
    order: number;
    pauseAfter?: number;
    /** its step was generated (auto-steps), so its order inside the step is not editorial */
    autoStep?: boolean;
    local: Placement;
};
export type ANode = (NodeBase & {
    kind: 'piece';
    part: string;
    color: number;
    placeholder: boolean;
    body: Box;
    grid: boolean;
}) | (NodeBase & {
    kind: 'sub';
    submodel: string;
    children: ANode[];
    body: Box;
});
