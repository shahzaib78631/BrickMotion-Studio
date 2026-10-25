/**
 * Turns a Python-generated assembly artifact plus the studio's own assembly into
 * a certified `ConstructionPlan`. Every artifact piece is matched to its studio
 * instance by part name and world transform, so edits that moved the model are
 * rejected instead of mis-animated. Steps that were not fully certified by the
 * engine (stall-breaker commits) are rejected as well: the artifact planner is
 * certified-only.
 */
import { ConstructionError, type Connection, type ConstructionPlan, type Dependency, type Operation } from '../construction/types';
import { translated, type V3 } from '../construction/math';
import type { M4 } from '../construction/math';
import type { Box } from '../../ldraw/flatten';
import { unionBox, type Assembly, type Instance } from '../../model/assemble';
import type { AssemblyArtifact, ArtifactStep } from './artifact';

/** Tolerance for matching an artifact matrix to a studio instance. */
const POS_TOL = 0.06;
/** Rotation element tolerance (idle rounding is ≤0.005 for 2-decimal exports). */
const ROT_TOL = 0.02;

/** Matches the studio's `stripExt` part naming: no directories, no file extension. */
const normPart = (part: string) => (part.split(/[\\/]/).pop() ?? part).replace(/\.(dat|ldr|mpd)$/i, '');

const dist3 = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

type Match = { instance: Instance; pieceIndex: number };

/**
 * Maps artifact piece keys to studio instances. Candidates must use the same
 * (normalized) part and sit within `POS_TOL` of the artifact's world position;
 * among those the closest unused instance wins. Rotation differences are
 * verified afterwards, so a model edited between planning and playback fails
 * loudly instead of mis-animating an unverifiable path.
 */
function matchPieces(artifact: AssemblyArtifact, asm: Assembly): Map<string, Match> {
  const byPart = new Map<string, Instance[]>();
  for (const inst of asm.instances) {
    const name = normPart(inst.part);
    const list = byPart.get(name);
    if (list) list.push(inst);
    else byPart.set(name, [inst]);
  }
  const used = new Set<string>();
  const matches = new Map<string, Match>();
  const problems: string[] = [];
  artifact.pieces.forEach((piece, pieceIndex) => {
    let best: Instance | null = null;
    let bestDist = Infinity;
    for (const inst of byPart.get(normPart(piece.part)) ?? []) {
      if (used.has(inst.key)) continue;
      const d = dist3(piece.matrix.slice(12, 15), inst.world.elements.slice(12, 15));
      if (d < bestDist) {
        bestDist = d;
        best = inst;
      }
    }
    if (!best || bestDist > POS_TOL) {
      problems.push(`piece ${piece.key} (part ${piece.part}) has no matching piece at its predicted place`);
      return;
    }
    used.add(best.key);
    matches.set(piece.key, { instance: best, pieceIndex });
  });
  if (problems.length) {
    throw new ConstructionError('invalid-plan', `Assembly artifact does not match this model${problems.length > 3 ? ` (first ${Math.min(problems.length, 20)} shown)` : ''}. Hints: import the exact model the artifact was planned for, or re-plan it.`, { items: problems.slice(0, 20) });
  }
  for (const [key, { instance, pieceIndex }] of matches) {
    const matrix = artifact.pieces[pieceIndex].matrix;
    for (let i = 0; i < 12; i++) {
      if (i % 4 === 3) continue; // skip the translation column
      if (Math.abs(matrix[i] - instance.world.elements[i]) > ROT_TOL) {
        throw new ConstructionError('invalid-plan', `Assembly artifact piece ${key} has a rotated placement that differs from the model. Re-plan the artifact for this model.`);
      }
    }
  }
  return matches;
}

/**
 * Decodes steps into placements, in artifact order. The v1 contract plans one
 * piece per step, each fully certified; anything else is rejected explicitly.
 */
