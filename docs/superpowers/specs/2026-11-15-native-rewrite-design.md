# BrickMotion Studio native rewrite — design

Date: 2026-11-15. Revision 2 (engine redesigned as new, not ported). Status: awaiting approval.

## Intent

Rebuild BrickMotion Studio as a native Mac app around an **entirely new engine**. The
current engine fails in three ways the owner named:

1. it does not recognise many joints;
2. it often plans the build animation wrongly;
3. planning takes too long.

Rendering is also too slow, and the interface should reach Apple pro-app quality.

Decided by the owner:

- Rewrite from scratch; engine and renderer in C++.
- Approach A: C++ engine, Metal renderer, SwiftUI/AppKit interface. Mac only.
- Collisions, joints, studs, SNOT, physics, kinematics, mechanisms, animation and the
  planners are **redesigned, not translated**.
- The owner's sets, datasets and OMR data are there to build and prove the new engine.

Everything else is the designer's call, marked **(call)** where the owner may want to
overturn it.

## What exists today, and why it fails

A Vite/React/TypeScript web app, about 80,000 lines plus 25,000 lines of tests.
Findings that explain the three failures:

- **Joints.** Connectors come in six types (`stud, pin, bar, hinge, knuckle, ball`),
  derived mostly from the LDCad shadow library. There is no axle, no gear tooth, no
  click hinge, no rail, no pin-friction distinction. BrickLink Studio's connectivity
  files (~9,200 parts) are decoded for studs and anti-studs only. BrickNet's joint
  labels are used for knuckles and balls only. A minifig's 8 parts come out as 8 groups.
- **Mechanisms.** Motion is recognised by pattern classifiers layered over five
  versions (v4–v8), with reviewed special cases per set (e.g. 5590 surfaces). What no
  pattern covers does not move: 8880's gearbox scores 5/7, 42000's actuators 0/2.
- **Planning.** A single-threaded backward-removal search in JavaScript with hard
  budgets (2,000 states, 20 s). When the budget runs out the plan fails or falls back.
  Three separate collision implementations disagree at the edges, and the connection
  data the planner trusts is the same incomplete data as above.

So the root cause of (1) and much of (2) is the same: **incomplete, inconsistent
connection data, consumed by code that pattern-matches instead of solving.**

## Goals

1. **Joints:** every piece of every official model in the corpus is joined to the
   model by a recognised connection, with the right freedom of movement.
2. **Planning correctness:** a build animation never passes a piece through another,
   never leaves a piece floating, and inserts along the way the connection allows.
   When the engine cannot prove a move, it says so on that piece; it never plays a
   wrong move silently.
3. **Planning speed:** at least 10× faster than the web app on the reference models,
   and interactive (under 1 s) re-planning after an edit. **(call)**
4. **Mechanisms from first principles:** movement is solved from the joints, so a
   mechanism nobody wrote a pattern for still moves correctly.
5. **Viewport** at 120 fps on a 12,000-part model (Sagrada 21065) on an M1 Pro. **(call)**
6. Path-traced stills and video with Metal hardware ray tracing and native denoising.
7. An interface that behaves like a first-party Mac pro app.
8. Existing projects open in the new app.

Speed figures are targets; phase 0 measures the web app and restates them.

**Measured baseline (2026-11-16, full corpus, default planner, 180 s limit):** on the OMR sets the web
app plans in a median of 8.5 s and a 95th percentile of 92.8 s, times out on 178 of 1,833 files, and
places 23.2% of pieces joined to nothing; on the reference sets the median is 97 s and 3 of 6 time out.
Goal 3 restated against that: a median under 1 s and a 95th percentile under 10 s on the OMR sets, no
time-outs, and every reference set planned.

Goal 5 measured (2026-11-17, phase 6): no complete Sagrada 21065 file exists, so the scene is 10030-1
repeated 2×2 (12,148 pieces) at 1920×1200 on an M1 Pro. Orbiting with nothing moving, the 95th percentile
frame is 7.2 to 8.6 ms (120 fps is 8.33 ms; met in two of three runs on a loaded machine); while a build
plays, 11.4 to 13.3 ms (about 80 fps). See `native/README.md`, "Phase 6 results".

## Non-goals

- Windows, Linux, iPad, web.
- Matching the old engine's outputs. It is a baseline to beat, not a reference.
- Free rigid-body dynamics (pieces falling, bouncing, friction slip) in the first
  engine. **(call)** "Physics" in version one means stability and driven-mechanism
  simulation (below). The body/joint model is built so a dynamics stepper can be added.
- The Python pipelines (booklet solver, classifiers, CoordNet, neural-shade training,
  Brick Lab). They keep reading and writing the same files.
- Dev-only pages; neural shade in the viewport **(call)**.

## Anti-goals

