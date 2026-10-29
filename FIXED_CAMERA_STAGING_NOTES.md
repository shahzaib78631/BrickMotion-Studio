# Camera Frame staging: place pieces inside the existing shot

## Previous problem

`Camera frame` previously only sized floor bays using the video's output ratio.
The `Fit camera to pieces` command then moved or zoomed the scene camera to
cover the generated layout. Users reported that they wanted the inverse:
**keep the deliberately chosen scene camera stationary, and arrange the parts
inside its image frame**, as in reference-style LEGO tabletop videos.

## Updated behavior

- Camera Frame uses the active Scene camera's saved position, target, FOV, near/
  far clip, output aspect ratio and optional render crop.
- Parts are distributed in image-aligned, centered rows across the available
  portrait/landscape frame around the completed build (not compressed to its centre).
  The actual 3D bounding footprint, including its height, must project entirely
  inside an inset safe region; physical footprints must not overlap.
- No camera movement or zoom is triggered when pressing Play. The older
  **Fit camera to starting pieces** button remains as a *separate optional*
  tool; it can still reposition the camera when expressly clicked.
- If a chosen lens cannot physically display all waiting parts, existing
  replenishment windows reuse the visible floor space in successive batches.
  The Staging panel reports the number visible in the initial shot. This is
  intentional even when Group is set to All parts at once: clipping pieces or
  shrinking LEGO geometry to force all 42 into an impossibly tight shot is
  worse than releasing them in groups.
- If even the first large part cannot fit, planning reports an actionable
  message: widen the lens / move the camera back / use Fit manually.
- Settings and save/export planning now use the identical active scene-camera
  projection; changes to the scene camera re-plan Camera Frame positions.
- Without an active Scene camera the legacy aspect-only floor arrangement is
  retained and the Staging panel explains how to enable true camera framing.

## Suggested workflow

1. Open Scene > Cameras & Lighting and choose **Camera 1**. Frame the
   completed build in the middle of the shot, with room for loose pieces.
2. Under Staging choose **Camera frame**, **Group: All parts at once** (if
   capacity permits) or By colour, **Where: All around**.
3. Choose your export aspect, e.g. 9:16. The floor layout recalculates to that
   exact projection. Adjusting the scene camera changes the layout and may
   trigger fresh animation planning.
4. Press Play. The camera remains locked to your pose and does not zoom out.
   For a deliberate wider shot, click **Fit camera to starting pieces**.
5. Apply the Reference Grey or Slate Blue photo look and a softbox lighting rig.

## Scope and verification

- Targeted no-overlap, projected-bounds, camera-immutability, crop and capacity
  checks were run against a standalone TypeScript build of the new algorithm.
- Static TypeScript/TSX parser checks passed on all changed source files.
- Whole-app browser/WebGL playback still needs a live verification: the npm
  dependency installation was unavailable in this environment.
- This frame-driven packing is implemented for the legacy / standard assembly
  planner; construction-v2/v3/v4 staging uses its own physical work bays.
