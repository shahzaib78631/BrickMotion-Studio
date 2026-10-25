/**
 * Deterministic, bounded *advisory* route scoring for Standard Motion.
 * This checks only sampled AABB clearance against pieces already installed
 * when the flight begins. Final interlocking contacts, deformable elements,
 * mid-interval rotations and other simultaneously moving bodies are NOT mesh
 * collision certified; the route is always editable by the user.
 */
import * as THREE from 'three';
import type { Box } from '../../ldraw/flatten';
import { transformBox, type Assembly, type Metrics } from '../../model/assemble';
import { SpatialHash } from '../../model/spatialHash';
import { intersects, sweptIntersects } from '../sweptBounds';
import { flightPose, type Move, type Timeline } from '../timeline';

const EPS = 1e-5;
const SKIN = 0.5;
const MAX_REPORTED_BLOCKERS = 6;

export type RouteAssessment = {
  /** Sampled broad-phase intersections; a zero is not proof of clearance. */
  hits: number;
  blockers: string[];
  /** 0-1 normalized time along the flight at the first possible conflict. */
  firstHit?: number;
  /** False when a nested workbench move lacks meaningful final-world bounds. */
  assessed?: boolean;
};

/** Shared immutable world-space index for all candidate flights in a model. */
export class InstalledRouteIndex {
  private hash = new SpatialHash(64);
  private pieces: { key: string; box: Box; installedAt: number; ctx: number }[];
  private byKey = new Map<string, { key: string; box: Box; installedAt: number; ctx: number }>();
  private timeline: Timeline;

  constructor(asm: Assembly, tl: Timeline) {
    this.timeline = tl;
    this.pieces = asm.instances.map((inst, index) => {
      const track = tl.tracks.get(inst.key);
      const last = track?.moves.at(-1);
      const u = last ? tl.units[last.unit] : undefined;
      // No track or incomplete move = no reliably installed destination.
      const installedAt = u ? u.start + u.dur : Infinity;
      this.hash.insert(index, inst.worldBox);
      return { key: inst.key, box: inst.worldBox, installedAt, ctx: track?.ctx ?? 0 };
    });
    for (const piece of this.pieces) this.byKey.set(piece.key, piece);
  }

  /**
   * Bounds are based on the moving shape (not only its centre). Do not count
   * the intended final connection as a route obstacle in the last few frames;
   * its deliberately interlocking AABBs usually overlap.
   */
  assess(move: Move, key: string, part: string, start: number, metrics: Metrics,
    samples = 24, host?: string, ignoreHost = false): RouteAssessment {
    // Inside a workbench submodel, the authored final-world boxes are NOT
    // current obstacle positions. Do not score those motions against a false
    // global occupancy map. The final attach operation *can* be reviewed.
    if (this.byKey.get(key)?.ctx !== 0 && this.timeline.units[move.unit]?.kind === 'piece')
      return { hits: 0, blockers: [], assessed: false };
    const body = metrics(part).full;
    const results = new Set<string>();
    let hits = 0, firstHit: number | undefined;
    const count = Math.max(8, Math.min(48, Math.round(samples)));
    let previous: Box | undefined;
    let previousU = 0;
    const pose = new THREE.Matrix4();
    for (let i = 0; i <= count; i++) {
      const u = i / count;
      const current = transformBox(body, flightPose(move, u, pose));
      // Only score collisions during the approach. Seated studs, clips and
      // pins will often have overlapping loose bounding boxes at completion.
      if (i && u >= 0.97) break;
      const sweep: Box = previous ? {
        min: [0, 1, 2].map(k => Math.min(previous!.min[k], current.min[k])) as Box['min'],
        max: [0, 1, 2].map(k => Math.max(previous!.max[k], current.max[k])) as Box['max'],
      } : current;
      for (const index of this.hash.query(sweep, SKIN)) {
        const other = this.pieces[index];
        if (other.key === key || other.installedAt > start + EPS) continue;
        // An informed approach must overlap its mating part while the pin or
        // axle seats. Score only obstacles that are not the intended mate.
        if (ignoreHost && other.key === host) continue;
        // A mate may overlap while seating in the final stages, even if the
        // assembly is physically possible. Preserve the warning for large
        // earlier interference; relax only the end contact itself.
        if (other.key === host && u >= 0.86) continue;
        const hit = intersects(current, other.box, SKIN) ||
          (!!previous && sweptIntersects(previous, current, other.box, other.box, SKIN));
        if (!hit) continue;
        // A legitimate final connection needs a collision mesh to resolve.
        // Reduce its weight rather than claiming this sampled box is exact.
        hits += other.key === host && previousU > 0.72 ? 1 : 3;
        if (firstHit === undefined) firstHit = Math.max(0, previousU);
        if (results.size < MAX_REPORTED_BLOCKERS) results.add(other.key);
      }
      previous = current;
      previousU = u;
    }
    return { hits, blockers: [...results], assessed: true,
      ...(firstHit === undefined ? {} : { firstHit }) };
  }
}