- Per-set special cases in engine code. If a set needs a fix, the fix goes into the
  connector data or a general rule, and the corpus proves it did not break others.
- Search budgets that silently turn into wrong animations.
- Breaking the web app before the native app replaces it.

## Approaches considered

**Application stack** (owner chose A):

| | A. Native Mac | B. All-C++ with Qt | C. C++→WASM, keep web UI |
|---|---|---|---|
| Interface | SwiftUI/AppKit | Qt Quick | existing React |
| Planning | native threads | native threads | ~half native |
| Rendering | direct Metal, hardware RT | good | browser-bound |

**Engine** (designer's call):

| | 1. Port the current engine | 2. General physics engine (Jolt/Bullet) at the centre | 3. New connector-first engine |
|---|---|---|---|
| Joints | same gaps | must still be supplied | one database from all data sources |
| Mechanisms | patterns v4–v8 | simulated, but drifts; poor at exact gear ratios and tight fits | solved exactly from joints |
| Planning | same search, faster | no help | new, graph-driven, parallel |
| Risk | lowest, keeps the faults | tolerance tuning forever | most new design |

**3 is chosen.** 1 is ruled out by the owner. 2 solves the wrong problem: brick models
are exact, zero-clearance assemblies, which general rigid-body solvers handle badly,
and they give nothing for joint recognition or assembly planning. A general solver may
still be embedded later for free dynamics.

## Architecture

```
BrickMotion.app  (Swift: SwiftUI + AppKit)
        │  C interface (bm_*.h): handles, plain structs, callbacks
bmrender         (C++ / Objective-C++, Metal)
        │
bmcore           (portable C++20, no Apple headers)   + `bm` command-line tool
```

- **bmcore** owns all document state, undo, and all engine work. Every feature runs
  from the `bm` CLI, with no UI.
- **bmrender** draws a `bmcore` scene; never mutates it.
- **The app** holds no model logic.
- **Swift ↔ C++: a plain C interface. (call)**

## The new engine

Five layers. Each consumes only the layers above it in this list, so there is exactly
one answer to "are these two pieces joined, and how?".

### 1. Connector database

One compiled database for all parts: every connection feature of every part, as a
typed feature with a full 3D frame.

- **Types:** stud / anti-stud (incl. hollow, recessed, jumper offsets), stud-tube
  friction, Technic pin (friction and free) / pin hole, axle / axle hole, bar / bar
  hole, clip, ball / socket, tow ball, finger hinge, click hinge, plate hinge,
  turntable, gear teeth (spur, bevel, crown, worm, rack), rail / slide, wheel / tyre
  seat, flex-part ends, and flat surface contact.
- **SNOT is not a special case.** A connector is a frame in space; a sideways or
  upside-down stud is the same feature in another frame. Nothing in the engine
  assumes a world grid or an up direction for connection.
- **Sources, merged with provenance and confidence:** the LDCad shadow library;
  BrickLink Studio connectivity files (decoded in full, not studs only); BrickNet joint
  labels; Kinebrick connections and corrections; the existing generated tables
  (`studioConnectors`, `bricknetConnectors`, `wheelSeats`, `flexibleParts`,
  `part-functions`); and **geometric detection** on the part mesh (cylinders, holes,
  cross-axle profiles, bars, spheres, tooth counts) for parts no source covers.
- **Compiled offline** by `bm connectors build` into one binary file. Conflicts
  between sources are reported, not silently resolved; a small reviewed override file
  settles them.
- **Mating rules** are a table over types: which pairs mate, the tolerance, and the
  joint each pair makes.

### 2. Connection graph and joints

- Finds every mated connector pair in a model with a spatial hash; each mate carries
  the **joint it creates**: fixed, revolute, prismatic, cylindrical, spherical, or a
  coupling (gear ratio, rack, worm, differential).
- Several mates between the same two pieces combine: two studs make a fixed joint;
  one stud makes a revolute joint with friction; a pin through two beams is revolute;
  an axle in an axle hole is fixed in rotation and free to slide until stopped.
- **Rigid bodies** are the groups of pieces joined by fixed joints. Everything
  downstream — kinematics, stability, subassemblies for the planner — works on bodies.
- Unjoined and under-joined pieces are reported with the nearest near-miss, which is
  also what the connector database learns from.

### 3. Collision

One implementation: exact part meshes, per-part BVH cached with the part, a scene BVH
over instances, SIMD triangle tests, and continuous (swept) tests for motion.

- **Mated connectors are allowed to interpenetrate by rule**: the volumes of a mated
  pair are excluded from the test, which replaces the current tolerated-fit and
  reviewed-surface exceptions with one mechanism derived from layer 2.
- Gives clearance distance as well as yes/no, which kinematics and the planner use.

### 4. Kinematics, mechanisms, physics

- **Solver, not classifier.** Bodies and joints form a constraint system. Freedom of
  movement comes from the rank of its constraint Jacobian; motion comes from driving
  one joint and solving the rest (Newton iterations on loop closures, exact ratios
  through couplings). Works for closed loops (linkages, steering) and gear trains.
- **Limits** come from collision: a joint's range ends where bodies touch.
- **Recognition on top:** named mechanisms (gearbox, differential, steering, piston
  engine, linear actuator, suspension) are read off the solved graph to label things
  in the interface and to choose sensible drivers. Naming never decides whether
  something moves.
- **Stability:** static check of a model or a build step — does it tip, does every
  piece have a load path, do stud connections carry the load (linear program over
  connection forces). Used by the planner to avoid steps that would fall over.
- **Driven simulation:** time-stepped playback of mechanisms (motors, cranks, shifts)
  with collision limits. Free dynamics is out of scope for version one (see non-goals).

### 5. Assembly planner and animation

- **Assembly by disassembly over the connection graph.** A piece or subassembly can be
  removed if its joints release along some direction and the swept move is
  collision-free. Removal directions come from the connectors' own axes first (a pin
  slides out along its hole, a stud lifts off along its axis, a clip unsnaps
  sideways), which is what makes insertion look right.
