# Camera Director — design

Date: 2026-10-31 · Status: draft for approval

## Intent

BrickMotion should be able to make build videos with camera work like the two
references (`~/Downloads/Video-54869.mp4`, Megatron BrickHeadz;
`~/Downloads/Video-64902.mp4`, Doctor Doom BrickHeadz). Today the build camera holds
one fixed angle for the whole build (a few degrees of drift) and ends with a hero
orbit. The user wants camera handling at the level of professional film tools:
the app can direct the camera automatically, the user can place shots by hand, and
the automatic result is an ordinary camera timeline the user can edit.

What the references do (frame-by-frame study):

- Start high and close over the baseplate; **drop toward eye level as the model grows**.
- **Swing round to the side being built** (Doom: behind the model while the cape goes
  on, back to the front for the face).
- **Fast, motion-blurred moves** between framings (Megatron, ~11 s: a 0.3 s swing from
  a high corner to a low front view; no hard cuts in either video).
- **Pull back and down before tall parts arrive** (Doom, ~5 s, before the head).
- Tight framing with a long lens, shallow depth of field, motion blur on fast pieces.
- End on a **front-facing reveal**.

## Goals

1. **Smooth keyframes (fix first).** The Timeline (keyframe) editor feels snappy: every
   `bezier` key has zero-slope handles (`channelAt`, `src/anim/keyframes.ts:43`), so
   motion stops dead at every key. Default smooth keys must flow through middle keys
   (auto-clamped tangents, as Blender's "Auto Clamped"), easing only at the first/last
   key or where the user asks. Existing projects play smoother with no migration.
2. **A Camera track.** A new "Camera" row in the Animation Editor holding camera keys
   (a camera view at a moment) and the transitions between them.
3. **Auto-direct.** One button fills the Camera track from the build, in the style of
   the references. Its output is ordinary, editable keys and transitions.
4. **Hand editing.** Add a key from the current viewport view, update a key from the
   view, drag keys in time, delete keys, and type exact values in the Inspector.
5. **Customisable transitions with presets.** Every transition between two keys has a
   preset and editable settings. Many presets ship built in; the user can save their own.
6. **Lens track.** Focal length, focus point, and blur strength can change over time
   (rack focus, dolly zoom).
7. **Preview and MP4 follow the Camera track**, including depth of field and motion blur.

## Non-goals

- Live depth of field or motion blur in the editing viewport (user: fine to see them in
  Preview and MP4 only; the viewport is already heavy on large models).
- A free-form graph editor for drawing curves by hand (user chose settings, not a graph).
- Multiple simultaneous cameras / multicam editing, or editing camera paths as splines
  drawn in the 3D view.
- Changing how pieces fly (the build planner) — only the camera.

## Anti-goals (a failure even if it "works")

- Camera passes **through** the model, or the model leaves the frame during a move.
- Moves that feel mechanical: constant speed, dead stops at every key, jerky rotation.
- Auto-direct output that cannot be edited, or edits that Auto-direct silently wipes.
- Existing projects suddenly look different without the user doing anything (except
  the smoother keyframe curves, which the user asked for).
- The editing viewport getting slower.

## The camera model (how a key is stored)

Following professional rigs (Unreal rail + crane, Blender path + "track to"), a camera
key is **rig values, not a raw position**:

| Field | Meaning |
|---|---|
| `t` | time, seconds on the video timeline |
| `target` | what the camera looks at: `model` (finished-model centre), `build` (what is being built right now, the current automatic framing), `piece` (the piece landing), or a fixed point |
| `targetOffset` | world-space nudge of the aim point |
| `azimuth`, `elevation` | angle round and above the target, degrees |
| `distance` | either a fixed distance or **auto-fit** with a margin (fit the target box, like today's `fitDistance`) |
| `roll` | Dutch tilt, degrees |
| `lensMm` | focal length |
| `focus` | 0–1 like `LensChoice.focus`, or "on target" |
| `blur` | depth-of-field strength (as `LensBlur`, continuous) |
| `origin` | `auto` (made by Auto-direct, untouched) or `user` (created or edited by hand) |

Interpolating rig values (angles, log-distance) makes moves arc round the model
naturally. Angles take the short way round unless a transition says otherwise
(an orbit can go the long way, e.g. 220°).

## Transitions

Each gap between two keys has one transition. A transition = preset id + settings.
Choosing a preset fills in the settings; any setting can then be changed.

**Settings:**

- **Speed curve**: linear, ease in, ease out, ease in-out, hold-then-move, snap
  (fast start, long settle), plus strength. *Separate curves for position, aim and
  lens* (professional practice; avoids a mechanical feel). Default: one shared curve,
  "Advanced" reveals the three.
- **Path**: arc round target (rig interpolation, default) or straight line (truck /
  pedestal / dolly feel).
- **Orbit direction**: shortest, clockwise, counter-clockwise, with extra turns allowed.
- **Overshoot & settle**: 0–1.
- **Motion blur**: 0–1 shutter strength (0 = off, 0.5 ≈ 180° shutter, 1 = 360°).
- **Shake**: handheld noise amount and frequency.
- **Hard cut**: no in-between; jump at the second key.
- **Flow through**: when on, the camera does not stop at the end key, it carries speed
  into the next transition (auto-clamped tangent across the key).

**Built-in presets** (names for the UI): Smooth glide, Push in, Pull back, Truck left /
right, Pedestal up / down, Crane down, Crane up, Orbit around, Arc reveal, Fast swoop
(the Megatron swing), Whip pan, Dolly zoom (Vertigo), Rack focus, Dutch tilt in,
Handheld drift, Hold, Hard cut.

**User presets:** "Save as preset" on any transition. Saved in app settings (shared
across all projects) — *builder's call (see below)*.

## Auto-direct

Generates keys + transitions over the build timeline. Rules (from the references):

1. Opening key: high (≈55–65°) and close over the base; Smooth glide in.
2. Elevation descends with the built height toward the reveal elevation (≈10–20°).
3. Azimuth follows **where pieces land**: if the next stretch of the build adds pieces
   mostly on one side of the model, swing toward that side (with a minimum shot length
   so it does not dither). Big swings use Fast swoop; small ones Smooth glide / Orbit.
4. Before a tall addition (the finished height jumps), Pull back + Crane down early
   enough that the new part lands in frame.
5. Closing key: front-facing reveal (the model's front = the side with most visible
   detail; *builder's call how to detect, with a user override*), Push in or Arc reveal,
   then the existing hero behaviour is replaced by this end shot.
6. Framing uses the existing build framing (`frameKeys` / `focusPlan` in
   `src/anim/camera.ts`) for distance and aim, so pieces stay in frame.

A **Style** choice steers it: *Reference (BrickHeadz)*, *Calm product*, *Energetic*,
*Overhead*. Settings: number of side swings (busy ↔ calm), lens, motion blur.

**Re-running** Auto-direct replaces only `origin: auto` keys and their transitions;
keys and transitions the user edited (`origin: user`) are kept, and new auto keys are
fitted around them.

**When the build is replanned** (timing changes), auto keys are regenerated; user keys
stay at their times. *Builder's call:* optionally anchor a user key to a build step so
it moves with the step.

## Editing UI (option A, chosen)

- **Animation Editor**: a new **Camera** row (diamonds = keys, coloured bars =
  transitions labelled with the preset) and a **Lens / focus** row underneath. Shown in
  both the Build and Timeline editors (the camera belongs to the video, not to one editor).
- Toolbar: **Auto-direct** (with Style), **+ Key from view**, **Update key from view**,
  delete. Drag keys to retime; drag a transition's ends to retime both keys.
- **Inspector (right panel)**: selecting a key shows its rig values as fields (target,
  azimuth, elevation, distance / auto-fit + margin, roll, lens, focus, blur). Selecting
  a transition shows preset + all settings + "Save as preset".
- Viewport: while scrubbing or playing, the viewport looks through the Camera track
  (as "camera follows playback" does today). With the playhead parked and the user
  orbiting, the view is free; "Update key from view" writes it back into the key.
- Undo/redo for every edit (part of the plan, like other edits).

## Playback and export

- One sampler `cameraTrackAt(track, t, context) → CamPose + roll + lens state` is the
  single source for viewport, Preview and MP4, so they always match.
- MP4 camera choice (`exportCamera`) gains **Camera track**; it becomes the default
  when a track exists. With no track, behaviour is unchanged (`automatic` /
  `buildView`).
- **Depth of field** in Preview and MP4 uses the existing post blur
  (`src/render/depthOfField.ts`), driven per frame by the track's focus/blur.
- **Motion blur** (new) in Preview and MP4: average several sub-frame renders across
  the shutter interval; sample count scales with how fast the camera and pieces are
  moving that frame (0 extra renders on still frames). Preview uses fewer samples.
- Roll and lens changes apply to the export camera (`fov` from lens, as `cameraFov`).

## Constraints

- Three.js + React + zustand, existing patterns. Plan data saved with the project
  (camera track per editable model, beside `plan.animation`).
- The project format must load old projects (no camera track = old behaviour) and the
  new field must round-trip through save/load.
- Must not add per-frame cost to the editing viewport when not playing.
- Vertical 9:16 is the main format; everything must also work in 16:9 and 1:1.
- Tests with vitest for the sampler, interpolation, Auto-direct rules, and the
  keyframe smoothing fix.

## Builder's calls (decided by me, not the user — flag if you disagree)

- Keys store rig values (target/angles/distance), not raw positions.
- Time in seconds on the video timeline; the keyframe editor's frames convert via fps.
- User presets live in app settings (all projects), project-specific use stays in the plan.
- "Flow through" keys use auto-clamped tangents, same maths as the keyframe fix.
- Front-of-model detection for the reveal is automatic with a manual override.
- Motion blur by sub-frame accumulation (accurate, export-only cost).
- Auto-direct Styles and preset parameter values are tuned by eye against the two
  reference videos.
- Auto-direct runs only when the user presses it; projects have no Camera track until
  then (no surprise changes).
- The old hero orbit becomes Auto-direct's closing "Orbit around" / "Arc reveal"
  transition, so it is editable like any other.

## Left to the builder

Exact preset parameter values, colours of transition bars, Inspector field layout
within the side-panel pattern, sub-frame sample counts, swing thresholds in
Auto-direct, and file/module organisation.
