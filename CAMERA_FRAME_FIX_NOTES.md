# Camera frame staging — framing and playback repair

This update fixes the miniature strip of waiting parts seen when Camera frame was selected and Play was pressed with a 9:16 video format.

## Fixes

- **Staging footprint:** The chosen aspect ratio now determines the overall staging area around the assembled model. For **Where: All around**, the planner distributes waiting pieces across four centered bays (front, back, left, right), rather than a narrow row stretched into the distance. For the other Where options, only the requested bays are used. Existing collision-safe replenishment windows are preserved.
- **Actual piece fit:** Camera distance is computed from the *initially visible staged-piece boxes plus the finished build*, not the planner's spacious reserved floor area or later submodel work areas.
- **Auto-fit on Play:** With **Staging → Camera frame → Auto-fit camera on Play** enabled, playing the Build timeline fits and saves the active scene camera. The camera keeps its viewing direction and field of view. The fit also drives Preview and MP4 export.
- **Manual fit:** **Fit camera to pieces now** performs the same framing without playing.
- **Camera inspector units:** The X/Y/Z camera/light fields now represent world studs consistently; they no longer multiply entered coordinates by 20. If a previously created camera is hundreds of studs away, using either fit action repairs its position.
- **Preview and export consistency:** A fitted camera-frame scene stays on its tabletop shot instead of jumping back to an over-wide establishing shot during the video intro or the hero orbit.
- **Fresh layout cache:** The planner key changed so previously cached narrow arrangements are not reused.

## Reference-style setup

1. Select **Staging → Camera frame** and select **9:16** for vertical reels.
2. Set **Group: All parts at once** and **Where: All around**. Keep **Auto-fit camera on Play** checked.
3. Use **Fit camera to pieces now**, or press **Play** to fit automatically.
4. For the screenshot's look, choose **Reference Grey + Grey Softbox** (or **Slate Blue + Blue Editorial**) under Materials/Scene.
5. Use **Camera View** or **Preview** to inspect the actual output shot. Set an appropriate camera angle before fitting if you want a steeper top-down photograph.

**Notes:** This changes the default behavior only when Camera frame staging is selected. Disable Auto-fit camera on Play to preserve a precisely authored scene camera. A fully bounded shot can still appear sparse if a model has exceptionally large separate subassemblies or many staged parts far from the build. Changing the video aspect ratio triggers new staging arrangement planning.

## Verification performed

- TypeScript/TSX transpile diagnostics pass for modified files.
- The staging bay and shelf-packing algorithms pass offline scenarios covering 9:16, 4:5, 1:1 and 16:9, including 20, 196 and 400 parts, with no region/piece overlaps in these scenarios.
- The patch's applicability is verified against the immediately preceding full ZIP and against the original archive for its cumulative variant.
- Full `npm run build`, `npm test` and rendered/WebGL screenshots were **not** executed here because the npm dependencies are unavailable in this environment.
