/**
 * Bounded, time-aware broad-phase interference scoring for Standard Motion.
 * It checks completed parts, occupied staging spots and other flights at the
 * SAME time, rather than assuming every future part has disappeared. Swept
 * boxes catch fast straight-line crossings between the discrete samples.
 *
 * These are still conservative geometry hints: box overlaps are not mesh
 * penetrations, and sampled rotations/connector seats are not certified.
 */
import * as THREE from 'three';
import type { Box } from '../../ldraw/flatten';
import { transformBox, unionBox, type Assembly, type Metrics } from '../../model/assemble';
import { SpatialHash } from '../../model/spatialHash';
import { intersects, sweptIntersects } from '../sweptBounds';
import { flightPose, poseAt, type Move, type Timeline, type Track } from '../timeline';
import { interpolateJointSegment } from './jointKinematics';

const EPS = 1e-5;
const SKIN = 0.5;
const MAX_REPORTED_BLOCKERS = 6;
const MOTION_INDEX_SAMPLES = 10;

type IndexedPiece = {
  key: string;
  part: string;
  box: Box;
  installedAt: number;
  ctx: number;
  track?: Track;
  firstStart: number;
};
type ActiveFlight = { index: number; start: number; end: number; unit: number; envelope: Box };

export type RouteAssessment = {
  /** Sampled or swept broad-phase intersections; zero is not certification. */
  hits: number;
  blockers: string[];
  /** 0-1 normalized time along the flight at the first possible conflict. */
  firstHit?: number;
  /** False when a nested workbench move lacks meaningful final-world bounds. */
  assessed?: boolean;
};

/** Shared immutable indices for candidate scoring; built once per proposal. */
export class InstalledRouteIndex {
  private hash = new SpatialHash(64);
  private floorHash = new SpatialHash(64);
  // Flights span much more space than settled bricks; use larger cells to
  // bound memory on multi-thousand-part builds.
  private flightHash = new SpatialHash(160);
  private flights: ActiveFlight[] = [];
  private pieces: IndexedPiece[];
  private byKey = new Map<string, IndexedPiece>();
  private indexByKey = new Map<string, number>();
  private timeline: Timeline;
  private metrics?: Metrics;

  constructor(asm: Assembly, tl: Timeline, metrics?: Metrics) {
    this.timeline = tl;
    this.metrics = metrics;
    this.pieces = asm.instances.map((inst, index) => {
      const track = tl.tracks.get(inst.key);
      const first = track?.moves[0], last = track?.moves.at(-1);
      const firstUnit = first ? tl.units[first.unit] : undefined;
      const lastUnit = last ? tl.units[last.unit] : undefined;
      const piece: IndexedPiece = {
        key: inst.key, part: inst.part, track, ctx: track?.ctx ?? 0,
        // worldBox may omit studs and other full-mesh protrusions.
        box: metrics ? transformBox(metrics(inst.part).full, inst.world) : inst.worldBox,
        firstStart: firstUnit?.start ?? Infinity,
        installedAt: lastUnit ? lastUnit.start + lastUnit.dur : Infinity,
      };
      this.hash.insert(index, piece.box);
      if (firstUnit && track) this.floorHash.insert(index, track.floorBox);
      if (track && metrics) for (const move of track.moves)
        this.indexFlight(index, move, metrics(inst.part).full);

      return piece;
    });
    this.pieces.forEach((piece, index) => {
      this.byKey.set(piece.key, piece);
      this.indexByKey.set(piece.key, index);
    });
  }

  private indexFlight(index: number, move: Move, body: Box): void {
    const u = this.timeline.units[move.unit];
    if (!u || u.hidden || move.stationary || u.dur <= EPS) return;
    let envelope: Box | null = null;
    const pose = new THREE.Matrix4();
    for (let n = 0; n <= MOTION_INDEX_SAMPLES; n++)
      envelope = unionBox(envelope, transformBox(body, flightPose(move, n / MOTION_INDEX_SAMPLES, pose)));
    // Include exact interpolation corners, which a fixed time grid may miss.
    for (const waypoint of move.posePath ?? [])
      envelope = unionBox(envelope, transformBox(body, move.rel ? waypoint.clone().multiply(move.rel) : waypoint));
    // A hinge arc bows OUTSIDE the bounding boxes of its endpoint poses.
    // Keep intermediate world-rigid FK poses in the flight spatial index so
    // nearby moving pieces are discovered even along a thin, long arm.
    for (const segment of move.kinematicSegments ?? []) {
      const from = move.posePath?.[segment.index];
      if (!from) continue;
      for (const fraction of [0.25, 0.5, 0.75]) {
        const sample = new THREE.Matrix4();
        if (!interpolateJointSegment(from, segment, fraction, sample)) continue;
        envelope = unionBox(envelope, transformBox(body, move.rel ? sample.multiply(move.rel) : sample));
      }
    }
    // The unit envelope already includes the full shared rigid-body sweep.
    if (move.rigidDeltas?.length && u.box) envelope = unionBox(envelope, u.box);
    if (envelope) {
      this.flightHash.insert(this.flights.length, envelope);
      this.flights.push({ index, unit: move.unit, start: u.start, end: u.start + u.dur, envelope });
    }
  }

  /** Keep the broad phase current as an earlier part receives a new route.
   * Old envelopes can stay: extra conservative candidates are deduplicated. */
  noteUpdatedMove(key: string, move: Move): void {
    const index = this.indexByKey.get(key);
    if (index !== undefined && this.metrics) this.indexFlight(index, move, this.metrics(this.pieces[index].part).full);
  }

