# Large models: planner and viewport performance

The two slowdowns have different causes. On the supplied diner (2,599 rendered
parts, 45 submodel definitions), solid drawing submitted about 45.6 million
triangles across beauty, transmission, depth/AO and shadow passes. Wire mode
avoids the solid passes. Separately, the planner spent most of its CPU time in
mesh ray queries, tangent contact checks, and repeated route envelopes.

## Changes

- Part render geometry now indexes **exactly identical** vertices across all
  attributes. Triangle order, winding, sharp normals, generated coordinates and
  part detail are retained. No decimation or material downgrade is used.
- Native shadow maps are cached by model structure/pose/root transform, material
  revisions, and light/target/frustum state. Camera-only orbit reuses them when
  the light rig is fixed. Camera-relative lights still invalidate as they move.
- The live editor redraws on camera, model, appearance, settings, store and input
  changes. Unchanged scenes retain a 250 ms heartbeat for async resources and
  external overlays. The update loop continues; progressive path tracing keeps
  sampling. This gate applies to the editor, not exports.
- Reapplying unchanged float32 instance matrices and highlight colours no longer
  uploads buffers, invalidates bounds, or dirties shadows. Selection has its own
  appearance revision, independent of shadow invalidation.
- Collision BVH queries traverse nearer nodes first and skip nodes outside the
  active ray interval. Explicit tie ordering preserves the original result at
  coincident intersections. Triangle coefficients are computed once in double
  precision per immutable mesh.
- Route interval envelopes and rotation bounds are calculated once per member
  and time interval, rather than once per blocking part. Non-rotating paths
  filter impossible blockers conservatively before narrow-phase checks.
- Mesh-check caches use full-precision part/relative-pose identities, allowing
  repeated translated part arrangements to reuse checks. World orientation,
  scale, insertion direction and holder policy remain in the key. Standard
  Motion shares these caches between proposals over the same immutable meshes.
- Assembly support/tuck inference uses a spatial broad phase with the full
  five-LDU support tolerance, then the original predicates and candidate order.
- Worker progress notifications are limited to roughly 10 Hz, with immediate
  phase/completion updates. Internal progress callbacks still run, preserving
  search-work accounting and budgets.

Collision samples, contact tolerances, certification rules and planner search
budgets have not been reduced. The planner output version is unchanged because
these changes are intended to preserve results.

## Evidence

Measured locally on an Apple M1 Pro with Chrome/ANGLE Metal. These are development
benchmarks, not a promise of a fixed frame rate or planning time on every machine.
CPU profiling adds overhead and concurrent verification can affect wall time.

| Check | Before/reference | After |
| --- | ---: | ---: |
| Diner, 960 × 600, solid orbit GPU frame | 94.47 ms | 40.71 ms |
| Same solid frame, triangles across passes | 45,553,645 | 34,235,402 |
| Actual editor, stationary diner, 3 seconds | 180 forced continuous draws | 8 draws |
| House, 828 parts, full legacy timeline | 125.79 s reference run | 36.48 s |

The house timeline SHA-256 was identical before/after:
`0d9c179cbf34472bcc6c5dc8134c05c942db0d2a49b50db31e0e61c89c9a5331`.
It retained all 880 units, 828 tracks, and 16 explicitly uncertified units.

The shadow regression rendered the real diner after moving its root. The moving
and forced-refresh frames made 1,443 draw calls; cached frames made 722. Cached
and forced-refresh pixels were identical (maximum byte error zero). The actual
editor also redrew immediately after a camera change.

The broad animation/render test run had 880 passing tests and three failures.
The minifigure insertion failure was reproduced after restoring the original
planner source; the other two are the previously identified photo-scene list
expectation failures. Focused tests cover float32 pose replay, appearance changes,
shadow invalidation, idle/progressive rendering, geometry preservation, distant
support candidates and bounded progress traffic.

## Reproduce

Keep model inputs local. Put the supplied files at `.cache/ao-bench/diner.io` and
`.cache/ao-bench/house.io`, or pass another path to the planner benchmark.

```
npm run dev
node scripts/verify-ao.cjs 'http://localhost:5173/ao-bench.html?model=/.cache/ao-bench/diner.io' .cache/performance/viewport.png 200 @scripts/bench/viewport.js
BENCH_APP=1 node scripts/verify-ao.cjs http://localhost:5173/ .cache/performance/editor.png 200 @scripts/bench/editor.js
node scripts/verify-ao.cjs 'http://localhost:5173/ao-bench.html?model=/.cache/ao-bench/diner.io' .cache/performance/shadow.png 200 @scripts/bench/shadow.js
BENCH_OUT=.cache/performance/planner node --import tsx scripts/benchmark-large-model.ts .cache/ao-bench/house.io legacy
```

The planner benchmark also accepts `standard-motion`, `standard-motion-v4`, or a
construction planner as its final argument. It writes timings and a CPU profile;
`BENCH_SAVE=path.json` additionally writes the encoded timeline for comparison.
The real-editor check uses a fresh temporary browser profile.

## Baseline before the compiled checker

Before the compiled checker, the completed full diner plan took 564.30 seconds (9.4 minutes), retaining
2,732 units, 2,599 tracks and 167 explicitly uncertified units. An earlier
intermediate implementation in this session took 770.69 seconds; that is not an
unmodified baseline. That run established the remaining collision bottleneck. See
[the subsequent planner research](planner-research.md) for the compiled checker
and smoother timing, including a later 289-second full diner run. The profile still
attributes most remaining time to mesh ray queries and bounded tangent-contact
certification. The viewport and UI improvements apply while that worker runs.
