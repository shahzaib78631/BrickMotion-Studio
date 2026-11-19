# Native camera director — design

Date: 2026-11-19 · Status: approved by the owner (saved tracks win by default)

## Intent

The native engine needs a camera that films a build the way a film crew would. It should not
copy the web app's camera. Today the planner writes one orbit key a second around the part of
the model being built (`timeline.cpp:990`). Every app blends those keys in a straight line
(`bmr::OrbitCamera::along`). The camera knows nothing about the lens, the export's aspect ratio,
the floor, what is about to happen, or editing.

The owner asked for production-grade camera work, "like animated movies, industry use". It must be
reusable across animation types and planners:

- build flights;
- submodels built on their spot and flown in;
- mechanisms moving;
- hero reveals;
- planners not written yet.

The owner wants two ways to direct it:

- **The camera directs itself** by default.
- **The owner can take over** at any level: one shot, a pinned camera, keys, or a whole track.

The owner chose this order:

1. The engine and the automatic director come first. They read the camera tracks the web editor
   already saves.
2. Native editing tools in bmview come later, under a design of their own.

The owner picked **approach A, a shot-list director**, over live virtual cameras (B) and
whole-timeline optimisation (C).

## Goals

1. **Planners describe; the camera films.** A planner reports what happens and never chooses an
   angle. Examples: a piece flies from its spot to its seat, a unit is built on its spot, an axle
   turns, the build ends. Any planner that reports events gets camera work without camera code of
   its own.
2. **A director that edits like a person.** It turns the events into a shot list:
   - what each shot is about;
   - how big it is in frame;
   - the angle;
   - the move;
   - how it joins the next shot (cut or blend).

   It follows editing rules: a minimum shot length, no jump cuts, keeping to one side, leading
   the action, and anticipating it. It looks ahead, because the whole timeline is known before
   anything plays.
3. **One camera body for everything.** One solver turns any shot, automatic or authored, into a
   camera for each frame. It handles:
   - a real lens (focal length in mm and the sensor);
   - fitting the subject for the export's aspect ratio (a 16:9 and a 9:16 export of the same shot
     both keep the subject in frame);
   - composition;
   - never entering the model or the floor;
   - smooth motion with no jitter;
   - focus and shutter values for the path tracer.
4. **The owner's shots win.** The camera tracks and scene camera saved in a `.brickmotion`
   project are filmed by the same body. Whatever the owner has not touched stays automatic, and
   the two blend without jumps.
5. **Every app shows the same camera.** bmview, bmshot and bmexport (stills now, film later)
   sample the same per-frame camera.
6. **Measured, not eyeballed.** Automatic checks run on the corpus and gate each change. The
   owner judges the final look by eye.

## Non-goals

- Editing tools in bmview or anywhere else. That is the next design. This one only fixes the
  data that design will edit: the shot list and the authored layer.
- Changing how pieces fly, the build order, or the floor layout. Only the camera changes.
- Multiple cameras on screen at once, or multicam editing.
- Live depth of field or motion blur in the viewport. The body computes focus and shutter, but
  only the path tracer uses them.
- Matching the web director's output frame for frame. The web's style names and its reference
  study are inputs, not a specification.
- Film export. Task 7 of phase 7 is paused by the owner. This design only makes sure film
  export can sample the camera when it resumes.

## Anti-goals (a failure even if it "works")

- The camera passes through the model or below the floor, or the piece being placed leaves the
  frame while it lands.
- Mechanical motion: constant speed, dead stops between moves, twitchy reframing on every piece,
  or rotation that judders.
- Jump cuts: a cut to nearly the same angle and size.
- Cuts faster than a viewer can follow.
- A shot list that cannot be read or edited, so that the bmview editing design would have to
  start over.
- The owner's saved tracks get ignored or rewritten without a word.
- Results that depend on thread count or timing. Same input gives the same camera, bit for bit.
- The viewport gets slower, or planning gets noticeably slower.

## Approaches considered

- **A. Shot-list director (chosen).**
  - Events go to a director, which writes a shot list. A camera body turns the list into a
    per-frame camera.
  - It uses look-ahead because the timeline is known in advance.
  - The shot list is exactly what an editor changes later.
  - Cost: the most design work up front.
- **B. Live virtual cameras.** Always-running procedural cameras (overview, follow, close-up),
  with a switcher that blends between them.
  - Simpler, and it runs live.
  - Rejected because it reacts instead of anticipating, looks less edited, and has no shot list
    to override cleanly.
- **C. Whole-timeline optimisation.** One solver scores visibility, framing and smoothness over
  the whole camera path.
  - Smoothest result.
  - Rejected as the main design because it is slow, opaque and hard to edit.
  - Its idea survives as the body's final smoothing pass (see Camera body).

