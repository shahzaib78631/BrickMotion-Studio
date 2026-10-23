# What we took from brickmotion-assembler

Date: 2026-10-24

`brickmotion-assembler` v0.3.0 and v0.4.0 are an outside prototype of a
constraint-based assembly planner (zips in `~/Downloads`). We read them and did
not add them as a dependency. Most of the prototype duplicates what BrickMotion
already has, at lower accuracy:

| Prototype | BrickMotion today |
|---|---|
| Connection graph from connector tables | `src/anim/snapMates.ts` with the full LDCad shadow pack (about 75 % of parts) |
| Hand-written connectors for 2711, 3749, 3700, 4599, 3959, 4081a, 2456… | Not copied. These are the exact parts that failed in 5590 and 10156, so the "zero override" results are the old overrides moved into part tables. |
| Swept bounding boxes for insertion | Mesh-based insertion and flight checks (`verifiedInsertion`, `routeHitsResting`) |
| Supports placed before what they hold | Bottom-up ordering and attachment dependencies |
| v0.4: coarse insertion check made advisory, since it caused false deadlocks | Our checks are exact. The look-ahead below is used only to rank options, never to reject a route. |

Three ideas were worth porting.

## 1. Look-ahead in the access-order search

`src/anim/accessOrder.ts`, `src/anim/timeline.ts`

When a piece has no clear route, the legacy planner retries with "this piece
goes before the piece blocking it" and plans again. The prototype's beam search
penalises a placement that closes the way in of a piece not placed yet. Ours now
does the same, at the point where it fails:

- **Holder rule.** A piece is never reordered before something it is attached
  to or rests on (`needs`). Such a retry only moves the failure to the holder.
  On the jet, the first failure (unit 16) is blocked only by pieces that hold
  it. The old search spent its whole work budget on a backwards reorder there;
  it now stops at once.
- **Harm ranking.** For every other blocker, the planner counts how many flights
  already certified the moving piece would cut through, if it went first
  (`harm`). It samples them along their real paths with `flightPose`. Retries
  that cut fewer flights are tried first. The weight is below one unit of
  progress, so harm only ranks retries of the same failure.

## 2. Repair pass

`repairUncertified` in `src/anim/timeline.ts`

The search stops at the first failure it cannot fix, so later failures that a
reorder could fix were never tried. The prototype's repair mode keeps going past
a piece it cannot place. Ours now does the same in the last pass:

- The last pass plans everything and records what blocked each uncertified piece.
- Then every useful reorder is applied at once: blockers the piece is not held
  by, which cut no certified flight.
- The build is planned again, at most `REPAIR_ROUNDS` (2) times.
- A result is kept only if fewer pieces stay uncertified.
- If reorders contradict how pieces hold each other, the reorders named in the
  cycle are dropped and the pass retries.

**Off by default.** Set `accessRepair: true` in the animation options to turn
it on. On every model measured, the stuck pieces were blocked only by the pieces
holding them, so there was nothing for the pass to fix. On the jet it tried 22
reorders and freed nothing, at the cost of one more full plan.

## 3. Branches built aside

`bridgeBranches` in `src/plan/components.ts`

For a step-less import, the component split built undersides and roofs aside,
and only when the model has a large carrier piece. It now also finds
**branches**: groups that touch the rest of the model at exactly one contact (a
bridge of the contact graph), such as an arm, a hook or a lamp. Each is built
aside as `<model> - branch N` and attached across that contact. The rules:

- A branch has 3–40 items and at most a quarter of the model.
- It is always the side away from the model's largest piece.
- Branches never overlap, and the biggest is taken first.
- This works with or without a carrier.

## Results

Legacy planner, real library and shadow pack, default search budget. Each count
is uncertified units out of all units, with pieces in brackets.

| Model | Before | Holder rule + harm | + branches | + repair pass |
|---|---|---|---|---|
| 31039 jet (stepped) | 27 / 619 (85) | 27 / 619 (85) | — (has steps) | 27 / 619 (85), 22 reorders tried |
| 5590 truck (step-less import) | 290 / 1247 | 290 / 1247 ¹ | 290 / 1249, 2 branches | 290, no usable reorder |
| 10001 train (step-less import) | 29 / 866 (47) | 28 / 866 (46) | 28 / 869 (46), 3 branches | 28, no usable reorder |

¹ measured before the holder rule, with harm ranking only.

What the numbers say:

- **The holder rule is the useful part.** It never gives a worse result and it
  saves work. On the jet, the search used to spend two full re-plans on a
  backwards reorder; now it makes one attempt. On the train it freed one unit
  and cut planner work from 7,379 to 6,682 progress reports.
- **Reordering cannot fix most stuck pieces.** On all three models, nearly every
  uncertified piece is blocked by the piece it goes into: a pin into its brick,
  a rim onto its axle. That matches cause A1 in `uncertified-routes.md`. The
  lever there is the insertion corridor around the mate, not the build order.
- **Branches make no difference to route quality** on these models. They change
  how a step-less import is grouped: an arm is built aside, then attached.

Reproduce with `tests/diagnostics/bench.test.ts`, which is skipped unless
`BENCH_MODEL` is set:

```sh
STEPLESS=1 BENCH_MODEL=~/Desktop/10001-1.mpd npx vitest run tests/diagnostics/bench.test.ts --silent=false
```

## Not ported

- Hand-written connector tables (`autoMetadata.ts`): they overfit the test sets.
- Swept-AABB insertion checks: coarser than the mesh checks we already run.
- Support scoring for picking the next piece: BrickMotion follows the author's
  step order, plus bottom-up ordering, instead of re-sequencing the whole build.
