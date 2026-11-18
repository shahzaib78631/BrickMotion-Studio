# Large-model planner: research, implementation and validation

## Why it was slow

The default planner repeatedly validates lift, cruise and insertion candidates
against installed pieces, staged pieces and overlapping flights. Each part has
1,500 area-distributed surface probes. Each probe can require multiple BVH ray
queries plus bounded recursive tangent-contact tests across triangle seams.
Candidate entries, lanes, delays and ordering retries multiply this work.

The diner profile attributed most remaining CPU time to `nearestHit`,
`segmentTouchesSurface` and triangle distance calculations. Making the viewport
idle efficiently fixes UI/GPU contention but does not remove that planning cost.

## Research and decision

[OMPL's motion-validator abstraction](https://ompl.kavrakilab.org/core/stateValidation.html)
separates the planner from expensive geometry validation. Its documentation also
explains why reducing validation resolution can miss collisions. We retained our
existing probe set, tolerances and conservative checks.

[Hauser's lazy collision-checking research](https://motion.cs.illinois.edu/papers/ICRA2015-Hauser-lazy-optimal.pdf)
shows the value of delaying unnecessary expensive checks. We apply that principle
inside the validator, rather than replacing the dependency/order planner with a
random roadmap: examine likely obstructions first, and require all remaining
checks before accepting a clear result.

[VAMP](https://github.com/KavrakiLab/vamp) demonstrates accelerated geometry kernels
for motion planning. Its robot models are not a replacement for our LDraw meshes.
We adopted the architectural separation, using a small **scalar f64 WebAssembly**
port of our own checker. This is not a VAMP port or a SIMD implementation.
[WebAssembly's design](https://webassembly.org/docs/faq/) fits the existing browser
worker and supports a JavaScript fallback without a separate native service.

Two prototypes were rejected after measurement: direct analytic triangle-tube
coverage was slower on recorded real queries; using the Construction triangle-SAT
oracle as a blanket replacement added substantial geometry-preparation cost.
Neither prototype is enabled or shipped as an alternative checking policy.

## Implemented

1. A 32-probe dispersed prefix followed by the remaining probes in original
   triangle order. Every original probe occurs exactly once; the sequential
   remainder retains BVH locality.
2. Rejection witnesses: previously obstructed probes are re-tested first at the
   current poses. A remembered witness never certifies a result. Clear results
   still require the complete relevant probe set.
3. Canonical identities for world-axis translation checks. Travel beyond the
   full geometry interaction interval retains a two-LDU empty-space margin and
   does not change the narrow-phase sweep. Direction, orientation, scale and
   relative placement stay in the key; diagonal paths are not clipped.
4. `kernel/collision.rs` batches a complete surface sweep in WebAssembly. The
   worker crosses the JS/Wasm boundary once per sweep rather than once per ray.
   The port retains f64 arithmetic, BFC flags, ray tie ordering, wall/contact
   thresholds and contact-search bounds. The kernel uses bounded stack storage
   without zeroing unused capacity on every query.
5. Job-scoped geometry storage is reset between worker requests and capped at
   256 MiB. Unsupported WebAssembly, load/CSP failures, memory limits or numeric
   overflow use the original JavaScript checker. Localized joint-contact policies
   also continue to use JavaScript. Strict Construction SAT verification remains
   its existing implementation; speedups are not a promise for every planner.

## Smoother motion

The default Smooth flight easing now uses the rest-to-rest minimum-jerk polynomial
`10t³ - 15t⁴ + 6t⁵`. This follows the point-to-point timing treatment in
[Flash and Hogan (1985)](https://graphics.cs.cmu.edu/nsp/course/15-464/Fall05/papers/flashHogan.pdf).
Unlike the old piecewise cubic curve, acceleration has no midpoint jump. Lift,
cruise and seating phases have zero velocity and acceleration at their joins.
This changes timing along the existing route, not its geometric corridor.

Playback and the v4 verifier share `flightClock`. The verifier finds waypoint
boundaries by inverting the actual monotone clock, including authored holds and
landing warps. Rotation padding uses the same easing. Cached plans are versioned
with planner version 11 so old timing is not replayed as a new certificate.
Authored Linear/Gentle/Soft choices and independently baked keyframes remain
under their existing interpolation rules. Arbitrary authored waypoint paths are
not claimed to be globally C2 or automatically rounded through obstacles.

## Measured evidence

Apple M1 Pro; local Node CPU profiles and Chrome worker tests. Background Python
jobs were active, so wall time varies; CPU time is included where available.

| Full diner, 2,599 parts | Wall time | CPU time |
| --- | ---: | ---: |
| Earlier implementation, previous cubic timing | 564.30 s | not recorded |
| JavaScript, new smooth timing | 863.52 s | 645.07 s |
| Compiled release candidate, same smooth timing | 289.33 s | 265.39 s |

The smooth JavaScript and compiled diner timelines have identical SHA-256:
`a79dea71d2139419c5abe64ea21ded73f22405ace5fd173db408c0aa299c50ef`.
Both retain 2,732 units, 2,599 tracks and the same 167 explicitly uncertified
units. Those units were not hidden or relabelled certified to improve speed.

The house's new-timing JS and compiled outputs likewise matched:
`730006a9e243020a29f6feeb66ff785ff505c68f848c652e758dda9054e6a3a0`.

A warmed, alternating-order replay of 36 recorded blocked sweeps used 344.71 ms
CPU with sequential probes versus 7.88 ms with lazy witness ordering, with zero
verdict differences. This is a blocked-query microbenchmark, not a project-wide
44× speedup claim.

Validation:

- 917 regression tests passed; three previously reproduced failures remained
  (one minifigure insertion expectation and two photo-scene lists).
- Focused tests compare compiled and JS verdicts/scores on boxes and holes with
  rotated, scaled, mirrored, tangent and diagonal/reverse cases; test invalid
  binaries and numeric-overflow fallback; and verify binary/source hashes.
- Cached/uncached full timelines agree in clear and overlapping fixtures.
- Probe permutation, witness changes, endpoint/acceleration continuity and exact
  authored endpoints are covered.
- Chrome's actual worker loaded the compiled backend and produced identical
  main-thread/worker timelines for normal and mirrored fixtures over successive
  jobs, exercising memory reset.

## Reproduce

The checked-in binary needs no Rust installation to run. Rebuild it after editing
Rust source with `rustup target add wasm32-unknown-unknown`, then
`npm run build:collision-kernel`. The manifest records source/binary SHA-256,
compiler and flags. Source/binary consistency is a regression test.

```
BENCH_BACKEND=js BENCH_OUT=.cache/plan-js node --import tsx scripts/benchmark-large-model.ts /path/model.io legacy
BENCH_BACKEND=wasm BENCH_OUT=.cache/plan-wasm node --import tsx scripts/benchmark-large-model.ts /path/model.io legacy
node scripts/verify-ao.cjs http://localhost:5173/planner-verify.html .cache/planner-worker.png 200 'aoBench.verify()'
```

Use `BENCH_SAVE=path.json` to save a complete encoded timeline for comparison.
Large certified plans remain computationally expensive; this implementation does
not promise instantaneous planning or eliminate unresolved imported geometry.
