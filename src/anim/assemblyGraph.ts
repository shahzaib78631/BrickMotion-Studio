import { cupGripFits } from './jointContact';
import type { Box } from '../ldraw/flatten';
import type { AssemblyHints, AssemblyRole } from '../plan/types';
import { studFitsFace, type ConnectionGeometry } from '../ldraw/connectors';

/** This graph is independent of rendering, playback speed, and the frame rate. */
export type AssemblyItem = ConnectionGeometry & {
  id: string;
  /** Part-to-containing-model matrix, used only for recognised mechanical fits. */
  world?: readonly number[];
  box: Box;
  contactBox?: Box;
  part?: string;
  step: number;
  order: number;
  assembly?: AssemblyHints;
};
export type Dependency = { parent: string; child: string; reason: 'explicit' | 'attachment' | 'support' | 'contact' | 'stud' };
export type PlanningIssue = {
  code: 'duplicate-id' | 'missing-parent' | 'ambiguous-parent' | 'dependency-cycle' | 'invalid-axis' | 'blocked-route' | 'invalid-transform' | 'missing-geometry';
  items: string[];
  message: string;
  /** Structured route evidence for bounded access-order search. */
  access?: { moving: string; blockers: string[]; completed: number; total: number; peers?: string[]; harm?: Record<string, number>; needs?: string[] };
  search?: { attempts: number; limit: number; timedOut?: boolean; /** reorder that got furthest */ edges?: { before: string; after: string }[] };
};

export class AssemblyPlanningError extends Error {
  constructor(public readonly issues: PlanningIssue[]) {
    super(issues.map((issue) => `${issue.code}: ${issue.message}`).join('\n'));
    this.name = 'AssemblyPlanningError';
  }
}

/** Conservative built-in profiles. Custom parts can override these in the plan. */
export function assemblyRole(part = ''): AssemblyRole {
  const id = part.toLowerCase().replace(/\.dat$/, '').split('/').pop()!;
  if (/^3820(?:[a-z]|$)/.test(id)) return 'hand';
  if (/^(3818|3819)(?:[a-z]|$)/.test(id)) return 'arm';
  if (/^973(?:[a-z]|$)/.test(id)) return 'torso';
  if (/^3815(?:[a-z]|$)/.test(id)) return 'hips';
  if (/^(3816|3817)(?:[a-z]|$)/.test(id)) return 'leg';
  if (/^3626(?:[a-z]|$)/.test(id)) return 'head';
  if (/^(3624|3625|3629|3901|3902|4485|4530)(?:[a-z]|$)/.test(id)) return 'headwear';
  if (/^2524(?:[a-z]|$)/.test(id)) return 'neckwear';
  return 'generic';
}

const HOLDER: Partial<Record<AssemblyRole, AssemblyRole>> = {
  hand: 'arm', arm: 'torso', torso: 'hips', head: 'torso', headwear: 'head', neckwear: 'torso',
};
const overlaps = (a: Box, b: Box, k: number) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]);
const gapSquared = (a: Box, b: Box) => [0, 1, 2].reduce((d, k) => d + Math.max(0, -overlaps(a, b, k)) ** 2, 0);
const centreDistance = (a: Box, b: Box) => [0, 1, 2].reduce((d, k) => d + ((a.min[k] + a.max[k] - b.min[k] - b.max[k]) / 2) ** 2, 0);
const touches = (a: Box, b: Box) => [0, 1, 2].every((k) => overlaps(a, b, k) >= -0.5);

/**
 * Build one scoped graph for ALL steps of a model. Step order is a preference,
 * not permission to attach a child to an absent parent. References are sibling
 * item IDs, so repeated/nested submodels cannot accidentally share dependencies.
 * No dependency is silently broken to get out of a cycle.
 */
