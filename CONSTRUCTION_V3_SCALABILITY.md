# Construction V3 — incremental guided search and bounded fallback

## Scope of this update

This release targets a measured bottleneck in rigid-route *disassembly* search.
It starts from `Construction V3 — Exact Contacts & Import Fix` and retains its
exact-pose final-surface certificates, actual mesh oracle, typed LDCad profiles,
and final forward replay. It does **not** weaken moving collision checking or
claim to solve every mechanism.

## Algorithmic changes

1. **Monotone prefix pruning.** For a part withdrawing from a fixed pose along a
   fixed ray, a failed continuous swept check of length `d` proves that all
   *longer* withdrawals along that ray include the same obstructed prefix.
   These longer depths are not sent to the mesh oracle again. A different ray
   may still succeed, and every successful movement must pass the usual oracle.
2. **Concrete obstacle-witness cache.** When a near sweep is blocked, save its
   *part instance ID*, whether it was in the assembled scope or staging, its
   checked distance, and a key containing the scope, moving part, and full
   normalized direction. Reuse the negative result only when the witness is
   still at the same assembled/staged placement and the new travel contains
   the checked prefix. On removal or relocation, the failed-ray proof expires.
   These records NEVER certify positive clearance.
3. **Direct overhead route before sideways detours.** After a certified NEAR
   withdrawal, check ascent, upper flight, and descent directly. Only if that
   fails, try work-scope exits. Rotated bays still require an enclosing-sphere
   certification, and the resulting path still passes full forward replay.
4. **Obstruction-driven search order.** Guide the next removal selection with
   previously observed blockers. Candidates whose obstructions moved receive
   priority; an accessible part that blocks several other attempted routes
   also becomes a stronger candidate. This is only a heuristic: the planner
   creates **no** inferred dependencies and never silently discards options.
5. **Bounded exhaustive branching on large scopes.** A scope with 120 or more
   units limits how many expensive V2-style candidates are spent in any one
   exhaustive branch, so DFS can explore alternate assembly orders. Each
   frame maintains its OWN count; child-frame effort does not consume a
   parent's budget. A search that exhausts these branches reports a resource
   budget failure, **not proof of impossibility**. Small scopes still use the
   former exhaustive behavior.
6. **Indexed connection lookup.** Map construction connection IDs to their
   owning scope nodes once, replacing repeated all-connection scans after
   every successful removal. Precompute blocked-candidate priority during
   sorting rather than scanning failures inside each comparator.
7. **Throttled progress and better diagnostics.** Progress callbacks no longer
   flood the Web Worker with messages for every unsuccessful candidate. Both
   successful plans and adaptive failure diagnostics can expose the deepest
   verified removal, attempts, backtracks, and negative cache reuse. The
   Timeline and Video panels correctly attribute failed V3 planning to V3.
8. **Invalidate old V3 timeline cache entries.** The planning fingerprint has a
   new V3 routing suffix. V2 and Standard keys are not changed.

## Real LEGO 5590 benchmarks

Runs used the identical 554-instance truck MPD subtree, minimal LDraw geometry,
LDCad Shadow Library, Node 22, and a **20 second total** planner budget. A
single measured run of each version is shown; times and depth are machine-
and search-path-dependent. These numbers are regression indicators, not broad
performance guarantees.

| Metric | Previous exact-contact V3 | This release | Meaning |
| --- | ---: | ---: | --- |
| Maximum truck removals reached | 37 / 450 | **110 / 450** | Deeper certified *partial search*, not a finished animation |
| Search states entered | 38 | 111 | Includes the initial state |
| Route candidates attempted | 30,145 | **15,193** | 49.6% fewer |
| Broad-phase obstacle hits | 409,999 | **88,144** | Substantially less obstacle iteration |
| Triangle-pair checks | 2,752,392 | 2,687,177 | Exact mesh checks remain mandatory |
| Cached failed rays reused | not available | 11,844 | Negative-only, obstacle-pose-validated |
| Avoided longer near depths | not available | 39,194 | Failed prefix dominates longer attempts |
| Direct-overhead route successes | not available | 46 | All checked with the original oracle |

An additional **60-second full 1,258-piece LEGO 5590** run using this search
strategy cleared final-contact validation and entered truck disassembly. It
still failed to complete: it reached the deepest partial sequence recorded in
`docs/diagnostics/construction-v3-search-scaling.json` and exhausted the
search budget. It **did not** produce a certified 5590 animation or MP4.

The longer truck-only experiment also exercised effort-bounded exhaustive
branches and alternative orders. These can make a search more productive, but
this model still has trapped parts and/or constrained mechanisms that the
current rigid-body route vocabulary cannot necessarily resolve.

## Reproduction

From the BrickMotion Studio root, with a local LDraw `parts/` and `p/` library
and the bundled LDCad Shadow Library:

```bash
npx tsx scripts/diagnose-construction-mpd.ts /path/to/5590.mpd /path/to/ldraw truck /tmp/5590-truck.json --engine=v3 --budget=standard
npx tsx scripts/diagnose-construction-mpd.ts /path/to/5590.mpd /path/to/ldraw full /tmp/5590-full.json --engine=v3 --budget=extended
```

The source includes `tests/anim/constructionV3Scaling.test.ts` covering
negative-ray cache invalidation, an 8-piece compiled route with replay, progress
throttling, invalid static overlaps, and V3 failure provenance. The previous
rotated-bay tests continue to apply. These are *focused* checks and do not
replace the full Vitest suite, browser QA, or actual video encoding tests.

## Remaining engineering work

- More efficient certified joint disengagement for interlocked Technic systems,
  gear trains, hinges and moving linkages (a rigid translation may not exist).
- Physically meaningful sequencing constraints and user-authored removal
  hints for cases with more than one legitimate construction order.
- Incremental contact audit and more scalable swept-mesh queries on models
  with several thousand parts; currently the full final-contact audit takes
  a significant fraction of the total configured budget.
- Robust deformation/articulation kinematics; flexible render composites
  remain *pre-shaped rigid* objects in certified V3.
- Complete automated application build, UI tests, and actual MP4 export after
  dependencies and browser assets are installed.

**Safety contract:** Every accepted V3 path must still pass the original
continuous triangle collision checks, permitted localized connector contacts,
floor checks, rigid rotation envelopes, and independent forward replay.
No candidate-pruning heuristic can turn a blocked mesh sweep into a certified
clear path. Search exhaustion is never physical-impossibility proof.