  /** Completed pieces which can obstruct this flight. Useful to size detours. */
  installedBoxes(start: number, excludeKey?: string): Box[] {
    return this.pieces.filter(p => p.key !== excludeKey && p.installedAt <= start + EPS).map(p => p.box);
  }

  /** Obstacles potentially present during a flight, for sizing adaptive detours.
   * Exact visibility and occupancy are checked again in assess(). */
  obstacleBoxes(start: number, end: number, excludeKey?: string): Box[] {
    const boxes: Box[] = [];
    for (const piece of this.pieces) {
      if (piece.key === excludeKey) continue;
      if (piece.installedAt <= end + EPS) boxes.push(piece.box);
      if (piece.track && piece.track.appear <= end + EPS && piece.firstStart >= start - EPS)
        boxes.push(piece.track.floorBox);
    }
    for (const f of this.flights) if (f.start <= end + EPS && f.end >= start - EPS &&
      this.pieces[f.index].key !== excludeKey) boxes.push(f.envelope);
    return boxes;
  }

  /** Actual stage / flight / settled occupancy, without a guessed final box. */
  private boxAt(piece: IndexedPiece, time: number, sample: ReturnType<typeof poseAt>): Box | null {
    const track = piece.track;
    if (!track || time < track.appear - EPS) return null;
    if (!track.moves.length) return piece.box;
    if (time < piece.firstStart - EPS) return track.floorBox;
    if (time >= piece.installedAt - EPS) return piece.box;
    const pose = sample(piece.key);
    return pose && this.metrics ? transformBox(this.metrics(piece.part).full, pose) : null;
  }

  /**
   * Score the whole flight, including its last three percent. A known mate may
   * interlock at its destination, but ignoring it for the WHOLE flight would
   * mistakenly accept a route which goes straight through the host.
   */
  assess(move: Move, key: string, part: string, start: number, metrics: Metrics,
    samples = 24, host?: string, ignoreHost = false): RouteAssessment {
    // Local workbench piece moves cannot be compared with final-world boxes;
    // attach operations can be checked because their poses are world-space.
    if (this.byKey.get(key)?.ctx !== 0 && this.timeline.units[move.unit]?.kind === 'piece')
      return { hits: 0, blockers: [], assessed: false };
    const body = metrics(part).full;
    const results = new Set<string>();
    let hits = 0, firstHit: number | undefined;
    // Evaluate every multi-phase route finely enough that a fast eased
    // segment cannot skip its own corner between adjacent score samples.
    const angularTravel = (move.kinematicSegments ?? []).reduce((sum, segment) =>
      sum + (segment.kind === 'revolute' && Number.isFinite(segment.travel) ? Math.abs(segment.travel) : 0), 0);
    const count = Math.max(12, Math.min(128, Math.max(Math.round(samples),
      3 * (move.posePath?.length ?? 0), Math.ceil(angularTravel * 65))));
    const dur = this.timeline.units[move.unit]?.dur ?? 1;
    const pose = new THREE.Matrix4();
    const goalBox = transformBox(body, move.to);
    const size = Math.max(...[0, 1, 2].map(k => goalBox.max[k] - goalBox.min[k]));
    let previous = transformBox(body, flightPose(move, 0, pose));
    for (let i = 1; i <= count; i++) {
      const u0 = (i - 1) / count, u1 = i / count;
      const current = transformBox(body, flightPose(move, u1, pose));
      const sweep = unionBox(previous, current);
      const time0 = start + u0 * dur, time1 = start + u1 * dur;
      const firstPose = poseAt(this.timeline, time0);
      const lastPose = poseAt(this.timeline, time1);
      const possible = new Set<number>(this.hash.query(sweep, SKIN));
      if (this.metrics) {
        for (const idx of this.floorHash.query(sweep, SKIN)) possible.add(idx);
        for (const id of this.flightHash.query(sweep, SKIN)) {
          const flight = this.flights[id];
          if (flight.start <= time1 + EPS && flight.end >= time0 - EPS && flight.unit !== move.unit)
            possible.add(flight.index);
        }
      }
      for (const index of possible) {
        const other = this.pieces[index];
        if (other.key === key) continue;
        // Do not treat parts of the same rigid/subassembly operation as walls.
        if (other.track?.moves.some(m => m.unit === move.unit)) continue;
        const b0 = this.boxAt(other, time0, firstPose);
        const b1 = this.boxAt(other, time1, lastPose);
        if (!b0 && !b1) continue;
        const before = b0 ?? b1!;
        const after = b1 ?? b0!;
        // Known connection volumes may legitimately interlock ONLY during
        // close-to-goal seating. Never waive an earlier transit through a host.
        if (ignoreHost && other.key === host && u1 > 0.65) {
          const nearGoal = [0, 1, 2].every(k =>
            current.min[k] <= goalBox.max[k] + size * 0.6 &&
            current.max[k] >= goalBox.min[k] - size * 0.6);
          if (nearGoal) continue;
        }
        if (!intersects(previous, before, SKIN) && !intersects(current, after, SKIN) &&
            !sweptIntersects(previous, current, before, after, SKIN)) continue;
        hits += other.key === host && u0 > 0.72 ? 1 : 3;
        if (firstHit === undefined) firstHit = u0;
        if (results.size < MAX_REPORTED_BLOCKERS) results.add(other.key);
      }
      previous = current;
    }
    return { hits, blockers: [...results], assessed: true,
      ...(firstHit === undefined ? {} : { firstHit }) };
  }
}