## Shape of the module

A new C++ library, **`bmfilm`**, in `native/film/`:

- It depends on `bmcore` (model, plan, timeline, collision) and has no Metal.
- It is used by `bm` (the CLI) and by the render tools through `render/tools/common/engine.*`.
- The renderer stays a consumer: it takes a `bmr::Camera` per frame and does not decide it.

```
planner/timeline ──► events (film::Beat) ──► director ──► shot list (film::Shot)
                                                              │
      .brickmotion cameraTracks / sceneSetup ──► authored layer ┤ (merged: authored wins)
                                                              ▼
                     camera body (lens, fit, composition, avoidance, smoothing)
                                                              ▼
                film::Track — a camera per frame, for one aspect ratio
                                                              ▼
                          bmview · bmshot · bmexport (film::cameraAt)
```

The aspect ratio and lens enter at the body, not the director. The director decides *what* the
shot is (subject, size, angle, move), and the body decides *where the camera is* for a given
frame shape. One shot list therefore gives a 16:9 and a 9:16 film. The shot list does not depend
on the aspect ratio. The track does, and it is cheap to remake.

## Events (`film::Beat`)

An event is a time span with:

- a kind;
- the subject's *volumes over time* (boxes or point sets the body can query at any frame);
- an importance from 0 to 1.

The first kinds:

| Kind | Made from | Subject |
|---|---|---|
| `Flight` | each `plan::Flight` | the flying unit's box along its route; its seat box. Sub-spans: lift, cross, hover, seat (from `phases`, `seatAt`). |
| `UnitBuild` | a flight with sub-flights (`parent`/`depth`) | the unit's spot on the floor while it is built there. |
| `Step` | the plan's step boundaries | what the step adds. |
| `Growth` | built-so-far after each landing | the box of everything seated, frame by frame. Supports "lower as it grows" and "pull back before a tall part". |
| `Reveal` | the end of the build (and the intro if the style has one) | the finished model. |
| `Motion` | reserved for mechanisms (phase 4 kinematics) | the moving bodies' swept boxes. |

`film::beatsOf(const Timeline&, const Plan&, const Model&, const collide::World&)` makes them.
A future planner adds a kind or fills existing kinds, never camera code.

Importance comes from:

