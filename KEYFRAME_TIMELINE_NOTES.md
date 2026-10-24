# Build / Timeline editor — implementation and verification

## Overview

BrickMotion Studio now has two independent animation editors, selected by the **Build** and **Timeline** tabs directly above the bottom timeline.

- **Build** is the existing automatic LEGO construction editor. Assembly routing, collision certification, staging, steps, synchronized build-video playback and MP4 build export are retained.
- **Timeline** is a separate Blender-inspired object Dope Sheet. It uses its own frame-accurate clock and keyframe document. Independently authored animation works even if Construction V2 reports `no-supported-rigid-route`. When the user explicitly links a procedural Build layer, that source must successfully re-plan to play/export the linked motion.

This change establishes non-destructive object animation (rigidity-preserving transforms for submodel instances) as a foundation for later bone/rig animation. **No armatures, bones, constraints or mesh deformation are implemented yet.**

## Timeline workflow

1. Open **Timeline** on the bottom bar, select a piece or top-level submodel in the 3D viewport or Dope Sheet outliner.
2. Move to a frame using the ruler or Frame field. Press **I** or **Insert key** to record Location, Euler Rotation and Scale for the selected object. A top-level submodel carries all its descendant pieces rigidly.
3. Move to a new frame. In the Transform inspector, edit Location X/Y/Z (studs in displayed view-space), Euler Rotation X/Y/Z (degrees), or Scale X/Y/Z (factors). Edits insert/update the corresponding channel keyframe without altering authored LDraw geometry.
4. Alternatively turn on **Auto Key**, enable the viewport gizmo (**G**), and translate/rotate/scale the selection. Releasing the gizmo completes a single undoable keyframe gesture.
5. Scrub/play to see the animation. The scene range defaults to frames 1–250 at 24 fps; Start, End, FPS and Loop are adjustable. Auto Key is off by default.

### Edit a generated Build without losing the automatic planner

1. Generate a valid construction animation in **Build** mode; click **Edit Build in Timeline** (or in Timeline select **Use Build as base**).
2. A distinct green **Generated Build** strip appears in the Dope Sheet. This is a live-linked procedural source, not hundreds of hand-authored keyframe diamonds.
3. Use the Build layer's **Start** (frame) and **Speed** (0.1×–4×) fields to move or retime the entire construction clip. This is a saved, undoable edit. The scene end extends automatically when required to avoid cropping the source.
4. Select an object and add Location / Rotation / Scale keys in Timeline. They are **non-destructive offsets on top of** the original generated flight and final pose; bricks remain hidden until their procedural appearance time.
5. Go back to **Build** to change steps, staging, assembly spots, or planner settings. The linked source updates on re-planning; the manually authored keys remain intact. An unavailable Build route produces an explicit warning instead of showing/exporting static pieces at the wrong poses.
6. **Unlink** removes the procedural source but preserves all manual object keys. This returns to pure keyframe animation.

**Flight baking is now available.** With a live linked Build, select a brick or top-level submodel and click **Bake selected** to convert its generated movement and visibility to editable channel keyframes, leaving other pieces procedural. Click **Bake all & detach** to make the entire animation independent of Build planning. Expand the resulting nested brick tracks and edit the keys directly. A complete workflow, warnings and test status are in [BAKED_FLIGHTS_NOTES.md](BAKED_FLIGHTS_NOTES.md).

### Export manually keyed Timeline animation to MP4

1. Select **Timeline** (bottom editor) and open the **Video** panel.
2. Choose output resolution/format, output FPS, lighting, logo and optional snap audio, then click **Export**. When linked Build is enabled, its generated motion, visibility and keyed offsets are rendered together. Otherwise the Timeline video needs no construction plan.
3. The output `.mp4` is suffixed ` - Timeline`. The renderer samples the *authored* frames at the selected *output* FPS; choosing 60 FPS does not speed up an animation authored at 24 FPS. Rendering can be cancelled mid-export.

Build MP4 remains available by selecting **Build** before exporting. Both paths share H.264 encoding, lighting and quality settings. Timeline export currently uses a stable camera fitted to the complete animated scene, not a keyed camera. Snap audio is sourced from linked Build when available; there are no sound events on independent authored keys yet.

### Dope Sheet controls

- Left outliner lists scene objects (including individually baked submodel bricks); expand an object to display its 9 transform channels plus held **Visibility**. Filter for animated or all objects; search by object name or item ID.
- Each diamond denotes a keyframe at an exact integer frame. Click or Shift-click to select. **Shift + drag** in blank lanes selects keys in a rectangle. Drag selected diamonds to move them together. Double-click an empty channel lane to add a key.
- **Right-click** keys to copy/delete or choose **Bezier / Ease**, **Linear**, or **Constant / Hold** interpolation. Bezier/Ease currently uses automatic smooth zero-slope handles (smoothstep), not user-editable F-curve handles.
- Keyboard: **I** insert, **Shift+D** duplicate, **Ctrl/Cmd+C/V** copy/paste, **Delete/X** delete, **Ctrl/Cmd+A** select all visible-model keys, **Ctrl/Cmd+Z** undo, **Space** play/pause, **Left/Right** step one frame, **Home/End** jump to scene limits.
- Ctrl/Cmd/Alt+mouse wheel over the editor zooms around the pointer. The magnifier controls provide explicit zoom and fit.
- Selection/keyframe commands are separated from the brick-edit keyboard shortcuts. In Timeline mode, deleting a keyframe does not delete its brick.

### Storage and editing semantics

