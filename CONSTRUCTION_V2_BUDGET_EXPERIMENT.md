# Construction V2 — controlled budget experiment, LEGO 5590

**24 October 2026**. Reproduced against the user-supplied 5590 MPD and its 444 resolved LDraw `*.dat` files (133 unique directly referenced parts). Used the Construction V2 generalized/adaptive planner source, local LDCad snap metadata, and the real triangle meshes. No procedural fallback was permitted. All reported times below are the planner's own elapsed `stats.milliseconds`, not the time spent preparing the geometry or printing post-failure diagnostics.

## Hypothesis

If the default 20-second budget was the only issue, increasing the limit should allow Construction V2 to finish planning or at least reveal consistent progress toward a complete strict plan. If the algorithm or connector model is inadequate, extra time should instead uncover unresolved contacts or an excessive number of failed route candidates.

## Results

| Test | Allowed time | State limit | Candidate limit | Actual result | Search progress |
| --- | ---: | ---: | ---: | --- | --- |
| Full model, prior default control | 20s | 2,000 | 100,000 | `search-budget-exhausted` in completed-pose audit, 24.01s reported | 0 states |
| **Full model, higher time** | **60s** | **20,000** | **100,000** | **`unresolved-final-contact`**, after **34.23s** | **0 states** (search never began) |
| Truck only, prior short-budget control | 15s | 2,000 | 100,000 | `search-budget-exhausted` in route search, 15.00s reported | ~20 / 450 units |
| **Truck only, high budget** | **120s** | **10,000** | **500,000** | **`search-budget-exhausted`**, after **120.00s** | **38 / 450 units** |

The default full-model control and the short truck control are the previously saved comparison runs from this same source/geometry. The 60-second and 120-second runs were newly executed for this experiment; diagnostic logs and JSON are saved separately.

### Full-model run, 60 seconds

- 1,258 part instances, 133 unique direct part types, no missing geometry.
- 8,984 mesh-pair oracle checks, 5,786,003 candidate triangle comparisons, 445 cache hits.
- The completed-pose audit reached three unresolved contacts in the **helicopter** submodel, all in the final geometry: `4073 ↔ 4349`, `4349 ↔ 2462`, `4073 ↔ 2462`.
- `states=0`, `candidates=0`, `backtracks=0`: **route search did not run at all.** No amount of route-search budget can make those three final-pose contacts self-certifying. They need specific connector/contact classification or verified geometry correction.

### Truck-only run, 120 seconds

- 554 part instances. Semantic flexible grouping reduced its top-level removal problem to **450 units**.
- `states=38`, `candidates=212702`, `backtracks=0`, `meshPairs=41978`, `trianglePairs=9533248`, `cacheHits=607298`.
- Route search progressed from 20 to only 38 removed units despite nearly eight times the short control's time budget.
- Reported obstacles are primarily continuous swept-mesh withdrawal and transport collisions; this is not proof the model is physically impossible.

## Explanation of the computational bottleneck

1. **Completed-pose audit.** `src/anim/construction/planner.ts` invokes `MeshOracle.staticContact` on nearby part pairs. `src/anim/construction/collision.ts` examines multiple directions, distances, and binary refinements to classify a contact; some checks require winding-number containment over complex LDraw render meshes. On this model the preflight itself consumed tens of seconds, and rejected connector semantics for three helicopter contacts.
2. **Search branch fan-out.** `planner.ts`'s `route()` attempts multiple directions, lift distances, slide exits and sky/carry corridors for each removal candidate, repeatedly testing swept collisions against remaining parts and staged parts. The 120-second truck test used more than **212,000** route candidates to remove just 38 of 450 units.
3. **The hard budget was not the root defect.** Default limits merely cut off the two problems sooner. Raising limits does not add missing connector definitions, smarter candidate ordering, a coarse-to-fine trajectory search, or fast incremental collision checking.

These findings are reproducible but **do not** establish the exact best route or the global impossibility of the input geometry. No collision-certified complete timeline was obtained.

## New application controls

Under **Video → Planner → V2 search budget**:

| Preset | Time | Max states | Max candidates |
| --- | ---: | ---: | ---: |
| Standard | 20s | 2,000 | 100,000 |
| Extended | 60s | 10,000 | 500,000 |
| Diagnostic | 120s | 50,000 | 1,000,000 |

These settings are stored in application preferences, passed through the worker to `planConstruction`, and included in the timeline-cache identity. They **only increase planning effort**; they do not change strict collision certification. The separate MPD diagnostic script accepts `--budget=standard|extended|diagnostic` and includes the actual limits in its JSON report. (The custom command-line experiment used 20,000/100,000 for the full 60-second run and 10,000/500,000 for the truck 120-second run; neither state nor candidate bound was reached, so the corresponding time budget is the discriminating limit.)

## Follow-up engineering priorities

1. Diagnose the **specific helicopter 4073/4349/2462 interfaces** with LDCad snap definitions, material thickness and true manufactured clearances; never introduce a blanket triangle-intersection waiver.
2. Separate semantic joint classification from general-purpose triangle-sweep path certification. Cache per-contact resolution and audit per hierarchy scope, preserving exact unsafe-contact failures.
3. Replace repeated fixed-grid directions/distances/exits with a prioritized, bounded coarse-to-fine route search, guided by the known connector axis and nearby free-space topology.
4. Introduce a scope-local spatial index for incremental moving-vs-remaining sweeps and report per-phase time, tested candidates, and the closest proven obstruction.
5. Re-run this MPD and several unrelated regression models under the **same** budget and verify both solver completeness and collision safety.

## Reproduction with local dependencies

From the project root with npm dependencies installed and an extracted LDraw library:

```bash
npx tsx scripts/diagnose-construction-mpd.ts 5590.mpd /path/to/ldraw full full-60s.json --budget=extended
npx tsx scripts/diagnose-construction-mpd.ts 5590.mpd /path/to/ldraw truck truck-120s.json --budget=diagnostic
```

The tests above were run with a locally compiled CommonJS harness because this environment lacks the app's npm dependencies. The CLI is updated but has not been independently run via `tsx` here. Results may vary with hardware and thread scheduling; whether a path is collision-certified must never depend on the elapsed timeout alone.
