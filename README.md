# 🧱 BrickMotion Studio

Design brick-built sets, or have Claude invent them, then export a vertical (9:16) build animation for TikTok, Reels or Shorts. Parts start laid out on a white studio floor, fly into place in build order, and the video ends on a hero orbit.

## Setup

Needs Node 22+ and Chrome (MP4 export uses the browser's H.264 encoder).

```bash
npm install
npm run setup   # once: downloads the LDraw parts library (~150 MB zip, ~620 MB unpacked) and the Rebrickable catalog
npm run dev     # open http://localhost:5173
```

`npm run setup` puts the parts in `public/ldraw/` and the catalog in `public/data/`. Both are git-ignored. `npm run build` copies them into `dist/` too (≈700 MB), so the app is meant to run locally.

### LDraw data

The parts library is downloaded on demand. To fetch it manually, official parts are at <https://library.ldraw.org/library/updates/complete.zip> and unofficial parts at <https://library.ldraw.org/library/unofficial/ldrawunf.zip>. Unzip them into `public/ldraw/`.

## Scene cameras, lighting and region-based preview

BrickMotion now includes a **Scene** panel in the 3D viewport. Add and select
multiple cameras, and add Sun / Point / Spot / Ambient lights with real scene
shadows, adjustable brightness, color, targeting and exposure. Align a camera to
the editor view, lock it to view, or use **Numpad 0** to see its output-aspect
frame. Use **Ctrl+B** inside camera view to draw a camera region, and optionally
**Crop Preview & MP4 to region**; **Ctrl+Alt+B** clears it. Toggle thirds and
safe-area guides, duplicate or delete objects, and save all settings with the
project. A selected camera replaces the procedural video camera only if **Use
active camera in Preview & MP4** is enabled; older projects stay unchanged.

**Camera and light edits do not restart Standard Motion v4 planning.** See
[SCENE_CAMERA_LIGHTING_VIEWPORT.md](SCENE_CAMERA_LIGHTING_VIEWPORT.md) for a full
feature list, controls, compatibility notes and current testing limitations.

## Workflow

1. **Get a plan**
   - **✨ AI → Generate with Claude**: describe a set ("a tiny orange seaplane with twin floats"). Needs your Claude API key in **☰ → Settings**. The key stays in this browser.
   - **✨ AI → Copy AI prompt**: copies a prompt for any chat assistant (ChatGPT, Claude.ai…). Paste its answer under **✨ AI → Paste plan**.
   - **Import…**: open a `.json` plan, or an LDraw `.ldr` / `.mpd` model (for example an official set from the LDraw OMR).
   - Or build by hand: pick parts on the left; arrow keys move, PageUp/PageDown change height, R rotates, Delete removes.
2. **Fix it**: the **Checks** panel lists floating and overlapping pieces. Click a piece to move it, recolour it or swap the part. **✨ AI → Fix with Claude** sends the checks and your note back to Claude.
3. **Place assemblies**: Open **Assembly** in the left rail. Each nested submodel use has its own row. Drag a model row onto the Build viewport floor to set a spot, or select a row and enter X/Z in studs and an angle in degrees. The old model-name chip strip has been removed from the viewport. Select and drag a floor marker to reposition it; enable the transform gizmo to translate or rotate around Y (15° increments, Shift for free rotation). The **Auto** action restores automatic placement. Enable **Show models at build spots in viewport** to display each placed main model and submodel directly on its selected floor footprint in Build mode, including during marker dragging. This is an editor-only preview; source brick coordinates and the animation’s final installed geometry are never changed. **Loose pieces follow the model** is a separate animation option: turning it off keeps waiting parts at their original floor locations. Spot edits are undoable (Ctrl/Cmd+Z) and stored in your project. After a Construction V2/V3 plan succeeds, the panel also lists the generated **construction subassemblies** (upper body, lower body, head module, mechanical preassembly); select one and enter X/Z/angle or **Auto** to place its work bay. The **Checks** tab lists overlapping build areas without moving any manual spots.
4. **Organize selected pieces**: Shift-click to select multiple parts. Right-click a selected part (or empty viewport space while several parts are selected) and choose **Group selected pieces** for a selection group, or **Create submodel from selection…** for a new reusable, independently editable submodel. Clicking a grouped piece selects its group; Alt-click selects only that piece. **Ungroup selected** removes selection grouping without changing the build hierarchy.
5. **Animate with keyframes**: In the timeline footer choose **Timeline** (Blender-inspired Dope Sheet) instead of **Build** (automatic assembly). Select a brick or top-level submodel in the viewport, press **I** to insert Location/Rotation/Scale keys, advance to another frame, and edit its transform values. Drag and multi-select keyframe diamonds, choose Bezier/Linear/Constant interpolation, use copy/paste and undo/redo, or turn on **Auto Key** to record gizmo transforms. Timeline has its **own** frame clock and works even if Construction V2 cannot plan a build route. To **edit the generated construction animation**, click **Edit Build in Timeline** on the Build toolbar, then use the linked Build strip and add motion-offset keys over it. You can change the procedural Build's start frame and speed, or return to Build to change assembly steps; the manually authored keys remain. To edit **each generated brick flight**, use **Bake selected** (others remain linked) or **Bake all & detach** (self-contained keyframe animation). The Dope Sheet now includes per-brick transforms and a Visibility track, plus a Check motion advisory. Keyframes save with the project but do **not** change authored LDraw geometry. See [KEYFRAME_TIMELINE_NOTES.md](KEYFRAME_TIMELINE_NOTES.md) and [BAKED_FLIGHTS_NOTES.md](BAKED_FLIGHTS_NOTES.md) for controls, safety notes and limitations.
6. **Preview**: **▶ Preview** plays the automatic construction animation inside a 9:16 frame. Set the length (5–60 s), how pieces arrive (one by one, in batches, step by step), the export FPS, the hero orbit and an optional logo. Flights rise above already assembled pieces before crossing the scene, with swept-volume collision checks for simultaneous flights.
7. **Export MP4**: Open **Video** and export with **Build** active for an automatic-construction MP4, or with **Timeline** active for a keyframed MP4. Timeline export includes linked Build motion when enabled, samples the animation at the selected output FPS (regardless of authoring FPS), and renders the same object poses and visibility as the Dope Sheet. H.264 supports selectable 24, 25, 30, 48, 50, 60, 90 or 120 fps at your chosen size. Browser support for high FPS varies. Timeline MP4 export runs a sampled collision-warning preflight for edited motion. It is not mesh collision certification. Timeline export follows the Build camera (including framing and the hero orbit) when motion comes from a Build, including fully baked Standard Motion tracks. Fully hand-keyed clips use a fixed camera fitted to the animated scene; camera keyframing is future work.

Projects save automatically (📁 Projects), and the last one reopens on load.

## Standard Motion — editable motion-aware assembly

In **Video → Planner**, select **Standard Motion v3 — mechanics + kinematics (editable preview)**. This is a new, independent mode based on Standard; it does **not** replace Standard, Construction V2/V3 or the strictly verified V4.

- **Build** keeps Standard's staging and submodel handling, but can **reorder two-sided connected groups before route planning**. For example, if Standard would install both minifigure legs and then move the hips through one of them, Standard Motion tests **leg A → hips → leg B**, the reverse order and hips-first. It also handles simple two-ended typed mechanical connector hubs. Explicit `assembly.after` and `assembly.attachTo` requirements take precedence; the saved plan and Standard mode remain unchanged. It generates alternatives for hinges, clips, ball joints, studs, pins, axles and cylindrical fits from matched LDCad world-space connector data. Bounded spatial indices now check already installed bricks, staging-floor occupants and simultaneously flying parts with sampled/swept AABBs, and prefer routes with fewer possible obstructions. A detected connection can be inserted sideways along the joint axis rather than dropped through its mate; host overlaps are relaxed only during nearby seating, not during early travel. For obstructed flights, the updated v3 engine tries a locally sized overhead route and ten face/diagonal detours, not just four fixed offsets, and reruns the collision review after choosing all routes. The newest revision also uses true fixed-pivot rotation during inferred hinge/clip/ball final approaches, pure connector-axis slide during stud/pin/axle insertion, and conservative filtering when another joint would lock that motion. Exact world joint-space interpolation avoids the straight-chord drift between keyed pivot poses. These are still **uncertified preview routes**, not multi-body inverse kinematics, gear/linkage dynamics or verified mesh clearance.
- If the assembly dependency graph is invalid (for example, a missing attachment parent), the engine uses an **unverified per-part fallback** instead of abandoning valid bricks. The project retains the original geometry and final positions; nothing silently changes to force parts to fit.
- Select **Timeline**, or click **Edit all part keyframes** in Build. For **every valid leaf**, the planner converts its move into its **own editable Location X/Y/Z, Rotation X/Y/Z, Scale X/Y/Z and Visibility tracks**, including nested submodel bricks. Expand any part in the Dope Sheet to see and edit its channels. The keyframes are saved in the project and can be exported from Timeline.
- Previously edited part tracks are preserved. Only missing per-brick tracks are generated automatically, to avoid overwriting manual corrections. The regular **Rebake all** command intentionally overwrites flight tracks. After updating the engine, regenerate **Build**, then rebake if you want existing baked keyframes to inherit new paths; make a backup of manual edits first. **Timeline → Review routes** lists the first 200 possible trajectory obstructions. Click a brick to filter to its own nine channels and jump to the reported time; **Check motion** separately checks the edited keyframed result. Neither check is collision certification.

If the selected model is very large or a generated transform cannot be represented exactly by the editor's standard keyframe channels, the editor reports the limitation and leaves the procedural Build available. All Standard Motion preview paths require visual inspection. See **[STANDARD_MOTION_ENGINE.md](STANDARD_MOTION_ENGINE.md)** and **[STANDARD_MOTION_V3_MECHANICS_KINEMATICS.md](STANDARD_MOTION_V3_MECHANICS_KINEMATICS.md)** for architecture, mechanical motion, how to use it, tests and limitations.

## Standard Motion v4 — mechanical graph, continuous mesh review and joint stops

Select **Video → Planner → Standard Motion v4** to use the independent three-phase upgrade while preserving Standard Motion v3. V4 builds a world-space connector graph with rigid clusters and checks against conflicting installed joints; evaluates motion throughout each sweep using conservative envelopes plus the Construction mesh oracle; and honors optional, explicitly entered signed hinge/slider stops. Results are **clear, blocked or unverified**. Blocked routes trigger alternative path proposals; unresolved previews remain editable and require acknowledgement before video export. It does not infer unknown stops or certify unsupported compound movements.

This release includes the user's LEGO 5590 MPD and its minimal geometry in `samples/` and `public/ldraw/`, plus the bundled LDCad Shadow metadata in `public/data/ldcad-shadow.json`. No further 5590 DAT geometry files are necessary. For implementation notes, validation limits, example joint-limit JSON and remaining LDraw metadata requests, see **[STANDARD_MOTION_V4_PHASES_1_3.md](STANDARD_MOTION_V4_PHASES_1_3.md)**.

## Plan format

```json
{
  "format": "brickmotion-plan",
  "version": 1,
  "name": "Mini Jet",
  "steps": [
    { "pieces": [{ "part": "3034", "color": "Dark Bluish Grey", "x": 2, "y": 0, "z": 0, "rot": 0 }] },
    { "pieces": [{ "submodel": "engine", "x": 4, "y": 1, "z": -3, "rot": 0 }] }
  ],
  "submodels": {
    "engine": { "steps": [{ "pieces": [{ "part": "3710", "color": "Dark Bluish Grey", "x": 0, "y": 0, "z": 0, "rot": 0 }] }] }
  }
}
```

- `part` is an LDraw part id (`3001` = Brick 2 × 4). `color` is an LDraw colour name or code.
- `x`, `z` are in studs and `y` is in plates (1 brick = 3 plates, up is positive). The position is the minimum corner of the rotated footprint and the bottom of the piece. `rot` is 0, 90, 180 or 270.
- Submodels are built aside and then attached in one move **unless their manually chosen build spot already matches the installed position and orientation**; in that case they are built in place and do not fly away and back. Submodels can be placed several times.
- Assembly spots are optional plan metadata. Top-level `"assemblySpot": {"x": 10, "z": -5, "angle": 90}` places the main model by its footprint centre. `"loosePiecesFollow": false` leaves its floor layout in the original frame (default is true). `"showModelAtSpot": true` previews independently placed submodels as well as the main model at their floor spots (default is false). A submodel-use item may have `"assembly": {"buildSpot": {"x": 8, "z": -3, "angle": 45}}`, positioned in the main model's original frame. Planner-generated bays are stored separately under `"workBaySpots": {"$upper:<group id>": {"x": 8, "z": -3, "angle": 45}}`; group IDs are exact planner scope IDs, so duplicate submodel uses keep independent bays. Spot coordinates use studs; angles use degrees. These fields are optional, so older projects keep their old layout.
- Construction V2 now supports **independently rotated submodel build spots** (including nested submodels and non-right angles). It stages each piece at a verified pose, rotates the finished group only inside a collision-free enclosing sphere, and replays the entire scene before compiling the video. Cross-orientation sweeps use conservative bounds; a genuinely un-certifiable path reports a planner error instead of teleporting or changing your spot. Main model rotations work with both planners.
- Selection groups use an optional `"assembly": {"group": "Group 1"}` field on each member. These groups affect editor selection only; they do not alter build order or animation.
- A Blender-style object animation uses optional `"animation": {"fps": 24, "startFrame": 1, "endFrame": 250, "tracks": [...]}` metadata. Each object track references a unique `(model, target)` pair and keys its Location, Euler Rotation and Scale channels on integer frames. For **linked construction editing**, `"buildLayers": {"": {"startFrame": 1, "speed": 1}}` adds generated Build motion as the base for the main model; manually keyed tracks apply as non-destructive offsets. Both Timeline and Build can be exported to MP4. Generated Build's individual flight paths can be baked into independent keyframes, without modifying their planner source. Motion review reports potential bounds overlaps, not mesh-level certification. Rigs/IK are future work.
- Imported LDraw pieces that sit off the grid use `"ldu": [x, y, z]` and `"matrix": [9 numbers]` instead of `x/y/z/rot`.

A sample is in [`samples/mini-jet.plan.json`](samples/mini-jet.plan.json).

## Development

```bash
npm test            # Vitest
npm run typecheck
npm run build
```

Code map: `src/ldraw` (parsing and geometry), `src/plan` (format and edits), `src/model` (assembly and checks), `src/anim` (pacing, floor layout, flights, camera), `src/export` (MP4), `src/ai` (prompts and the Claude call), `src/ui` (React).

## Credits

- Part geometry: the [LDraw parts library](https://library.ldraw.org/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (ldraw.org).
- Part names and categories: [Rebrickable.com](https://rebrickable.com/).
- three.js for 3D, Mediabunny for MP4 encoding.

LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this app.

### Construction V2 audit and complex-model failures

See [CONSTRUCTION_V2_10156_AUDIT.md](CONSTRUCTION_V2_10156_AUDIT.md) for the October 24 collision/timing audit, focused fixes, and a 113-piece proxy test of the 10156-1 truck layout. The real edited truck MPD/project was not available; its exact V2 routing failure is not claimed fixed. The Build timeline offers an explicit Standard-planner option on V2 failures, with a warning about uncertified routes.

### LEGO 5590 geometry reproduction

See [CONSTRUCTION_V2_5590_FINDINGS.md](CONSTRUCTION_V2_5590_FINDINGS.md) for a **real-mesh** reproducible audit of the 1,258-piece Whirl 'N Wheel Super Truck. Construction V2 now recognizes narrow, verified Technic snap contacts at the completed pose; it still **cannot certify this entire model** because of gear/rack engagements, flexible 755/756 hose chains and unexplained helicopter contacts. No unchecked collision waiver or automatic uncertified fallback is applied.

To reproduce with the supplied minimal LDraw library, unzip `5590-minimal-ldraw.zip`, then run:

```bash
npx tsx scripts/diagnose-construction-mpd.ts /path/to/5590.mpd /path/to/ldraw full ./5590-diagnostic.json
# Or replace full with truck, trailer, or helicopter to isolate an assembly.
```

## Construction V2 adaptive planner

For complex LDraw and Technic models, Video > Planner includes **Adaptive — V2, then uncertified preview**. It attempts rigid collision-checked Construction V2 and, for recognized limitations only, provides an explicitly **uncertified** Standard motion preview with the V2 failure preserved. It never hides missing geometry or invalid input, and requires acknowledgement before exporting an uncertified MP4. Preformed hose-segment composites, final-pose-only gear-mesh recognition, orientation-aware swept checks, and updated cache certification are documented in [CONSTRUCTION_V2_GENERALIZED.md](CONSTRUCTION_V2_GENERALIZED.md).

### Construction V2 search diagnostics

Video → Planner now exposes Standard (20 s), Extended (60 s), and Diagnostic (120 s) V2 search budgets. Each preset also adjusts state and route-candidate limits without weakening collision checks. For model-specific CLI diagnostics, `scripts/diagnose-construction-mpd.ts` accepts `--budget=standard|extended|diagnostic`. See `CONSTRUCTION_V2_BUDGET_EXPERIMENT.md` for measured LEGO 5590 results: extra time uncovered unresolved helicopter contacts and did not complete the truck's large route search.

## Construction V3: guided rigid planning

Video → Planner now also offers **Construction V3 — guided, certified only** and **Construction V3 — guided, preview fallback**. V3 uses connector-guided near/far route proposals, scoped BVH obstacle acceleration, authored-step/dependency-aware ordering, hierarchical submodel scopes, and the existing strict swept-mesh validation and forward replay. The preview fallback is explicitly uncertified. Both V2 and V3 share the configurable search-budget presets for comparison.

For architecture, executable diagnostics, measured LEGO 5590 benchmark results, supported behavior, and remaining limitations, see [CONSTRUCTION_V3_IMPLEMENTATION.md](CONSTRUCTION_V3_IMPLEMENTATION.md). The supplied 1,258-piece 5590 model is **not yet fully certified**: the original V3 contact audit found three unexplained helicopter geometry relationships; the subsequent mechanical-interface upgrade reduces that to two. The 554-piece truck still exceeds a 20-second strict planning budget. These failures are surfaced instead of being silently waived.

## Construction V4: global-scene articulated planning (experimental)

Video → Planner now also offers **Construction V4 — global scene, articulation-aware**. V4 plans one global scene of rigid clusters, builds a typed joint graph from LDCad connector evidence, carries localized pose-anchored connector policies, measures residual final-pose render surfaces, and adds continuous arc/annulus rotation certificates. Its forward step-module search and global backward search share a deterministic work budget. V4 is **certified only**: it never emits a partial or uncertified animation.

V4's helicopter final-contact audit passes with zero unresolved contacts, and it fully plans small fixtures, but the 305-piece helicopter and 1,258-piece 5590 do not yet complete within the 300-second acceptance budget. The remaining blocker is search over a truly interleaved part order, not a collision-check waiver. See [docs/diagnostics/construction-v4.md](docs/diagnostics/construction-v4.md) for the architecture, measured status and known limitations.

## Construction V3 mechanical-interface upgrade

The new [MECHANICAL_CONSTRAINT_ENGINE.md](MECHANICAL_CONSTRAINT_ENGINE.md) documents the LDCad profile-aware connector matcher, typed world-space joint topology, guided insertion axes, scoped static-contact certificates, and model-specific diagnostics. `scripts/diagnose-construction-mpd.ts` accepts `--inspect-interfaces` and `--focus-parts=...` to explain nearby connectors. The **Build** footer now exposes detailed contact rejection reasons and lets you copy them for debugging.

On the real LEGO 5590, the new connector match resolves the previously rejected 4073/4349 helicopter pair. **Two helicopter contacts remain unresolved and the complete model still does not produce a certified animation.** With the same 20-second truck budget, V3 advanced from 35 to 37 removed planning units and reduced candidate tests from 63,793 to 30,419; the truck still times out. Metadata and joint labels are *not* full kinematic simulation or mesh certification.

For exact-pose LEGO 5590 surface-contact reviews and the corrected V3 connector-matcher module path, see [CONSTRUCTION_V3_EXACT_SURFACE_CERTIFICATES.md](CONSTRUCTION_V3_EXACT_SURFACE_CERTIFICATES.md).

### Construction V3 incremental search improvements (2026-10-24)

Construction V3 now prunes obstructed withdrawal prefixes, caches **negative**
ray checks only while the same obstacle stays fixed, chooses blocker-guided
removal order, and attempts direct overhead transfers before detours. The Web
Worker's planning progress updates are throttled, and the editor reports a
plan's deepest verified removal sequence during V3 fallback. Existing continuous
collision checks and forward replay remain mandatory. See
[`CONSTRUCTION_V3_SCALABILITY.md`](CONSTRUCTION_V3_SCALABILITY.md) for reproducible
LEGO 5590 benchmarks and unsupported rigid-joint cases.

### Construction V3 constrained departures

V3 includes a bounded multi-turn configuration-space fallback. The latest
extension can start from the assembled pose for verified first-edge connector
release and uses strict swept-mesh checks on all subsequent edges. Search
budgets, explicit uncertified fallback, and V2 mode remain available. See
`CONSTRUCTION_V3_CONSTRAINED_MOTION.md` for the benchmark and unsupported
articulated-motion cases. No collision-certified LEGO 5590 timeline has been
produced yet.

## Standard Motion v4 — mechanical stages (phases 4–6)

Standard Motion v4 can now optionally append deterministic gear-coupled, articulated closed-loop and reduced-coordinate gravity demonstrations **after** the v4 assembly. Motion is authored by per-instance JSON, saved as world-rigid timeline samples, and can be rebaked to editable keyframes. Post-build demonstration now receives a conservative saved **CLEAR / BLOCKED / UNVERIFIED** continuous triangle-surface verdict; incomplete or closely contacting geometry remains **UNVERIFIED**. The gravity preview is **not** full rigid-body/contact simulation. See [STANDARD_MOTION_V4_PHASES_4_6.md](STANDARD_MOTION_V4_PHASES_4_6.md) and `samples/mechanisms/` for setup examples and limitations. Legacy v3 and all Construction planners are unchanged.


## Standard Motion v4 — continuous mechanism clearance and automatic mechanics

This experimental enhancement checks the **saved mechanism playback** between keyframes for moving/moving and moving/parked mesh collisions, reporting CLEAR, BLOCKED or UNVERIFIED with pair/time diagnostics. LDraw headers and matched LDCad Shadow connectors can also automatically identify hinges, shafts, gears and turntables; where the constraints permit, the editor offers an **opt-in** one-click mechanism suggestion. It never invents tooth counts, measured stops or masses. It does not certify physical gear contact clearance or replace a production-grade rigid-body solver. See [STANDARD_MOTION_V4_COLLISION_AUTODETECTION.md](STANDARD_MOTION_V4_COLLISION_AUTODETECTION.md). The 5590 static coverage audit is in `samples/5590-v4-mechanical-coverage.json`.

### Standard Motion v4 planning repair (helicopter)

See [STANDARD_MOTION_V4_PLANNING_REPAIR.md](STANDARD_MOTION_V4_PLANNING_REPAIR.md) for the large-model planning-stall fix, conservative collision-review policy, real-geometry helicopter regression, and installation/verification steps. Use `npm run verify:v4:helicopter:offline` to reproduce the 305-piece motion-postprocessor test. Large-model v4 uses a single-pass Standard baseline; **Standard Motion v3 behavior is unchanged**.
