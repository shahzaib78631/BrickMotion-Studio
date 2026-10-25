# BrickMotion — Blender-inspired camera and lighting workspace

## Scope

The scene workspace is a **project-level rendering configuration**, separate from
Standard Motion v4 planning. Existing plan JSON and procedural build cameras keep
working if the project has no scene objects. This feature does not change assembly
motion, piece placements, the generated timeline, or collision checks.

## Viewport workflow

1. Open a model in the **Build** or **Timeline** editor, then click **Scene** at
   the upper-right of the 3D viewport (beneath the navigation gizmo and View menu).
2. In **Add to scene**, choose **Camera**, **Sun**, **Point**, **Spot**, or **Ambient**.
   Add multiple cameras/lights as needed. They appear in the scene outliner.
3. Select an object in the outliner or by clicking its 3D helper. Use **Move** or
   **Rotate** and the on-screen gizmo, or edit its location/target numerically.
   Duplicate, rename, toggle lights, change colors/intensities, and remove objects.
4. With a camera active, choose **View camera** or press **Numpad 0**. A fixed
   output-aspect camera frame appears, with optional thirds and title-safe guides.
   **Align to view** (Ctrl+Alt+Numpad 0) positions the active camera to match the
   editor's current view. If no camera exists, Align creates one automatically.
   **Lock camera to view** allows orbit/pan/dolly to reposition that camera.
5. To mark a camera region, first enter camera view, click **Select region** or
   press **Ctrl+B**, then drag a rectangle inside the frame. **Ctrl+Alt+B**
   clears it. Turn on **Crop Preview & MP4 to region** to use the selected portion
   as a composition crop. To avoid changing the output aspect, the selected
   rectangle is expanded to an aspect-preserving window. The original selection
   can remain visible if cropping is disabled.
6. Enable **Use active camera in Preview & MP4** to render from that camera.
   Otherwise the previous time-varying procedural animation camera is used.
   The lights and exposure you author affect the viewport preview and the MP4.
   **Keep default studio lights** adds fill lighting, while turning it off uses
   the new scene lights plus a very faint environment fill.

## Supported camera and rendering features

| Feature | Implementation |
| --- | --- |
| Multiple cameras and active-camera selection | Yes |
| Camera add/duplicate/rename/delete and 3D gizmos | Yes |
| Numpad 0 camera frame | Yes |
| Align camera to current viewport and lock to view | Yes |
| Perspective FOV and 24/35/50/85 mm equivalent presets | Yes |
| Portrait, square, and landscape output framing | Yes |
| Camera border selection, optional aspect-safe preview/export crop | Yes |
| Rule-of-thirds and safe-area viewport guides | Yes |
| Sun, point, spot, and ambient lights | Yes |
| Light color, intensity, direction, cone, and shadows | Yes |
| Scene exposure, optional standard studio fill | Yes |
| Undo, redo, autosave, project export/import | Yes |
| Camera/light helpers excluded from MP4 | Yes |

The studio uses real Three.js light objects; the viewport handles and composition
lines are editor-only. Sun-light shadow frusta are sized to the model bounds. It
is **not Blender's Cycles path tracer**: caustics, physically accurate global
illumination, volumetric lighting, ray-traced reflections, HDRI management,
and exposure calibration are not implemented. Camera animation tracks, depth of
field, look-at constraints, light animation, and multi-shot cuts are future work.

## Data and compatibility

New configuration is an optional `sceneSetup` object in `Plan` (`src/plan/types.ts`).
The validated scene format lives in `src/plan/schema.ts`, camera crop and settings
in `src/render/sceneSetup.ts`, Three light realization in
`src/render/sceneLights.ts`, the viewport gizmos in `src/ui/sceneControls.ts`,
and the React controls in `src/ui/SceneTools.tsx`.

`useTimeline` and the timeline planning cache explicitly ignore `sceneSetup`;
editing lighting or dragging the scene camera cannot cancel or invalidate an
expensive construction plan. Preview (`src/ui/PreviewPlayer.tsx`), video export
(`src/export/exportVideo.ts`) and project persistence use the same document.
Old projects without `sceneSetup` retain the standard studio lights and animated
build camera.

## Verification and limitations

Offline smoke checks:

```bash
npm run verify:scene:offline
npm run verify:v4:offline
npm run verify:v4:mechanisms:offline
npm run verify:v4:collision-autodetect:offline
npm run verify:v4:helicopter:offline
```

With npm dependencies installed, run:

```bash
npm ci
npm run typecheck
npm run test:scene
npm test
npm run build
npm run dev
```

The offline checks cover normalized region drawing, aspect-preserving camera
cropping for portrait and landscape, creating/updating/removing scene items,
legacy camera fallback, planner cache isolation, and changed-file syntax. The
original Standard Motion v4 offline suites also pass. Interactive camera
controls, live WebGL lighting, MP4 encoding, and full browser integration still
need testing on a machine with dependencies installed. This release therefore
should be treated as a **feature-complete source implementation awaiting
browser QA**, not a fully verified production renderer.
