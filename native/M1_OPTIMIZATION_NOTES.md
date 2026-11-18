# BrickMotion M1 optimization pass — 18 November 2026

This is an incremental pass **on top of** `BrickMotion-reaudited-optimized.zip`. It preserves the previous rotation fix, collision index, convergent shape trim, and connector-copy avoidance. It is not an end-to-end benchmark of the application on macOS.

## Input models examined

Piece counts follow the engine's MPD submodel expansion rule (`.dat` references are placed pieces, even if defined inline in MPD). The `.io` counts come from `model.ldr` decrypted/read from the ZIP. Figures do not require an installed LDraw library.

| Uploaded model | Expanded piece refs | Unique referenced part names | Model-specific detail |
|---|---:|---:|---|
| 9093-1.mpd | 82 | 40 | Small, three one-level submodels |
| 76897-1.mpd | 262 | 85 | 12 inline custom `.dat` definitions; embedded subparts |
| MOC-272851_TheDeeGee_Simtek_S941.io | 789 | 182 | Studio archive with 120 custom `.dat` entries; 28 names directly referenced (46 type-1 references) |
| 5590_-_whirl_n_wheel_super_truck.mpd | 1,258 | 133 | Large standard-MPD assembly, three one-level submodels |
| Ma Odele's.io | 2,119 | 210 | Studio archive with 23 custom `.dat` entries; eight directly referenced |

### Critical collision fidelity warning about Studio `.io`

The current `readStudioIo()` chooses `model.ldr` from the ZIP and does **not** import `CustomParts/*.dat` or its custom collider/connectivity data into the `ldraw::Library`. Both supplied `.io` archives do contain custom part geometry. Unless their names happen to exist in the installed library, those pieces have missing/placeholder geometry. As a result, collision/plan benchmarks on these two models are not yet full-fidelity and may be artificially fast or inaccurate. This pass deliberately does not silently synthesize geometry or claim such results. Support for embedded custom-part data should be treated as a separate correctness feature with safety limits and tests.

## Source changes

1. **`core/src/model/model.cpp`, `core/include/bm/model.h`: model-scoped inline-mesh cache.** The same inline custom part was flattened again each time an independent `World`, kinematics contact system, or certifier requested it. Each new mesh pointer also bypassed the identity-keyed `ShapeCache`, rebuilding collision shapes. Cache by normalized part name inside a copied/moved `Model`; use a mutex only for entry lookup and `std::call_once` for work, so different inline parts can be built in parallel. Global library `PartCache` behaviour is unchanged.
2. **`core/src/collide/world.cpp`: single-pass support-probe collection.** Compute the same 14 extremal inner-surface points with one traversal of surviving triangles, then deduplicate in the original direction order. The original independent 14 scans repeatedly checked triangle validity and reread vertices. This is a world-construction optimization, not a narrowing of collision tolerance.
3. **`core/src/plan/sequence.cpp` plus `core/src/plan/blocker_index.h`: reverse blocker dependency.** On removal, the old sequencer scanned `set` and all failed attempts' `stoppedBy` vectors. Instead, record which failed candidate is blocked by each part and directly mark affected candidates when that part is removed. Generations invalidate stale records after retries, with occasional compaction. Only a serial post-parallel extraction pass mutates the index; parallel extractions remain independent. If a mate changes, the existing dirty/retry logic is unchanged.
4. Tests and M1 profiler helpers added to `tests/model_test.cpp` and `tools/perf/`.

## Measurements obtained here — **Linux x86_64, synthetic/partial**

No numbers below are measured on the user's M1. The available fixture LDraw library has only a small selection of primitives. The 76897 test includes all 12 inline `.dat` definitions, but **139 missing subfile dependencies** were reported in this limited setup, so the absolute times are not production timings. Each comparison used the same fixture and produced the same geometry fingerprint in original versus optimized builds.

| Isolated benchmark | Pre-pass | New pass | Notes |
|---|---:|---:|---|
| 80 repeated `Model::mesh()` passes over 12 inline definitions from 76897 | 31.4 ms | 0.059 ms | Same hash 16765337500342735748; original recreated meshes, new version reuses pointers; `-O3` |
| 12 repeated `World` creations for the 12 inline parts from 76897 | 32.1 ms | 0.90 ms | Same shape/near-query fingerprint 6432129197703744408, 1,714 triangles across partial geometry; `-O2` |
| 2,119 synthetic removals, four prior blockers per piece: dependency invalidation only | 5.9 ms | 0.06 ms | Algorithmic microbenchmark, **not** 98x faster plans |
| 300 repeated world-builds for a 4,096-triangle synthetic external part | 64.4 ms | 57.7 ms | Probe-generation change with shape cache already warm; benefit is workload-dependent |

### Validation

- `model.cpp`, `world.cpp`, and `sequence.cpp` compiled as portable C++20 with `-Wall -Wextra -Werror`.
- Model geometry hashes and collision world fingerprints above exactly match, despite different mesh cache identity/lifetime.
- `BlockerIndex` passed 25,000 randomized update/removal equivalence events against the original full-scan condition. The synthetic 2,119-piece benchmark also checked identical dirty flags.
- Original and optimized standalone planner programs produced **byte-identical deterministic move/flag/blocker/path output** for 12-, 24-, and 30-piece synthetic connected fixtures (1-thread pool, no plan budget).
- `tests/model_test.cpp` gained a Catch2 regression verifying cache pointer reuse, normalized names, model-copy reuse, and nonempty geometry. This Catch2 case was **not run** because the complete dependency/build environment is absent here.
- The full Apple Metal UI, complete LDraw library, native `bm` CLI with all dependencies, Mac M1 CPU/GPU profiling, `.io` embedded custom geometries, full OMR corpus and complete tests were **not** validated in this Linux environment.

## What to run on the user's M1

1. Place the optimized project in the usual repository as `native/`, or apply the incremental patch to the **previous optimized** project (not the original archive).
2. Build the Release native engine on the Mac, then run `ctest --test-dir native/build --output-on-failure`.
3. Set `BM_LDRAW_DIR` to the installed complete LDraw library; retain Studio and shadow-library paths if used for the original runs. Keep the same libraries and cache state for before/after comparisons.
4. Run `bash native/tools/perf/m1_profile.sh native/build/tools/bm/bm <models...>`. The script collects CSV wall times and complete CLI logs for load, planned/checked moves with four and eight threads, and planner-only (no certification) with four threads. Run with `BM_PLAN_BUDGET=15` or adjust budget as needed; optional `BM_RUN_OVERLAPS=1`. Do not treat a budget-limited result as a complete plan.
5. Compare model loads, plan outputs, certification counts, crossings/flags, and peak memory in Activity Monitor or Instruments. The most promising next profiling points are `firstCrossing()` (`pair.cpp`), `clearTravel()` (`world.cpp`), kinematic contact tests (`contact.cpp`), and memo growth/locking.

On base M1 hardware, comparing four versus eight planner workers is more reliable than hard-coding a thread count in advance. Some collision workloads are memory-bandwidth-bound, and use of efficiency cores may or may not help depending on model/caches. Also record whether the machine has 8GB or 16GB RAM; swapping can dominate the 2,119-piece model.

## Scope / compatibility

**Measured improvements are restricted to repeated geometry and planner bookkeeping**, not overall p95 plan time, interactive frame rate, or collision fidelity of Studio custom parts. No collision thresholds, sample spacing, geometric-trim policy, or solver flag criteria were loosened. Preserve the prior warnings about sampled rotational sweeps and approximate tolerance memoization. The user should keep a copy of the original project and run the full macOS test suite before replacing a production build.