- the size of the unit relative to the model;
- a step's first piece;
- a sub-assembly flying in;
- the last pieces (details on the front);
- whether the piece changes the silhouette (the growth box's height or width jumps).

## Shot list (`film::Shot`)

The shot list is the data the editing design will work on, so it is plain and serialisable
(JSON beside `plan.json`).

```
Shot {
  id                       stable across re-runs where the shot is the same
  start, end               frames (seconds in the file, to survive re-pacing)
  subject                  Model | BuiltSoFar | Unit(spot) | Piece(flight) | Point(xyz) | Event(id)
  size                     Wide | Medium | Close | screen fraction 0..1 (how much of the frame height the subject fills)
  angle                    azimuth, elevation relative to the model's front; a side (left/right of the line)
  move                     Hold | Push(in/out) | Orbit(degrees, direction) | Crane(up/down) | Follow | Arc reveal
  lens                     mm (sensor in the body's settings)
  enter                    Cut | Blend(curve, frames)
  origin                   auto | user | track (from a saved camera track)
  pinned                   true: the director keeps it as is and fits its own shots around it
}
```

## The director

The director makes one pass over the events with look-ahead, and lays the shots down in this
order.

1. **Opening.** An establishing shot of the base (high, wide), at the style's opening elevation.
2. **Coverage.** The build is cut into *scenes*: a submodel built on its spot, a stretch of steps
   on one side of the model, a reveal. Each scene gets one main shot. The angle comes from where
   that scene's pieces land: the azimuth that sees most of their seats unoccluded, from a
   visibility test against the built-so-far geometry. The elevation descends with growth
   (opening to reveal elevation, as the reference study found).
3. **Anticipation.** A move toward the next scene's angle starts before its first piece leaves,
   by the move's length plus a lead. A tall addition triggers a pull-back and crane-down that
   finishes before the piece lands.
4. **Inserts.** A close shot for an important event is inserted only when its importance is
   above the style's threshold and the result passes the editing rules. Examples: a unit built
   on its spot, a sub-assembly snapping on, a sword sliding into its holder.
5. **Finish.** The style's finish: a cut, arc or whip to the model's front, then a hold.

### Editing rules (the checks every candidate shot passes)

- **Minimum shot length**: 1.5 s by default, scaled by the style.
- **Maximum cut rate**: at most one cut per 4 s on average over any 20 s window.
- **No jump cuts**: a cut changes the angle by at least 30° or the size by at least one class.
- **Same side**: no cut crosses the line of action of a flight in progress (the line between its
  spot and its seat), unless a neutral shot sits between them.
- **Lead room**: a followed piece has more frame ahead of it than behind.
- **Landings in frame**: the seat of every landing is inside the safe frame, with margin, from the
  start of its hover to its rest. Any failure is reported as a measured miss, not hidden.

### Styles

These are the web's names, each with its own rule set: Reference (BrickHeadz speed build),
Showcase, Turntable, Calm, Energetic and Overhead. **Reference** comes first. The others follow
in phase 3.

### The model's front

The front is taken from the project's saved front azimuth if it has one. Otherwise it is the LDraw
front (azimuth 0, the model seen from -z), as the web director does (`frontAzimuth()` in
`src/anim/cameraTrack/autoDirect.ts`). The web tried guessing the front from where pieces land and
it picked a caped figure's back, so no guess is made. The owner can override it.

## The authored layer

The authored layer reads `plan.cameraTracks[model].build` and `plan.sceneSetup.cameras` from
`.brickmotion`.

- **Conversion**: studs × 20 gives LDU. Native azimuth is the negative of the web's. Elevation is
  unchanged. Web targets `model`, `build` and `piece` map to subjects Model, BuiltSoFar and Piece.
  `lensMm` and `roll` map directly.
- **Web transitions**: curve, path (arc or straight), orbit direction, extra turns and cut become
  blends. Overshoot, shake and flow-through are also read, and the body honours them.
- **Keys whose origin is `user`** become pinned shots. The director fits its shots around them,
  with blends in and out that obey the editing rules where they can. Where they can't, the
  owner's key wins and a rule miss is reported.
- **Keys whose origin is `auto`** were made by the web's director. Owner's question: are they
  dropped (the native director replaces them) or kept as authored? See "Questions for the owner".
- **Which camera films the video**, as the web decides it (`videoCameraInCharge()` in
  `src/anim/cameraTrack/context.ts`):
  1. The saved camera track, when the project's `exportCamera` setting is `track` (the default)
     and the track has keys.
  2. Otherwise the active scene camera, when `useCameraForVideo` is on.
  3. Otherwise the native director.
- **Clock alignment.** A web key carries only a time on the web's own timeline, and native
  flights are shaped and timed differently. The project also saves the web's timeline (unit
  moves with their pieces), so each key is re-anchored by the landings around it:
  - its web time is placed between the two nearest web landings;
  - the same pieces' native landings give the native time, linearly between them;
  - keys before the first landing or after the last keep their offset from the start or the end.
- Every authored shot is filmed by the same body, so it gets the same lens fit, avoidance and
  smoothing.

## Camera body

The body turns a shot list (merged with the authored layer) and a frame shape (aspect ratio,
sensor) into a `film::Track` holding one `film::Frame` per frame:

```
eye, target, up (with roll), fovY, focus distance, aperture (blur), shutter, shot id, cut flag
```

For each shot, frame by frame:

1. **Lens.** `fovY` from the focal length in mm and the sensor (36 mm full frame by default),
   checked against the aspect ratio.
2. **Fit.** The shot asks for its subject to fill its size fraction of the safe frame. The body
   finds the distance along the shot's angle at which the subject's volume projects to that size
   in *this* aspect ratio. It fits the subject's points, not its box corners, for a tight fit.
3. **Composition.** The subject is placed by the shot's rule:
   - centred for holds;
   - lead room for follows;
   - headroom for the model.
4. **Avoidance.** The eye stays outside the built-so-far geometry and above the floor, with
   clearance. It also keeps a clear line to the subject. The tests are a sphere and a ray against
   `collide::World` restricted to pieces shown at that frame. When an eye fails, the body swings
   it along the shot's arc to the nearest clear spot, then pulls in or out. It does not jump.
5. **Smoothing.** The rig channels (target, azimuth, elevation, distance, roll, lens) are
   smoothed separately:
   - minimum-jerk easing inside a move;
   - a zero-phase pass over the whole track (forward and back), so reframing within a shot never
     jitters and never lags;
   - cuts reset the filter.

   This is approach C's idea, kept as a pass.
6. **Focus and shutter.** Focus is on the subject. The aperture comes from the shot's blur. The
   shutter comes from the style, and from move speed when the style asks for it. These values are
   stored in `film::Frame` only. The path tracer has no thin lens or shutter yet, and path tracing
   is paused by the owner, so using them is later work.