export function buildAssemblyGraph<T extends AssemblyItem>(items: T[], inferSupport = true): {
  ordered: T[];
  dependencies: Dependency[];
  parents: Map<string, string[]>;
} {
  const byId = new Map<string, T>();
  const problems: PlanningIssue[] = [];
  for (const item of items) {
    if (byId.has(item.id)) problems.push({ code: 'duplicate-id', items: [item.id], message: `Duplicate item ID "${item.id}" in one model.` });
    byId.set(item.id, item);
    const axis = item.assembly?.insertionAxis;
    if (axis && (axis.length !== 3 || axis.some((n) => !Number.isFinite(n)) || Math.hypot(...axis) < 1e-8))
      problems.push({ code: 'invalid-axis', items: [item.id], message: `"${item.id}" needs a finite, non-zero insertionAxis.` });
  }
  if (problems.length) throw new AssemblyPlanningError(problems);
  const role = (item: T) => item.assembly?.role ?? assemblyRole(item.part);
  const parents = new Map(items.map((item) => [item.id, [] as string[]]));
  const dependencies: Dependency[] = [];
  const add = (parent: string, child: string, reason: Dependency['reason']) => {
    if (!byId.has(parent)) {
      problems.push({ code: 'missing-parent', items: [child, parent], message: `"${child}" references missing sibling "${parent}". Use an item ID, not a part number.` });
      return;
    }
    if (parents.get(child)!.includes(parent)) return;
    parents.get(child)!.push(parent);
    dependencies.push({ parent, child, reason });
  };
  for (const item of items) {
    for (const parent of item.assembly?.after ?? []) add(parent, item.id, 'explicit');
    if (item.assembly?.attachTo) add(item.assembly.attachTo, item.id, 'explicit');
  }
  for (const item of items) {
    if (item.assembly?.root || item.assembly?.attachTo || items.length === 1) continue;
    const holder = HOLDER[role(item)];
    if (!holder) continue;
    const candidates = items.filter((other) => other !== item && role(other) === holder && gapSquared(item.contactBox ?? item.box, other.contactBox ?? other.box) <= 36)
      .map((other) => ({ other, distance: centreDistance(item.box, other.box) + 100 * gapSquared(item.box, other.box) }))
      .sort((a, b) => a.distance - b.distance || a.other.id.localeCompare(b.other.id));
    if (!candidates.length) {
      // A torso/head can intentionally be the foundation of a bust or a small
      // subassembly. A loose hand/arm cannot acquire an imaginary wrist/shoulder.
      if (role(item) === 'hand' || role(item) === 'arm') problems.push({
        code: 'missing-parent', items: [item.id],
        message: `No nearby ${holder} for ${role(item)} "${item.id}". Add its parent, set assembly.attachTo, or mark an intentional standalone root.`,
      });
      continue;
    }
    if (candidates[1] && Math.abs(candidates[0].distance - candidates[1].distance) < 1e-6) {
      problems.push({ code: 'ambiguous-parent', items: [item.id, ...candidates.slice(0, 2).map((c) => c.other.id)], message: `Two equally plausible parents for "${item.id}". Set assembly.attachTo explicitly.` });
      continue;
    }
    add(candidates[0].other.id, item.id, 'attachment');
  }
  if (problems.length) throw new AssemblyPlanningError(problems);

  // A cup cannot be fitted before the hand that holds its handle. This profile
  // uses the actual grip cylinder, not a shared bounding-box envelope.
  for (const cup of items) {
    if (!/^3899(?:\.dat)?$/i.test(cup.part ?? '') || !cup.world || cup.assembly?.root || cup.assembly?.attachTo) continue;
    const hands = items.filter((h) => role(h) === 'hand' && h.world && cupGripFits(cup.world!,h.world));
    if (hands.length === 1) add(hands[0].id,cup.id,'attachment');
  }

  // A single-axle bogie is lowered onto its wheelset. Inserting the wheels
  // from below after the bogie has reached the table is impossible at floor level.
  // Recognise the actual relative fit; do not reorder every wheel-shaped part.
  if (inferSupport) for (const bogie of items) {
    if (!/^2878(?:\.dat)?$/i.test(bogie.part ?? '') || !bogie.world || bogie.assembly?.root || bogie.assembly?.attachTo) continue;
    const b = bogie.world;
    const wheels = items.filter((wheel) => /^70720c01(?:\.dat)?$/i.test(wheel.part ?? '') && wheel.world &&
      [0,1,2,4,5,6,8,9,10].every((k) => Math.abs(wheel.world![k] - b[k]) < 1e-4) &&
      Math.hypot(...[0,1,2].map((k) => wheel.world![12 + k] - b[12 + k] - 32 * b[4 + k])) < 0.3);
    if (wheels.length === 1) add(wheels[0].id, bogie.id, 'attachment');
  }

  // Actual stud bases take precedence over outer-box height. A wheel carrier's
  // side walls can rise above its recessed stud deck; the chassis still belongs
  // AFTER that carrier, even when authored in an earlier editorial step.
  if (inferSupport) for (const child of items) {
    if (child.assembly?.root || child.assembly?.attachTo || !child.socketFace || role(child) !== 'generic') continue;
    for (const parent of items) {
      if (parent === child || !parent.studs?.length) continue;
      if (parent.studs.some((stud) => studFitsFace(stud, child.socketFace!))) add(parent.id, child.id, 'stud');
    }
  }

  if (inferSupport) for (const item of items) {
    if (item.assembly?.root || item.assembly?.attachTo || parents.get(item.id)!.length) continue;
    for (const other of items) {
      if (other === item) continue;
      // Side-mounted anatomy is attached to its parent, not a support for the
      // parent's torso just because its loose AABB extends farther down.
      if (['hand', 'arm', 'headwear'].includes(role(other))) continue;
      // Wheel envelopes are not flat load-bearing decks. Using a tyre's top
      // as support for the mudguard incorrectly pulls wheels ahead of chassis.
      if (/^(6014|6015)(?:\.dat)?$/i.test(other.part ?? '')) continue;
      const a = item.box, b = other.box;
      const seated = Math.abs(a.max[1] - b.min[1]) <= 5 &&
        (a.min[1] + a.max[1]) < (b.min[1] + b.max[1]) - 2 &&
        overlaps(a, b, 0) > 1 && overlaps(a, b, 2) > 1;
      if (seated) add(other.id, item.id, 'support');
    }
  }

  // A piece tucked up into another's hollow underside (plates clipped beneath a
  // train base, deeper than a plain stud) must be in place before that piece
  // closes over it: afterwards it can come neither from above nor from below
  // if something is already under it.
  if (inferSupport) for (const item of items) {
    if (item.assembly?.root || item.assembly?.attachTo) continue;
    for (const other of items) {
      if (other === item || other.assembly?.root) continue;
      if (['hand', 'arm', 'headwear'].includes(role(other)) || ['hand', 'arm', 'headwear'].includes(role(item))) continue;
      const a = item.box, b = other.box;
      const tucked = b.min[1] > a.min[1] + 1 && b.min[1] < a.max[1] - 5 && b.max[1] >= a.max[1] - 0.5 &&
        overlaps(a, b, 0) > 1 && overlaps(a, b, 2) > 1 &&
        // most of the lower piece's footprint lies under the upper one
        overlaps(a, b, 0) * overlaps(a, b, 2) >= 0.5 * (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
      if (tucked && !parents.get(other.id)!.includes(item.id)) add(other.id, item.id, 'support');
    }
  }

  const index = new Map(items.map((item, i) => [item.id, i]));
  const preferred = [...items].sort((a, b) => a.step - b.step || a.order - b.order || index.get(a.id)! - index.get(b.id)!);
  // Preserve editorial order by building prerequisites of the earliest item
  // first. A ready-only queue otherwise builds later enclosing parts while an
  // earlier chassis piece waits for a recessed carrier in a later step.
  const done = new Set<string>(), visiting = new Set<string>();
  const ordered: T[] = [];
  const priority = new Map(preferred.map((item, i) => [item.id, i]));
  // Iterative DFS avoids a call-stack overflow on long dependency chains.
  for (const root of preferred) {
    if (done.has(root.id)) continue;
    const stack: { item: T; parents: string[]; index: number }[] = [];
    const push = (item: T) => {
      visiting.add(item.id);
      stack.push({ item, parents: [...parents.get(item.id)!].sort((a, b) => priority.get(a)! - priority.get(b)!), index: 0 });
    };
    push(root);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index < frame.parents.length) {
        const id = frame.parents[frame.index++];
        if (done.has(id)) continue;
        if (visiting.has(id)) {
          const chain = stack.map((f) => f.item.id);
          const blocked = [...chain.slice(chain.indexOf(id)), id];
          throw new AssemblyPlanningError([{ code: 'dependency-cycle', items: blocked, message: `Cyclic assembly dependencies involving ${blocked.join(', ')}. Correct the parent/after references; no edge was discarded.` }]);
        }
        push(byId.get(id)!);
      } else {
        visiting.delete(frame.item.id); done.add(frame.item.id); ordered.push(frame.item); stack.pop();
      }
    }
  }
  // Contacting items must not race each other in batch mode. These edges follow
  // the already acyclic build order; face-only side contact does not serialize
  // an entire tiled layer. Explicit/root semantics remain authoritative.
  if (inferSupport) for (let i = 0; i < ordered.length; i++) {
    const child = ordered[i];
    if (child.assembly?.root) continue;
    for (let j = 0; j < i; j++) {
      const parent = ordered[j];
      if (!touches(child.box, parent.box)) continue;
      const depth = [0, 1, 2].map((k) => overlaps(child.box, parent.box, k));
      if (depth.every((d) => d > 1)) add(parent.id, child.id, 'contact');
    }
  }
  return { ordered, dependencies, parents };
}
