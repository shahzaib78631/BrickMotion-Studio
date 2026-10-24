# Editable generated flights: baked keyframes and motion review

## What changed

The Build planner and Timeline editor remain separate. Generated Build motion can now be sampled into **ordinary per-instance editable keyframes** in the Dope Sheet, with Location (studs), Euler Rotation (degrees), Scale, and discrete Visible/Hidden channels. These are non-destructive display transforms; no underlying LDraw brick coordinates, construction steps, or placement markers are rewritten.

- **Bake selected** converts the selected brick or all descendant bricks of the selected submodel into native object tracks. Unbaked pieces continue following the live construction source. The baked piece no longer depends on its procedural flight.
- **Bake all & detach** converts every brick and removes that model's Build source. The resulting Timeline can play and export MP4 without the planner being available. Other models' Build sources are unaffected.
- **Rebake all** is available after detaching when a valid generated Build still exists. Rebaking can replace manual edits and therefore asks before overwriting existing keys.
- **Visibility** is an independent held/stepped channel, preserving both each brick's initial appearance and any temporary hidden intervals in legacy Build data. It never crossfades during playback.
- Bake samples all authored output frames during flight operations and compresses straight channel segments while preserving endpoints, bends and pauses. It uses the shared Timeline/MP4 transform evaluator for parity. Non-representable affine transforms fail without modifying the plan.
- The Dope Sheet shows independently editable tracks for nested submodel bricks. Parenting/group offsets may still be applied above baked brick poses. Multiple keys may be selected, moved, copied, pasted, deleted and changed to Linear / Ease / Hold interpolation (visibility always Hold).
- Baked tracks persist in saved projects (`source: 'baked-flight'` on object tracks) and participate in undo/redo. Empty baked tracks intentionally remain independent rather than switching a part silently back to the planner.

## Workflow

1. Generate the construction in **Build**. Select **Edit Build in Timeline**.
2. Select a piece or submodel and press **Bake selected**. To convert the entire Build and stop depending on Construction V2, choose **Bake all & detach** instead.
3. Expand a baked item in the Dope Sheet, drag the keyframe diamonds or edit the Location/Rotation/Scale/Visibility channels in Properties. All operations remain undoable.
4. Press **Check motion**. Any possible new overlap is listed with a **Review contacts** dropdown. Click a frame to jump directly to the viewport and investigate.
5. Export **Timeline** MP4 from **Video**. A sampled bounds preflight runs automatically on edited Timeline motion; suspected contacts or a truncated scan require explicit export confirmation.

## Collision-review contract

The diagnostics compare sampled object bounds and swept motion against the unedited Build when that source is available. Rigidly co-moving members are excluded to avoid flagging normal LEGO interlocks. The review is budgeted (max sampled frames and pair checks), and reports when scanning is incomplete.

**Important:** This is an advisory broad-phase sweep, **not a mesh-level collision certificate**. It can report harmless contacts or miss intersections between samples or inside detailed meshes. A clean result must never be described as guaranteed collision-free. Manual edits also need visual/physical review before production export. The original Build planner's route certification applies only to its own unmodified generated path.

## Safety boundaries and performance

- Per-channel key budget 5,000; max 7,000 frame samples per brick and 300,000 sampled poses across a bake; whole animation max 2,000 object tracks and 380,000 keys. Limits reject the bake transaction rather than creating a partially authored state or locking the editor indefinitely.
- Flight positions are converted against the original placed instance and display pivot, including mirrored LDraw bases and independently placed nested submodels. Non-rigid shear or deviations beyond the baking tolerance cause a clear error instead of silent shape changes.
- Rebaking warns if it will overwrite existing authored keys, including edits to earlier baked flights; undo recovers the preceding document state.
- Unlinking a partially baked construction warns that unbaked pieces would become static. Bake all before unlinking for a self-contained result.
- The construction planner remains unchanged. Its worker, saved steps, and source geometry are not mutated by baking. Editing baked Timeline curves does not replan the construction automatically.
- There is no editable Graph Editor with spline tangent handles yet, nor full mesh collision certification, bones, IK or rig controls. Location/Rotation/Scale per-channel Dope Sheet editing is supported now.

## Source map

- `src/anim/bakeBuild.ts` and `bakeCurves.ts`: deterministic sampled Build-to-keyframe conversion, compression, transform checks, limits.
- `src/anim/keyframes.ts` and `keyframePose.ts`: interpolation, step visibility, baked-track precedence, nested parent offsets, viewport/MP4 shared sampler.
- `src/anim/motionDiagnostics.ts`: budgeted broad-phase AABB/swept-bounds advisories, rigid co-movement suppression.
- `src/plan/types.ts` and `schema.ts`: `source: 'baked-flight'` and `visibility`, with validation.
- `src/ui/KeyframeTimeline.tsx`, `keyframes.css`, and `src/App.tsx`: Bake controls, editable nested channels, Check motion, jump-to-frame warnings and Timeline export preflight.
- `tests/anim/bakeBuild.test.ts`, `motionDiagnostics.test.ts`, `tests/plan/bakedFlightSchema.test.ts`: regression cases for linked and detached baking, nested pieces, visibility, editability, compression, and diagnostics.

## Validation status

- All TypeScript/TSX sources and tests were syntax-parsed using the TypeScript parser.
- Dependency-free core files passed an isolated strict TypeScript check, and standalone Node assertions for visibility, editing, frame conversion and key simplification passed.
- **Not verified here:** the full TypeScript build, Vitest suite, interactive viewport QA, actual MP4 encoding and real-world LDraw geometry tests. The current container could not fetch the missing npm dependency tarballs, and the LDraw assets were not installed. Run `npm ci`, `npm run setup`, `npm run typecheck`, `npm test`, and `npm run build` locally before production use. Test representative long builds, rotated nested assemblies, and source-planner failures in a browser with MP4 support.
