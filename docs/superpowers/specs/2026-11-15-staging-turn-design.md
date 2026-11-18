# Staging turn — design

## Intent
Turn the whole area where the waiting (staged) pieces lie, as one, about the model, while
the model being built stays where it is. Used to compose the shot (e.g. pieces that lay in
front lie to the side, or face the camera). The user picked "spin around the model" over
"tilt the plane" and will judge it by eye.

## Goals / non-goals
- Goal: one angle per model that swings every waiting piece's floor spot about the model's
  footprint centre; flat on the floor, pieces keep facing the same way relative to the turn.
- Goal: instant — no re-plan; saved with the project; undo is one step per slider drag.
- Non-goal: tilting the staging plane (option 2, not chosen).
- Anti-goal: changing where or how a piece lands on its seat.

## Approaches
1. **Post-plan transform (chosen).** Like per-piece `floorTurn`/`floorShift`: applied to the
   planned timeline in `planTimeline`, before per-piece turns/drags and the main spot.
   Instant, no planner cache change, works for every planner.
2. Feed the angle to the floor-layout planner. Pieces could then be re-packed for the new
   angle, but every change re-plans (minutes on big sets).
3. Rotate via the main spot with "Loose pieces follow" off, then rotate the model back.
   Re-plans, and fights the existing spot semantics.

## Design
- Plan: `stagingTurns?: Record<model, degrees>` (schema: −180…180, finite). Excluded from the
  planning cache key, like `pauses`.
- `applyStagingTurn(tl, deg)`: R = yaw(deg) about the model box centre (x, z). For every
  track whose first move is a real flight: `floor`, `floorBox` and `moves[0].from` turn by R.
  Waypoint routes (`posePath`, `translationPath`, `rigidDeltas`) turn by R at the start,
  fading to no turn by the final approach (the `fadeWeights` the drag offset uses), so the
  certified insertion is unchanged. A `translationPath` becomes a `posePath` so the turn of
  the piece itself also fades (a translation path keeps the waiting orientation all the way).
  `sceneBox` grows to hold the turned floor.
- Order in `planTimeline`: motion style → staging turn → floor turns → floor drags → main
  spot → custom flights → …
- UI: Staging panel, "Turn" section: slider −180…180 (one undo step per drag via
  `beginGesture`/`endGesture`), number field, Reset.

## Left to the builder
Exact labels and styling; the tests' fixtures.
