# Manual Camera Frame staging (no camera-triggered replan)

1. Open Scene, select/activate a camera, and set its position, target, FOV and 9:16 / 4:5 / 1:1 / 16:9 output.
2. Open Staging and click **Camera frame**. This **only selects a draft**. It freezes the previously planned layout in memory (including the previous sorting and output ratio), does not move the camera, and cannot start a new plan.
3. Choose **Group**, **Where** and **Side**. Still no new camera-frame plan is triggered.
4. Click **Arrange pieces in frame**. The button captures the camera pose, projection, crop, aspect and staging choices in the **project's SceneSetup**. Exactly one explicit retry triggers planning (a failed unchanged snapshot can be retried). It also enables this active scene camera for video so Preview/MP4 use the same captured view.
5. Adjusting camera coordinates, lens, render crop, aspect ratio, and staging choices afterward does **not** invalidate the applied staging plan. A reminder says that the current camera differs. Press Arrange again when ready to replan once.
6. **Fit camera to starting pieces (optional)** is a separate camera-moving action, not invoked by choosing Camera frame or by Play.

## Notes and edge cases

- Projects saved before this update have no applied frame snapshot. Selecting the Camera frame tile does not plan, and legacy camera-frame video settings gracefully fall back to packed layout until Arrange is clicked.
- Applied snapshots are project-local and survive plan export/import. Old projects remain readable (new field optional in the schema).
- When the current camera is too tight for even one piece, the planner produces an error **once**. Widen the camera or reposition it and press Arrange again; changing camera controls alone never retries.
- Normal staging layouts still change immediately. Standard build-setting changes, model edits, and manual Regenerate remain intentionally capable of planning.
- The fitted camera pose / live camera controls are never overwritten by a staging application.

- While Camera frame is selected or applied, the Build viewport does not invoke its automatic `frame(...)` when a timeline finishes planning, and the procedural intro/hero camera motion is suppressed. This prevents the unexpected zoom-out after pressing Play. The separate Fit control is still explicit.
