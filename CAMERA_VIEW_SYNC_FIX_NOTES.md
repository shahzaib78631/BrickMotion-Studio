# Camera view sync fix (after Camera Frame & Playback Fix)

## Why the fitted pieces still looked tiny

In the screenshot, **Camera view** and **Lock camera to view** were both enabled. The scene controller's `snapCamera()` returned early whenever `lockCamera` was on. Consequently, Auto-fit on Play and Fit camera to pieces now updated the saved scene camera but left the live viewport looking through an old, distant pose. That stale pose could then be written *back over* the fit by OrbitControls.

## Changes

- Camera view now follows updates to the saved active camera **even with Lock camera to view enabled**. Lock still allows moving the scene camera by orbiting/zooming the viewport.
- Changed-pose detection avoids unnecessary OrbitControls updates while dragging. The `syncingView` guard protects external camera fits from being overwritten by a camera-change callback.
- The **Auto-fit camera on Play** effect and **Fit camera to pieces now** action now synchronize the live camera immediately as they save its fitted pose. React's follow-up scene sync stays supported.
- Added regression tests for the lock-mode semantics and immediate saving/displaying of a camera fit.

## How to verify

1. Choose **Staging → Camera frame**, **Group → All parts at once**, **Where → All around**; keep **Auto-fit camera on Play** checked.
2. Under **Scene → Camera view**, keep **Lock camera to view** checked (as in your screenshot).
3. Click **Fit camera to pieces now**. The pieces should become substantially larger *immediately* inside the portrait frame, without requiring a lock toggle.
4. Press Play; Preview and exported video should use the same saved shot. If the saved camera is aimed too low, orbit up for a steeper tabletop look and refit.

The fix preserves existing staging positions, project settings, and lighting presets. It does not change the 3D geometry or promise collision-free framing for arbitrary user camera rotations.

## Verification limits

Automated source checks and isolated runtime simulations cover the synchronization path. Full browser/WebGL screenshot verification was not possible in this environment because npm dependencies are missing.