- Keyframes live in the optional `plan.animation` field of the existing `.brickmotion` plan; older plans require no migration.
- `animation.tracks[]` contains `{kind:'object', model, target, channels}`. `model` scopes a target ID to its editable model. Channels are `location.x/y/z`, `rotation.x/y/z`, and `scale.x/y/z`, with sorted frames and explicit interpolation.
- Animation is a **display transform on top of** the item's authored geometry and optional build-spot placement. The model's saved piece matrices, assembly spots, build steps, and generated construction routes are never overwritten by keyframes.
- Transform keys apply to a top-level item at its bounding-center origin. For submodel uses, all rendered descendants move as one rigid group.
- Keyframe changes are undoable/redoable through the same history and do not trigger geometry loading or construction replanning. The construction timeline cache excludes `plan.animation`.
- The persisted schema validates positive FPS, bounded frames, sorted unique keys, finite channel values, unique track bindings and frame-range consistency.

## Architecture

- `src/anim/keyframes.ts`: immutable keyframe document, evaluation, insertion, move, delete, selection, clipboard and interpolation.
- `src/anim/keyframePose.ts`: shared viewport/export animation sampler using rigid top-level item grouping; composes authored motion with placed spots or a live-linked procedural Build source without modifying LDraw placements.
- `src/anim/buildLayer.ts`: immutable Build source linking, playback rate, start-frame editing and frame-to-construction-time conversion.
- `src/state/keyframePlayback.ts`: independent animation clock, loop and Auto Key state.
- `src/ui/KeyframeTimeline.tsx` and `src/ui/keyframes.css`: Dope Sheet UI, frame ruler, keyframe editing, transform properties, keyboard/drag interactions.
- `src/ui/Viewport.tsx`: renders sampled keyframe matrices every animation frame, keeps selection/focus/gizmo in display coordinates and prevents geometry mutation while editing keyframes.
- `src/plan/types.ts` / `src/plan/schema.ts`: optional schema and typed channel document, permitting future evolution toward rigs.
- `src/export/exportVideo.ts`: shared H.264 pipeline with the Build and Timeline pose samplers, animated-scene camera bounds and independent render/audio timing.
- `src/ui/ExportDialog.tsx` / `src/ui/VideoPanel.tsx`: mode-aware export and selected output options; the Timeline uses its authored frame range.
- `src/App.tsx` and `src/state/store.ts`: Build/Timeline workspace selection, with explicit transport separation.
- `src/state/useTimeline.ts`, `src/state/useModel.ts`, `src/storage/timelineCache.ts`: isolate keyframe updates from construction planner and geometry cache.

## Current feature boundaries

- Timeline currently offers **object-level Location, Rotation and Scale animation only**. Bone rigs, skinning, IK, drivers, constraints, interpolation handle editing, NLA strips, audio synchronization and F-curve editor are future work.
- **Both Build and Timeline export MP4**. Timeline captures manually authored object keys, or a linked construction base plus those keys, from the same pose evaluator as the viewport. Camera keyframes and dedicated manual audio-event editing are future work.
- Generated Build flights can be **baked into independently editable per-brick keyframes**, with Visibility/Hidden, optionally for selected bricks while the other pieces remain procedural, or for the full model with the Build detached. The source construction algorithm remains procedural; baking creates a separate editable snapshot. Source route changes only flow to still-linked unbaked pieces. A Build failure is never hidden for pieces still linked to that source.
- For very large scenes, the Dope Sheet is scrollable and the sample matrices run in the viewport render loop; a production performance pass on real datasets is still advised.
- Authored Timeline edits receive an optional motion overlap review plus an automatic MP4 preflight warning. These checks use sampled swept bounding boxes; **they do not certify mesh-level collisions** and cannot guarantee collision-free edits. Refer to [BAKED_FLIGHTS_NOTES.md](BAKED_FLIGHTS_NOTES.md).

## Verification

- Standalone core evaluator tests: 13 passing assertions against the emitted strict TypeScript core module (key upsert, selection, move, collisions, copy/paste, interpolation, boundaries, serialization and other operations).
- Added Vitest coverage in `tests/anim/keyframes.test.ts`, `tests/anim/keyframePose.test.ts`, `tests/plan/keyframeSchema.test.ts`, plus timeline-planner and geometry-cache regression tests.
- Added regression coverage in `tests/anim/buildLayer.test.ts` and `tests/export/keyframeVideo.test.ts` for source linking/retiming, independent Timeline MP4, frame resampling, visibility, layered offsets, cancellation and missing routes.
- Strict TypeScript compilation passed for the dependency-free keyframe document/types modules. All TypeScript/TSX source files passed TypeScript syntax parsing.
- **Environment limit**: npm registry access failed, and the LDraw data assets are not available; therefore the full dependency-backed `npm run typecheck`, Vitest suite, Vite build, and interactive browser checks **have not** passed or been verified. These must be run on a configured development workstation before release.

## Suggested local release gate

```bash
npm install
npm run setup
npm run typecheck
npm test
npm run build
npm run dev
```

Browser acceptance cases: import an MPD with a few bricks and a nested submodel; add position/rotation keys at frames 1/24/48; drag one and multiple keys; test interpolation, loop, Auto Key with gizmo, undo/redo, save/reopen; export Timeline at output FPS different from its authored FPS; compare MP4 and viewport positions at known timestamps; link Build and verify hidden pieces stay hidden until construction, then apply and export transform offsets; adjust Build speed/start; change a construction step and verify the source re-plans without losing keys; confirm export reports route failure; switch repeatedly between Build and Timeline.