- **Subassemblies come from the graph** (bodies, mechanisms, authored submodels,
  booklet steps), not from heuristics on names.
- **Authoring wins:** steps in the file, pinned order and hand-set insertion paths are
  constraints the planner works within.
- **Build order is the planner's own.** It does not have to follow the official set
  order (owner's decision). The order is chosen to satisfy the hard rules below; among
  valid orders it prefers bottom-up, inside-out, and finishing a subassembly before
  moving on.
- **Hard rules for every build (owner's requirements):**
  1. **No floating pieces.** A piece is only placed when it joins something already
     built (or is the first piece of a subassembly that is itself built on the floor
     and then attached). At every moment of the build, everything placed is connected.
  2. **No piece passes through another**, at any point of its flight, checked by swept
     collision on the exact meshes.
  3. **Each connection goes in the way it really does**, taken from its connector:
     a pin slides along its hole; an axle along its axis; a wheel onto its axle or
     pin along that axis; a tyre over its rim; a clip snaps on sideways across the
     bar; a bar or accessory slides into a hand along the grip; a sword slides into
     its holder blade-first along the slot; a stud presses on along the stud axis,
     including sideways and upside-down studs; a hinge half meets its mate along the
     hinge pin; a ball pushes into its socket along the socket's opening.
  4. When a piece has several connections, the insertion direction must satisfy all
     of them at once; if none does, the pieces are grouped into a subassembly that
     can go in together.
- **Parallel and incremental:** candidates are independent and fan out across cores;
  results are cached by content hash, so an edit re-plans only what it touches.
- **Any-time, never wrong:** the planner always returns a plan in which every move is
  either certified collision-free or explicitly flagged for the author. No fallback
  that drops the certification.
- **Animation** is generated from the plan: flight paths, easing, pacing, staging on
  the floor, camera tracks. The timeline data model stays compatible with the plan
  file format.

## Proving it: the corpus scoreboard

The engine is built against data, and one command says how good it is.

`bm audit <corpus>` runs every model and reports:

| Measure | Meaning |
|---|---|
| joined % | pieces attached to the model by a recognised connection |
| overlap / floating | pieces intersecting illegally or resting on nothing |
| joint agreement | joints that match BrickNet's labels and Kinebrick's connections |
| mechanism truth | degrees of freedom and gear ratios vs a hand-checked truth file |
| plan success % | models planned with every move certified |
| build floating | moves that place a piece joined to nothing already built (must be 0) |
| build crossings | moves whose flight passes through another piece (must be 0) |
| insertion truth | moves whose direction matches the connector's own axis, plus a hand-checked list of cases: pins, wheels, clips, hands, swords in holders |
| plan time | per model and per piece |

Corpus on this machine:

- OMR: 1,471 official set files (`BrickMotion-Data/omr`).
- BrickNet: 67,185 models with joint labels.
- Reference sets with known mechanisms: 5590, 8880, 10156, 42000, the helicopter,
  Sagrada 21065 (scale), the BrickHeadz set.
- The existing test fixtures. The 25,000 lines of vitest tests are mined for
  **scenarios whose expected result is physical truth** (a pin in a hole turns); tests
  that pin old outputs are not carried over.

**Baseline first:** phase 0 runs the *current* engine over the same corpus, so every
later number is "new vs old", and the three failures become three measured columns.
The mechanism truth file starts small and is the owner's to grow.

## bmrender

- Raster viewport: instanced draws per (part, material), GPU culling, PBR brick
  materials and looks, bevels, AO, contact shadows, HDRI, depth of field, motion blur,
  selection, gizmos and overlays.
- Path tracer: one Metal implementation replacing `three-gpu-pathtracer` and ThreeRT;
  part acceleration structures cached; OIDN denoise. Looks matched by eye against the
  EyeSight calibration set, not pixel for pixel. **(call)**
- Export: stills, frame sequences, video (AVFoundation/VideoToolbox), audio mix
  (AVAudioEngine).

## The app

Document-based (`.brickmotion` package), system autosave and versions. Main window:

```
┌───────────────────────────────────────────────────────────────┐
│ ● ● ●   Projects ▾  Title        ⌘K      ↶ ↷   ▶ Preview  Export │
├────┬──────────────┬───────────────────────────┬───────────────┤
│ ▣  │ Models       │                           │ Inspector     │
│ ▤  │ ├ main       │        Metal viewport     │ Selection     │
│ ⚙  │ │ └ chassis  │                           │ Part · Joints │
│ ▶  │ Parts        │   ⤢ tools      nav gizmo  │ Motion        │
├────┴──────────────┴───────────────────────────┴───────────────┤
│ Build │ Timeline │ Motion        ◀ ▶  00:12.4   tracks…        │
└───────────────────────────────────────────────────────────────┘
```

The layout keeps today's regions. New because of the new engine: joints and
mechanisms are visible and editable (show a piece's connections, see why a piece is
unjoined, drive a mechanism by dragging), and flagged planner moves appear in the
timeline. The visual design **gets its own design pass with mockups and owner
sign-off before interface code**. Viewport and timelines are AppKit/Metal views;
forms and lists are SwiftUI. **(call)**

## Data and migration

- **Plan file schema is kept** so existing projects, the Python tools and the web app
  keep working. Fields the new engine adds (joints overrides, flagged moves) are
  additive.
- Projects stored only in a browser's IndexedDB are exported once from the web app
  ("export all" added there).
- Part library and data are read from `public/ldraw` and `public/data` during
  development; the shipped app keeps them in Application Support beside the compiled
  connector database and binary part cache.

## Phases

Each ends in something runnable and is planned in detail when it starts.

| # | Phase | Ends with |
|---|---|---|
| 0 | Corpus, scoreboard format, baseline of the current engine | measured columns for joints, plan success, plan time; targets restated |
| 1 | Core: math, LDraw, part cache, model/plan files, jobs, `bm` CLI | CLI loads the whole corpus and round-trips files |
| 2 | Connector database and connection graph | `bm audit` joined % and joint agreement, vs baseline |
| 3 | Collision | overlap/floating columns; swept tests; speed measured |
| 4 | Kinematics, mechanisms, stability | mechanism truth column; 8880 and 42000 cases pass |
| 5 | Planner and animation timeline | plan success and plan time columns, vs baseline |
| 6 | Metal viewport | window showing a model, playback at target frame rate |
| 7 | Path tracer, denoise, video/audio export | CLI renders stills and video |
| — | Interface design pass | approved visual design |
| 8 | App shell: documents, browser, inspector, editing, timelines | daily-usable editor |
| 9 | Remaining panels: staging, materials, scene, camera, checks, mechanism lab, sound, export | replaces the web app |
| 10 | Extras: AI, generate, suggest, remix, bricksafe, instructions | decided per feature |

Phases 6–7 can overlap 2–5 once phase 1 lands.

## Constraints

- Lives in `native/` inside this repository. **(call)**
- macOS 15+, Apple silicon only **(call)**; C++20; CMake for libraries and tests, an
  Xcode project for the app.
- Third-party code kept small: a test framework, JSON, zip, an LP solver for
  stability, OIDN. No Qt, no Boost, no general physics engine in version one.
- Toolchain on hand: Xcode 26.5, CMake 4.2, Swift 6.3, M1 Pro, 16 GB, tight disk.

## Risks

- **Size.** A new engine plus a renderer plus an app is many months across many
  sessions. Value arrives early by design: the scoreboard (phase 0), joints (phase 2)
  and planning (phase 5) are usable from the CLI long before the app exists.
- **New design can be worse at first.** The old engine has years of reviewed cases.
  The baseline columns make any regression visible per model.
- **Data licences.** OMR is CC BY (attribution kept). Kinebrick data is CC BY-SA.
  BrickNet's terms for redistribution are unknown; BrickLink Studio's connectivity
  files are BrickLink's. Building and testing locally with them is one thing; **what
  may ship inside a distributed app must be settled by the owner before release.**
  The database records each connector's source so a shippable subset can be cut.
- **Geometric detection** of connectors will produce false positives; it is the
  lowest-confidence source and is gated by the corpus.
- **Path-tracer look** will need a calibration round.
- **Two apps for a while.**

## Left to the builder

Internal class layout, file and binary formats, the mating-rule table's exact
contents, solver numerics, BVH details, library choices, the C interface's shape,
shader structure, and how the Xcode project consumes the CMake targets.