function placements(artifact: AssemblyArtifact): { key: string; offset: V3; step: ArtifactStep }[] {
  const seen = new Set<string>();
  const out: { key: string; offset: V3; step: ArtifactStep }[] = [];
  for (const step of artifact.steps) {
    if (step.pieces.length !== 1) {
      throw new ConstructionError('invalid-plan', `Assembly artifact step ${step.id} moves ${step.pieces.length} pieces; the v1 contract plans one piece per step.`);
    }
    const pieceKey = step.pieces[0];
    if (seen.has(pieceKey)) {
      throw new ConstructionError('invalid-plan', `Assembly artifact step ${step.id} places ${pieceKey} twice.`);
    }
    const ins = step.insertion;
    if (!ins) {
      throw new ConstructionError('invalid-plan', `Assembly artifact step ${step.id} has no insertion. Only fully planned steps can be animated.`);
    }
    const cert = step.certificate;
    if (!cert || !cert.clear || step.uncertified || step.reason) {
      throw new ConstructionError('invalid-plan', `Assembly artifact step ${step.id} (piece ${pieceKey}) is not fully certified${step.reason ? `: ${step.reason}` : '.'}`, { items: [pieceKey] });
    }
    const [ax, ay, az] = ins.axis;
    const len = Math.hypot(ax, ay, az);
    if (!Number.isFinite(len) || len < 1e-9) {
      throw new ConstructionError('invalid-plan', `Assembly artifact step ${step.id} has a degenerate insertion axis.`);
    }
    seen.add(pieceKey);
    out.push({
      key: pieceKey,
      // staged = final − distance · axis (the certified corridor start pose)
      offset: [-(ax / len) * ins.distance, -(ay / len) * ins.distance, -(az / len) * ins.distance],
      step,
    });
  }
  if (out.length !== artifact.pieces.length) {
    const missing = artifact.pieces.filter((p) => !seen.has(p.key)).map((p) => p.key);
    throw new ConstructionError('invalid-plan', `Assembly artifact has ${artifact.steps.length} steps for ${artifact.pieces.length} pieces; every piece needs exactly one placement step.`, { items: missing.slice(0, 20) });
  }
  return out;
}

type PartEntry = { key: string; part: string; final: M4; staged: M4; bounds: Box };

/** Staged poses are straight certified-corridor rays back to the final pose. */
const FINAL_OFFSET: V3 = [0, 0, 0];

export function assemblyArtifactPlan(artifact: AssemblyArtifact, asm: Assembly): ConstructionPlan {
  if (!asm.instances.length) {
    throw new ConstructionError('invalid-input', 'Assembly artifact planner needs a model with pieces.');
  }
  const matches = matchPieces(artifact, asm);
  const ordered = placements(artifact);

  const parts = new Map<string, PartEntry>();
  let bounds: Box | null = null;
  for (const placement of ordered) {
    const inst = matches.get(placement.key)!.instance;
    const final = Array.from(inst.world.elements) as M4;
    parts.set(inst.key, {
      key: inst.key,
      part: inst.part,
      final,
      staged: translated(final, placement.offset),
      bounds: inst.worldBox,
    });
    bounds = unionBox(bounds, inst.worldBox);
  }
  const planBounds: Box = bounds ?? { min: [0, -24, 0], max: [20, 0, 20] };

  const ops: Operation[] = [];
  let prevId: string | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const placement = ordered[i];
    const inst = matches.get(placement.key)!.instance;
    const model = artifact.pieces[matches.get(placement.key)!.pieceIndex].submodel ?? inst.model ?? '';
    const id = placement.step.id;
    ops.push({
      id,
      kind: 'place',
      keys: [inst.key],
      scope: model,
      model,
      step: i,
      requires: prevId ? [prevId] : [],
      connections: [],
      path: [placement.offset, FINAL_OFFSET],
      check: { method: 'continuous-triangle-sat', contactPolicies: ['assembly-plan-external-certification'], support: 'connected' },
    });
    prevId = id;
  }
  const connections: Connection[] = [];
  const dependencies: Dependency[] = [];

  return {
    schema: 'brickmotion-construction/v2',
    operations: ops,
    parts: [...parts.values()],
    connections,
    dependencies,
    warnings: [],
    stats: {
      states: 0,
      candidates: ordered.length,
      backtracks: 0,
      meshPairs: 0,
      trianglePairs: 0,
      cacheHits: 0,
      milliseconds: Number(artifact.stats?.ms) || 0,
    },
    ground: planBounds.max[1],
    bounds: planBounds,
    sceneBounds: grew(planBounds, 320),
    capabilities: {
      rigidTranslation: true,
      rigidRotation: false,
      hierarchicalSubassemblies: true,
      articulation: false,
      deformation: false,
      physicalStability: false,
    },
  };
}

/** One-stud margin (x/z) around the model keeps the automatic scene framing calm. */
const grew = (b: Box, pad: number): Box => ({
  min: [b.min[0] - pad, b.min[1], b.min[2] - pad],
  max: [b.max[0] + pad, b.max[1], b.max[2] + pad],
});
