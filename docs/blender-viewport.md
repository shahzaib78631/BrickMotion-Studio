# Blender-style viewport navigation

What was added to the 3D editor view (Build view), the shortcuts, and ideas for later.
Everything here only affects the editor camera — the video export camera (`cameraAt`)
and saved files are untouched.

## What was added

- **View presets** (`src/render/viewPresets.ts`): Front, Back, Right, Left, Top, Bottom.
  A snap keeps the current orbit target and distance and eases the camera onto the axis
  in ~250 ms. Front looks at the model the way the default camera does (camera on +Z;
  pieces in front of the model sit at larger world z). Right/Left sit on ±X, matching
  Blender's numpad 3/1 behaviour relative to that front view.
- **Orthographic projection**: the studio now owns an orthographic twin camera
  (`src/render/studio.ts`). Numpad 5 (or the View menu) swaps it in with the same
  framing: the ortho frustum height is derived from the perspective distance and FOV,
  and OrbitControls' zoom wheel then changes the ortho zoom. Picking, fit-to-view and
  the transform gizmo follow the active camera, so everything keeps working in both
  projections. The Preview and MP4 export always render through the perspective camera.
- **Floor horizon**: OrbitControls' `maxPolarAngle` (0.49π) stays, but while the camera
  is on a view preset — or already below the horizon after a Bottom/Top snap — the
  limit opens to π so straight-down Top holds and Bottom is reachable, without ever
  snapping the camera when you leave a preset.
- **Navigation gizmo** (`src/ui/NavGizmo.tsx`): an axis widget in the viewport's
  top-right corner (X red, Y green, Z blue; filled bubbles are the positive axes).
  It rotates with the camera; clicking a bubble snaps to that view; dragging orbits.
- **View menu** (`src/ui/ViewMenu.tsx`): a compact "View" dropdown under the gizmo
  listing every preset with its shortcut plus the Perspective/Orthographic toggle.
- **View label** (`src/ui/ViewMenu.tsx`, `ViewLabel`): the current view, e.g.
  "Front Orthographic" or "User Perspective", top-left of the viewport like Blender.
  Any manual orbit renames the view back to "User".
- **Local view** (Numpad /): shows only the selected pieces. It reuses the store's
  hide/isolate/showAll, and the set hidden before entering is restored on exit.

New files: `src/render/viewPresets.ts` (pure camera math, unit-tested),
`src/ui/viewControls.ts` (keyboard/orbit/projection controller),
`src/ui/viewState.ts` (shared view state), `src/ui/NavGizmo.tsx`, `src/ui/ViewMenu.tsx`.

## Shortcuts

Only when the Build view is active and no text field is focused. The number row works
like the numpad (NumLock on); Cmd/Ctrl combos the app already uses are untouched.

| Key | Action |
| --- | --- |
| `1` / `Ctrl+1` | Front / Back |
| `3` / `Ctrl+3` | Right / Left |
| `7` / `Ctrl+7` | Top / Bottom |
| `5` | Toggle Perspective / Orthographic |
| `4` / `6` | Orbit left / right by 15° |
| `8` / `2` | Orbit up / down by 15° |
| `9` | View from the opposite side |
| `Home` | Frame everything (same as `F`) |
| `Numpad .` | Frame the selection |
| `Numpad /` | Toggle local view (only the selection) |

Mouse: middle-drag zooms (OrbitControls default), **Shift+middle-drag pans**; the
right-click piece menu still opens on a right-click without dragging. Note for
Windows/Linux browsers: Ctrl+1/3/7 may be reserved by the browser for tab switching.

## Worth adding later

- **Zoom to mouse cursor** (`zoomToCursor` on OrbitControls, already supported by
  three): zooming would keep the piece under the cursor fixed, which is how Blender
  behaves and makes close-up work much faster.
- **Walk/fly navigation** (Shift+F in Blender): exploring big floor layouts would be
  easier than orbiting around a fixed target.
- **Camera animation presets for the video** ("Save current view as the opening
  shot"): the editor view could seed the export camera's azimuth/elevation, tying the
  Blender-style views into the cinematic planner.
- **Quad view** (Ctrl+Alt+Q in Blender): four simultaneous viewports (front/top/right/
  user) help check alignment on symmetric models; needs a per-viewport renderer setup.
- **Lock camera to view** (checkbox in Blender's sidebar): editing while aligned to a
  saved view, useful for screenshot-matching an instruction manual page.
- **Clipping-plane indicator / camera-viewport rendering** (Numpad 0): previewing
  through a saved camera would make "what the video sees" inspectable in the editor.
- **Smoothed orbit steps** (tween 4/6/8/2 like the view snaps): the 15° steps are
  instant now; a short tween would match Blender's feel more closely.
- **Gizmo axis hover highlight**: the nav gizmo highlights nothing today; a hover
  ring like Blender's would make the click targets discoverable.
