# BrickMotion Studio — animation / MP4 / FPS fix

## Changes

- Collision-aware animation: every brick/submodel lifts vertically out of its staging area, moves at a safe altitude, then descends vertically into its final position. Concurrent flights are checked against one another using swept bounding boxes and given separate height/takeoff windows where needed.
- Reused floor windows and submodel staging areas do not reappear until earlier pieces and attached submodels have cleared them.
- Camera framing is precomputed per timeline and smoothly interpolated, preventing stepped camera movement during animation and export.
- Reduced preview rendering cost by limiting display pixel ratio and reducing shadow-map resolution. Avoid unnecessary instanced-mesh bounds work during animation.
- MP4 encoding uses evenly spaced frame timestamps, asks the encoder to prioritise frame quality instead of real-time latency, and avoids copying the entire image into a second canvas unless a logo is enabled.
- Export FPS options: **24, 25, 30, 48, 50, 60, 90 and 120**. Selected FPS is saved in settings. Your browser/hardware must support encoding at the selected FPS.
- Added regression tests for moving-piece intersections, reused submodel floor spaces, camera continuity and 60 FPS exports.

## How to use the complete project ZIP

1. Extract `BrickMotion-Studio-Fixed-Project.zip`.
2. Install Node.js 22+ and open a terminal in the extracted `brickmotion-studio` folder.
3. Run `npm ci` and then `npm run build`.
4. Run `npm run dev` to use the updated editor, or `npx vite preview` to serve the rebuilt `dist` directory.

The full source ZIP includes your original LDraw parts and catalog in `public/` and does NOT include the obsolete `dist` from the uploaded archive; a new `dist` is created by `npm run build`.

## How to use the small patch ZIP

1. Extract your original `Archive.zip` to a working directory.
2. Open the folder containing `package.json`, `src/`, `public/` and `tests/`.
3. Extract `BrickMotion-Studio-Fix-Patch.zip` into that folder, merging folders and overwriting matching source files.
4. Run `npm ci` followed by `npm run build`. Start `npm run dev` or serve the new `dist` using `npx vite preview`.

Do **not** reuse the `dist` folder bundled with the original archive without rebuilding; that JavaScript was compiled before these fixes.

## Verification and limitations

- Independently exercised timeline/camera code using the Three.js module extracted from the uploaded app bundle.
- A 400-piece tower was checked for moving-piece bounding-box overlap on a 120 FPS timeline (~2.13 million pair checks): **zero collisions** in that stress case.
- A small batch and a three-copy submodel scene also passed motion intersection checks.
- Source files parse successfully with TypeScript. Full `npm test`, TypeScript dependency typechecking and browser-based H.264 encoding could not be run in this environment because npm registry access is unavailable. Rebuild and run those checks after installing dependencies on your computer.

Collision checks use part-body bounding boxes (a conservative approximation); imported malformed models or pieces deliberately placed inside one another may still present intersecting geometry. For complex scenes, preview the result before export.