`film::cameraAt(const Track&, double frame)` interpolates between frames for bmview's fractional
playback and returns a `film::Frame`. `bmr::Camera` lives in the Metal library, so
`render/tools/common/engine.*` converts the frame to a `bmr::Camera`. `OrbitCamera::along` and `Timeline::camera` stay until every
caller has moved over, then they go.

## Where it runs

- **bm.** `bm film <file> [--aspect W:H] [--style S] [--out shots.json] [--report]` prints the
  shot list and the measured checks. `bm plan --json` includes the shot list.
- **bmshot and bmexport still.** `--frame N` uses the director's camera by default. An explicit
  camera (`--eye`/`--target`, `--azimuth`) still overrides it. `--size` sets the aspect ratio.
  bmshot gains `--strip N` to write a contact sheet of N frames for review.
- **bmview.** The camera follows the track while playing, as it does today with `timeline.camera`.
  The owner's drag still takes over (`_userMoved`). The track is made in the planning job, in the
  background.

ViewportView.mm has uncommitted work of the owner's. Any change there waits for the owner's word.

## Measurements (the gates)

Measurements are taken per model on the 19 owner projects and the corpus smoke tier:

- **Landings in frame**: the share of landings whose seat stays in the safe frame from hover to
  rest. The gate is 100% for the director's own shots on the 19 projects, and misses are listed.
  Where an owner's authored shot puts a landing out of frame, it is reported separately and does
  not count against the gate.
- **Inside geometry**: frames where the eye is inside a shown piece or below the floor. Gate: 0.
- **Smoothness**: the largest angular jerk and the largest frame-to-frame target jump within a
  shot. A gate is set from the first runs, and must not get worse.
- **Editing**: cuts per minute, the shortest shot, and jump-cut and line-crossing counts. Gates:
  the editing rules above.
- **Determinism**: 1 thread against 8 threads, and two runs, give bit-identical tracks.
- **Speed**: director plus body for a 16:9 track. Gate: under 5% of planning time on OMR p50, and
  under 1 s on the largest owner project.
- **By eye**: Deadpool and two others, in 16:9 and 9:16 contact sheets, set against today's
  orbit. The owner approves the look.

## Phases

1. **Engine.** Events, shot list, Reference style director, camera body, `bm film`, and bmshot and
   bmexport integration. Measurements and contact sheets.
2. **Authored layer.** Saved web tracks and scene cameras, pinned shots, the blend rules.
3. **Styles and mechanisms.** The other five styles, and `Motion` events from kinematics.
4. **Editing in bmview.** A separate design and its own mockup round with the owner.

## Constraints

- C++20, the engine's conventions (`tolerances.h` for every constant), Catch2 tests, and ASan
  and TSan clean.
- No new dependencies.
- Never stage the owner's uncommitted files.
- bmshot, bmexport, `shot_options.*` and `engine.*` may be changed for this work; they hold
  committed engine-tool code. Other work is editing some of these files and `timeline.*` at the
  same time (flight shapes), so each is re-read just before it is changed, and only this work's
  hunks are staged.
- `renderer.h`, `scene.h`, `renderer.mm`, `scene.cpp` and `ViewportView.mm` hold the owner's
  uncommitted work and are not touched. bmview playback uses the track through `AppDelegate`
  and the session, or waits for the owner's word.

## Builder's calls (decided by me, not the owner — flag if you disagree)

- The library is `bmfilm` in `native/film/`, not inside `bmcore` or `bmrender`. It needs
  collision (core) but must stay usable without Metal.
- The shot list stores times in seconds, so a re-paced build keeps the shots. Events are
  re-matched by flight and step, so a re-planned build keeps pinned shots near their events.
- Default framing keeps the waiting floor *out* of the shot. Pieces fly in from outside the frame,
  as in the web's reference study. The floor is in frame only in the establishing shot and while a
  unit is built on its spot.
- The minimum shot length is 1.5 s, the maximum cut rate is one per 4 s, and the jump-cut
  threshold is 30° or one size class. These are standard editing conventions, tuned by the
  measurements.
- The default lens is 50 mm on a 36 mm sensor. The Reference style sets its own, and the owner's
  track overrides it.

## Owner's decisions

- **Saved camera tracks film the video by default** (owner, 2026-11-19). The 10 projects that
  have one are filmed by it, following the web's rule. The director films everything else and
  every project without a track. `--camera director` shows the director's version of a project
  that has a track.

## Left to the builder

- How visibility is tested for the coverage angle (ray counts, which pieces).
- The importance weights.
- The exact smoothing filter, as long as the smoothness gate is met.
- The JSON field names.
