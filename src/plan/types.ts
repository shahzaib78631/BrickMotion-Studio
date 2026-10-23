import type { Mat3, Vec3 } from '../ldraw/parse';

export type Rot = 0 | 90 | 180 | 270;
/** x, z in studs; y in plates (up is positive). Min corner of the rotated footprint, bottom of the piece. */
export type Grid = { x: number; y: number; z: number; rot: Rot };
/** Exact LDraw placement for imported pieces that are off the grid. */
export type Raw = { ldu: Vec3; matrix: Mat3 };

export type AssemblyRole = 'base' | 'hips' | 'leg' | 'torso' | 'arm' | 'hand' | 'head' | 'headwear' | 'neckwear' | 'generic';
/** References are sibling item IDs within the containing model, never part IDs. */
export type AssemblyHints = {
  attachTo?: string;
  after?: string[];
  /** Outward direction from the seated pose, in the containing model's frame. */
  insertionAxis?: Vec3;
  role?: AssemblyRole;
  /** Explicitly allow an independent/standalone foundation. */
  root?: boolean;
};

export type PieceItem = { assembly?: AssemblyHints; id?: string; part: string; color: string | number } & (Grid | Raw);
export type SubItem = { assembly?: AssemblyHints; id?: string; submodel: string } & (Grid | Raw);
export type PlanItem = PieceItem | SubItem;
/** A step's editorial metadata is optional, keeping older saved projects compatible. */
export type Step = {
  pieces: PlanItem[];
  title?: string;
  notes?: string;
  /** Extra seconds to hold on the completed step before the next action. */
  pauseAfter?: number;
  /** made by auto-steps (layers of a step-less file), not by the author: no editorial order inside it */
  auto?: boolean;
};
export type Submodel = { steps: Step[] };

export type Plan = {
  format: 'brickmotion-plan';
  version: 1;
  name: string;
  description?: string;
  submodels?: Record<string, Submodel>;
  /** custom part definitions embedded in imported files: file name (e.g. "custom.dat") → LDraw text */
  parts?: Record<string, string>;
  steps: Step[];
};

export const isSub = (i: PlanItem): i is SubItem => 'submodel' in i;
export const isGrid = <T extends PlanItem>(i: T): i is T & Grid => 'rot' in i;

export function emptyPlan(name = 'Untitled set'): Plan {
  return { format: 'brickmotion-plan', version: 1, name, steps: [] };
}
