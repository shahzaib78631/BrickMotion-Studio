# Standard Motion v4 — helicopter planning repair

## Why the earlier release could appear never to finish

Standard Motion v4 originally inherited Standard Motion v3's **multi-proposal route search** and then applied a second costly route selection and mesh certification pass. The certification pass compared each candidate against many staged and installed parts, often rechecking the same triangle meshes. On hundreds of pieces, work could grow far beyond the time spent producing the editable timeline. There was no sufficiently bounded large-scene planning path. A saved optional mechanism program referring to instance keys from a different model could also throw before a timeline was returned.

This repair prioritizes getting a complete editable assembly preview back to the user and **never labels an unchecked route collision-free**.

## Changes

1. **Single-pass v4 baseline for assemblies above 32 pieces.** Standard Motion v4 asks the existing Standard planner for one complete timeline using its native assembly scheduling / authored transforms. It skips v3's repeated complete-scene AABB scoring; v4 performs its own bounded route review instead. This optional code path does **not** change behavior of Standard Motion v3. If the initial Standard schedule fails for a non-corrupt model, v4 can retain the deterministic loose-piece fallback, with its limitations signalled in `motion.fallback`.
2. **Time-bounded v4 route selection.** Large builds score a small range of mechanical and clearance candidates using the inexpensive occupancy index, select a best preview, and leave the original route where no improvement is found. This is not a proof of mechanical clearance.
3. **Indexed and bounded mesh review.** Build a global conservative swept-envelope spatial index; time/pair/interval/depth limits bound attempts at exact proof per flight. Once review resources are exhausted, preserve the flight and report **UNVERIFIED**. No candidate can become **CLEAR** due to a timeout, sparse sampling or missing geometry.
4. **Editable fallback for stale optional settings.** Unsupported joint-limit lists, old-model mechanism programs and detector failures are surfaced in the planning warnings instead of preventing the assembly timeline from being built. A broken optional demonstration is simply not attached.
5. **Cache refresh and editor diagnostics.** A new v4 planning fingerprint prevents old cached planning results from being reused. The Video planner reports the number of retained tracks and counts of **CLEAR / BLOCKED / UNVERIFIED**, and calls out resource-limited verification.

## Helicopter reproduction / verification

Source model: `samples/helicopter/helicopter.mpd`, supplied by the user. The sample is a test fixture, not an animation authored for a particular LEGO sequence.

- 305 imported part instances, **80** directly referenced DAT filenames.
- 0 unresolved part-mesh placeholders using the **bundled** `public/ldraw` library.
- 0 assembly-import warnings.
- 305 complete, editable piece tracks returned, with each final matrix identical to its imported authored pose.
- The latest offline postprocessor test took approximately **9–11 seconds** on this execution environment with a synthetically generated starting timeline. Exact runtimes will vary; this is **not** an end-to-end browser benchmark.
- Large-model route search and mesh review each have a configurable-in-code time limit; budget or unsupported geometry becomes **UNVERIFIED**, not **CLEAR**.
- Some helicopter paths remain **BLOCKED or UNVERIFIED**. A generated animation is not a collision-free guarantee; these routes may still need revision.

The offline model regression uses the actual MPD importer, actual flattened part meshes, real v4 route selection and collision verifier. To isolate the originally stalled v4 stage without relying on unavailable browser packages, it constructs a *synthetic* Standard timeline containing one piece move per imported leaf. It **does not** execute the full Standard timeline scheduler, React editor or MP4 exporter.

## Tests performed

```sh
node scripts/verify-v4-offline.cjs
node scripts/verify-v4-enhancement-offline.cjs
node scripts/verify-v4-mechanisms-offline.cjs
node scripts/check-v4-enhancement-types.cjs
node scripts/verify-v4-helicopter-offline.cjs
```

These focused checks cover original v4 movement/regressions, collision continuity, simultaneous body motion, joint restrictions, gear/linkage simulation, source syntax, stale optional programs, and the 305-part imported helicopter fixture.

**Not yet verified:** production TypeScript build, full Vitest suite, real editor import / progress / playback, output video, or uninterrupted planning of the actual Standard schedule. The environment could not fetch the project's npm dependencies, including `@types/node` and Vite client types. Complete these acceptance checks in a normal project development installation before calling this production-ready.

## Installation

1. Back up your project and manually edited keyframe tracks.
2. Unzip `BrickMotion_Standard_Motion_v4_Planning_Fix.zip`. The complete source and bundled LDraw library are included.
3. In the extracted project run `npm ci` and `npm run dev` (requires network access for the initial package install).
4. Import `samples/helicopter/helicopter.mpd` or the original `helicopter.mpd`.
5. Choose **Video → Planner → Standard Motion v4**, and **regenerate Build / rebake**. The new planning fingerprint invalidates previous v4 timeline cache keys.
6. Review **CLEAR / BLOCKED / UNVERIFIED** per-part results. Remove an old, model-specific mechanical demo in Video settings if it is no longer relevant; invalid demos now only produce a warning.
7. Run `npm run typecheck`, `npm test` and `npm run build`, then test browser playback and export.

**Geometry dependencies:** all 80 directly referenced DAT files are already present in the project's bundled LDraw library for this helicopter. No extra geometry DAT files are required for this regression fixture. Additional verified connector metadata can improve mechanical motion realism, but is not necessary to obtain an editable animation timeline.

## Remaining engineering work

- A genuine browser integration benchmark on the helicopter and more difficult MPDs.
- Replace process clock deadlines with deterministic per-task work budgets where reproducibility is required, and move heavyweight verification to a cancellation-aware worker.
- Automatic collision-safe replanning for paths still labelled BLOCKED; a preview must never be confused with a mechanical certificate.
- A progressive background *verification task* (not required to generate a usable animation) where the product's platform supports it.
