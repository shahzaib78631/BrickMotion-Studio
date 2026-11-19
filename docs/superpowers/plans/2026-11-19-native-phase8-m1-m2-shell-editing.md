# Native Phase 8, Milestones 1–2: app skeleton and editing core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Mac app, `BrickMotion.app`, that opens any model the engine reads as a document, shows it in the Metal viewport, and lets the owner select, move, rotate, recolour, duplicate, delete, copy and paste pieces with unlimited undo, then save a `.brickmotion` file the web app opens.

**Architecture:** Three layers. The engine (`bmcore`, `bmrender`, `bmfilm`) gains an editable, hierarchical document (`bm::doc`) and a renderer that follows edits. A new C++ library, `bmapp`, is the only thing Swift sees: a session per document, a command log, and immutable snapshots. The app is AppKit `NSDocument` + `NSSplitViewController`, with SwiftUI inside the sidebar and inspector, and an AppKit `NSView` hosting the Metal viewport. Everything builds with CMake + Ninja, Swift included.

**Tech Stack:** C++20, Swift 6.3 with C++ interop (`-cxx-interoperability-mode=default`), SwiftUI, AppKit, Metal, CMake 4.2 + Ninja, Catch2 3.7, nlohmann/json.

**Spec:** `docs/superpowers/specs/2026-11-19-native-phase8-app-shell-design.md`. The acceptance rows are in `docs/superpowers/specs/2026-11-19-native-app-parity.md`.

**Scope of this plan:** design Milestones 1 (skeleton) and 2 (editing core). The design's later milestones get their own plans when this one runs:
- 3: browser, inspector, the ⌘K palette, the welcome window, Settings, part drag-in with connector snapping, and step and submodel editing;
- 4: timelines and incremental re-planning;
- 5: polish and the measured gates.

## Global Constraints

- macOS 26 minimum; arm64 only; Xcode 26.5 / Swift 6.3 toolchain. Set `CMAKE_OSX_DEPLOYMENT_TARGET` to `26.0` **for the app target only**. The rest of the engine keeps 15.0.
- **Paths that are not ours.** Never edit, stage or revert these: `native/render/tools/bmview/*`, `native/core/include/bm/plan/timeline.h`, `native/core/src/plan/timeline.cpp`, `native/core/*/plan/legacy*`, `native/film/src/director.cpp`, `native/film/tests/director_test.cpp`, `native/render/tools/common/*`, `native/tests/plan_test.cpp`, `native/tools/bm/cmd_plan.cpp`. Other sessions have uncommitted work there.
- **Committing.** Stage only the files this plan names, by path. Never use `git add -A` or `git add .`. Run `git status --short` before each commit.
- **Branch.** Commit per task on the current branch. Never switch, create or move branches.
- **Plan schema.** The file schema is kept. Native saves must open in the web app: `.brickmotion` stays a single JSON file (`"format": "brickmotion-project"`, `"version": 1`, the plan under `"plan"`).
  - Fields the engine does not know survive a read and write unchanged, key order included.
  - A placement that fits the grid keeps the grid form (`x`, `y`, `z`, `rot`). Any other is written as `ldu` + `matrix`, a form the web already reads (`src/io/ldrawImport.ts:16`).
- **Imports.** Opening `.ldr`, `.mpd`, `.dat`, `.json` (plan) or `.io` makes an **untitled** project. ⌘S then asks where to save it and never writes over the source.
- **Shared submodels.** Editing a piece inside a submodel edits the submodel, so every use changes. **Make Unique** forks one use.
- **Undo** spans saves while the document is open, and is not written to the file.
- **Hiding** is view state. It is not a command, not undoable and not saved.
- **Engine rules.** No ported web logic, and no web bugs reproduced (spec "Anti-goals").
- **C++ style.** Our own C++ builds with `-Wall -Wextra -Werror` (link `bm_warnings`).
- **Tests.** `ctest --test-dir native/build` (engine) and `ctest --test-dir native/build-app` (engine + app, `-DBM_APP=ON`) both pass after every task, with `BM_LDRAW_DIR=$PWD/public/ldraw` set from the repo root. Engine-only tasks (5, 6, 8) are run in both.
- **What Swift sees.** Swift includes **only** `bmapp/*.h`. Those headers use plain structs, enums, `std::string`, `std::vector`, integer ids and `void*` for Apple objects. They use no templates of our own, no `std::function`, and no `bm::`/`bmr::` headers.

## Review Focus

These are the cases most likely to bite a real user that no feature test hits by accident. Each has a test in the task named.

1. **A model with missing parts or unknown colours.** It opens, its placeholders can be selected and edited, and saving keeps the unknown names verbatim. Test: Task 5 `source keeps unknown part and colour names`.
2. **Editing a piece inside a submodel used twice.** Both uses move, and undo restores both exactly. Test: Task 7 `move inside a shared submodel moves every use, undo restores`.
3. **A web project with timelines, camera tracks and fields the engine doesn't know.** Re-saved unedited, it is identical as JSON. Edited, only the edited items change. Test: Task 6 `project round trip keeps every other field`.
4. **Editing the largest model.** `10030-1` ×4, 12,148 pieces: one move or recolour reaches the screen within a frame and does not rebuild the scene. Test: Task 8 `move updates only that instance`; measured in Task 13.
5. **Opening an LDraw file and pressing ⌘S.** It saves as a new project and leaves the `.ldr` byte-for-byte unchanged. Test: Task 12 `import opens untitled, source untouched`.

---

## File structure

```
native/core/include/bm/doc/source.h      editable hierarchical document (defs, steps, items)
native/core/src/doc/source.cpp           Source <-> PlanDoc, LDraw import, flatten + piece map
native/core/include/bm/doc/write.h       project (.brickmotion) and MPD writers
native/core/src/doc/write.cpp
native/tests/doc_source_test.cpp
native/tests/doc_write_test.cpp
native/render/include/bmr/renderer.h     + Renderer::modelChanged (modify)
native/render/src/metal/renderer.mm      (modify)
native/render/tests/renderer_edit_test.mm
native/app/CMakeLists.txt                bmapp library, bmapp_tests, BrickMotion.app
native/app/bmapp/include/bmapp/types.h   ids, Vec3, Placement, Snapshot rows (Swift-visible)
native/app/bmapp/include/bmapp/session.h Session: open, commands, undo, selection, save
native/app/bmapp/include/bmapp/viewport.h Viewport: renderer, camera, pick, marquee, gizmo maths
native/app/bmapp/include/module.modulemap
native/app/bmapp/src/session.cpp, commands.cpp, commands.h, viewport.mm, gizmo.cpp, keys.cpp
native/app/bmapp/tests/*_test.cpp
native/app/BrickMotion/Info.plist.in     document types, UTIs
native/app/BrickMotion/*.swift           App, Document, WindowController, ViewportView, Inspector stub, Snapshot export
```

---

## Milestone 1: skeleton

### Task 1: Build Swift with C++ interop under CMake, and add a bmapp session that opens a file

**Files:**
- Modify: `native/CMakeLists.txt`: add `option(BM_APP "Build BrickMotion.app (needs Swift)" OFF)` and, after `render`, `if(BM_APP) add_subdirectory(app) endif()`. The app is built in its own tree, `cmake -S native -B native/build-app -G Ninja -DBM_APP=ON`, so a broken Swift target never breaks `native/build`, which other sessions use.
- Create:
  - `native/app/CMakeLists.txt`
  - `native/app/bmapp/include/bmapp/types.h`, `session.h`, `module.modulemap`
  - `native/app/bmapp/src/session.cpp`
  - `native/app/bmapp/tests/session_test.cpp`
  - `native/app/BrickMotion/main.swift`
- Test: `native/app/bmapp/tests/session_test.cpp`

**Interfaces:**
- Consumes:
  - `bm::io::load`, `bm::ldraw::Library`, `bm::ldraw::PartCache`;
  - `bmtools::ldrawDir()` (link `bmtools_common`; do not edit it).
- Produces:

```cpp
namespace bmapp {
struct OpenResult { bool ok; std::string error; std::string warnings; };  // warnings: missing parts, loops, unknown colours, one per line
class Session {
 public:
  static std::string ldrawDirectory();                 // bmtools::ldrawDir()
  OpenResult open(const std::string& path);            // any format bm::io::load reads
  size_t pieceCount() const;
  std::string title() const;                           // file name without extension
  bool imported() const;                               // true unless the file was a .brickmotion project
  Session(); ~Session();                               // pimpl: struct Impl; std::unique_ptr<Impl>
};
}
// types.h holds every plain type later tasks put in Swift-visible headers:
// struct Vec2 { double x, y; }; struct Vec3 { double x, y, z; }; struct Mat3 { double m[9]; };  // row-major
// enum class ViewPreset { Front, Back, Right, Left, Top, Bottom };
// enum class PlanState { Idle, Planning, Ready, Failed };
// enum class SelectMode { Replace, Add, Toggle }; enum class Arrow { Left, Right, Up, Down };
```

- [ ] **Step 1: Write the failing test** `open reads the helicopter and reports nothing missing`.
  - Open `native/corpus/` helicopter (or the fixture `tests/fixtures` model of your choice that `io_test.cpp` already uses).
  - Assert `ok`, a `pieceCount()` equal to `bm::io::load(...).pieces().size()`, and `imported()` true for `.ldr`/`.mpd`, false for `.brickmotion`.
  - Also test `open fails with a sentence` on a missing path: `ok == false` and a non-empty `error`.
- [ ] **Step 2:** Run `cmake --build native/build && ctest --test-dir native/build -R bmapp`. Expected: FAIL (target missing).
- [ ] **Step 3: Implement.**
  - **`native/app/CMakeLists.txt`:**
    - `enable_language(Swift)`;
    - `add_library(bmapp STATIC ...)` linking `bmcore bmrender bmfilm bmtools_common bm_warnings`;
    - `bmapp_tests` with Catch2, `catch_discover_tests`;
    - an executable `BrickMotion` (`MACOSX_BUNDLE`, Swift sources) with these Swift flags: `-cxx-interoperability-mode=default`, `-Xcc -std=c++20`, `-I bmapp/include`;
    - link `bmapp` and the frameworks AppKit, Metal, QuartzCore, SwiftUI;
    - set `XCODE_ATTRIBUTE`-free properties `OSX_DEPLOYMENT_TARGET 26.0`.
  - **`module.modulemap`:** `module BMApp { header "bmapp/session.h" header "bmapp/types.h" requires cplusplus export * }`.
  - **`main.swift`:**
    - `import BMApp`;
    - with `--version` it prints `BrickMotion <bm version>` and exits 0;
    - with `--open <path>` it prints `pieces <n>`, using `bmapp.Session`, and exits 0;
    - with `--selftest-bridge <path>` it proves the shape the app will use, and exits 0 only if all of it works:
      - a Swift `final class` holds a `bmapp.Session` for its whole life;
      - `bmapp.Viewport(session)` is made against that same session (its address must not change);
      - a `std.vector<UInt32>` goes in, and a struct of vectors and strings comes back.
    - `ctest` runs `--selftest-bridge` (add it with `add_test`).
  - **Fallback**, if Swift cannot hold a non-movable C++ type in a class: make `Session` and `Viewport` C++ reference types (`SWIFT_SHARED_REFERENCE` with retain and release functions over an intrusive count). If that also fails, use an Objective-C++ facade over the same headers. Write the choice in the commit message.
- [ ] **Step 4:** Run the build and tests in `native/build-app`. Expected: `bmapp` tests and `--selftest-bridge` PASS. Then run `native/build/app/BrickMotion.app/Contents/MacOS/BrickMotion --open public/…/helicopter.ldr`, which prints `pieces 305`.
- [ ] **Step 5: Commit.** Message: `feat(app): BrickMotion.app builds Swift over bmapp; a session opens any model`.

If Swift's C++ interop rejects a header, the fix is in `bmapp` headers (simpler types). Never in engine headers.

### Task 2: Document, window and split view

**Files:**
- Create in `native/app/BrickMotion/`:
  - `AppDelegate.swift`
  - `Document.swift`
  - `DocumentController.swift`
  - `WindowController.swift`
  - `Placeholders.swift` (sidebar and inspector stubs)
  - `Info.plist.in`
- Modify: `native/app/CMakeLists.txt`, `main.swift`.
- Test: `native/app/bmapp/tests/session_test.cpp` (a data round trip is in Task 12; here, the type table).

**Interfaces:**
- Consumes: `bmapp::Session::open`, `imported()`, `title()`.
- Produces:
  - Swift `final class Document: NSDocument` owning one `bmapp.Session`;
  - `WindowController` with an `NSSplitViewController` of three items:
    - `NSSplitViewItem(sidebarWithViewController:)`;
    - the content item;
    - `NSSplitViewItem(inspectorWithViewController:)`;
  - an `NSToolbar` with `.toggleSidebar`, a `Build | Animate` `NSToolbarItemGroup` (segmented, selection-only in this milestone), `.flexibleSpace`, `.toggleInspector`;
  - `C++: std::vector<std::string> bmapp::documentTypes()` returns the UTI list used to fill the Info.plist and by `DocumentController`.

- [ ] **Step 1: Write the failing test** `document types list project then imports`. Assert `documentTypes()` is exactly:
  - `{"com.brickmotion.project", "com.brickmotion.plan", "com.ldraw.model", "com.ldraw.mpd", "com.ldraw.part", "com.stud.io"}`;
  - with extensions `brickmotion`, `json`, `ldr`, `mpd`, `dat`, `io`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Info.plist:**
    - `CFBundleDocumentTypes`: the project type `Editor`/`Owner`; the rest `Viewer`, which is the import role;
    - `UTExportedTypeDeclarations` for `com.brickmotion.project` (conforms to `public.json`);
    - `UTImportedTypeDeclarations` for the others.
  - **`DocumentController.openDocument(withContentsOf:display:)`:** for a non-project type, it makes an untitled `Document`, reads the file into it through `Session.open`, sets `fileURL = nil` and `displayName = title()`, and marks it edited (`updateChangeCount(.changeDone)`) so a close asks to save.
  - **`Document`:** `autosavesInPlace = true`; `makeWindowControllers` adds `WindowController`.
  - **Window:** minimum content size 900×600, `.fullSizeContentView`, `titlebarAppearsTransparent = false`, `toolbarStyle = .unified`.
  - **Placeholders:** SwiftUI views with a `List` titled "Models" and a `Form` titled "Inspector", hosted in `NSHostingController`.
- [ ] **Step 4:** Run the tests. Then open the app by hand on the helicopter with `open -a native/build/app/BrickMotion.app <file>`. Expected:
  - a window with sidebar, empty centre and inspector;
  - the title shows the model name;
  - ⌘W asks to save.
- [ ] **Step 5: Commit.** Message: `feat(app): documents, imports open untitled, three-pane window`.

### Task 3: Viewport in the window, with orbit, pan, zoom, trackpad gestures and build playback

**Files:**
- Create:
  - `native/app/bmapp/include/bmapp/viewport.h`
  - `native/app/bmapp/src/viewport.mm` (ObjC++ only inside bmapp)
  - `native/app/BrickMotion/ViewportView.swift`
  - `native/app/bmapp/tests/viewport_test.mm`
- Modify: `native/app/BrickMotion/WindowController.swift` (the content item becomes the viewport).

**Interfaces:**
- Consumes:
  - `bmr::Renderer::create/resize/draw/pick/select/setFrame/setRest`;
  - `bmr::Camera`;
  - `bmtools::planModel`, `bmtools::keysFromTrack`.
- Produces:

```cpp
namespace bmapp {
struct CameraState { double yaw, pitch, distance; Vec3 target; bool orthographic; };
class Viewport {
 public:
  explicit Viewport(Session& session);          // creates the renderer for the session's model; ok() false if no GPU
  bool ok() const;
  void resize(int pixelsWide, int pixelsHigh, double backingScale);
  bool draw(void* metalDrawable);               // true if another frame is wanted (settling or playing)
  void orbit(double dxPoints, double dyPoints); // drag: 0.5 degree per point; pitch clamped to (-89, 89)
  void pan(double dxPoints, double dyPoints);   // moves target in the view plane, 1 point = 1 pixel at target depth
  void zoom(double factor);                     // distance /= factor, clamped to [1 LDU, 50 x model size]
  void rotateGesture(double degrees);           // trackpad rotate turns yaw
  void fitAll(); void view(ViewPreset preset);  // ViewPreset: Front, Back, Right, Left, Top, Bottom (spec parity §4)
  CameraState camera() const;
  // playback: planning runs on the engine's job pool when first asked
  void play(bool on); bool playing() const; double seconds() const; double length() const; void seek(double s);
  PlanState planState() const;                  // Idle, Planning, Ready, Failed (+ error text via planError())
};
}
```

- **Planning never reads the live model.** A plan job takes its own copy (`std::shared_ptr<const bm::Model>`) and the session version it was made from. Its result is used only if that version is still current. Any command cancels a running job (`bm::CancelToken`), stops playback and puts the renderer back at rest. The next Space plans again. Milestone 4 makes this incremental.

- [ ] **Step 1: Write the failing tests** (headless Metal, as `bmrender_tests` already runs):
  - `fitAll frames the model`: after `fitAll()`, `resize(800, 600, 1)` and `draw(nullptr)`, the readback's non-background pixel box touches neither edge and spans more than 50% of the width or height.
  - `orbit then view preset Front is exact`: `view(Front)` gives yaw 0 and pitch 0, whatever came before.
  - `zoom clamps`: `zoom(1e9)` leaves distance ≥ 1.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`ViewportView` (Swift):** an `NSView` with a `CAMetalLayer` (`wantsLayer`), driven by `CADisplayLink` from `NSView.displayLink(target:selector:)`. It draws only when something changed or `draw` returns true, as bmview does.
  - **Mouse and trackpad:**
    - right-drag or two-finger scroll orbits;
    - Shift + right-drag or Shift + scroll pans;
    - pinch (`magnify(with:)`) zooms;
    - `rotate(with:)` turns.
    - Left-click is reserved for selection (Task 10).
  - **Space:** play/pause, which plans on first use. While planning, the toolbar shows an indeterminate `NSProgressIndicator`.
  - **Background:** a light neutral (`0.96`) in light mode and a dark neutral (`0.11`) in dark mode, following `effectiveAppearance`.
- [ ] **Step 4:** Run the tests. Then check by hand on the helicopter that orbit, pan, pinch and Space playback all work.
- [ ] **Step 5: Commit.** Message: `feat(app): Metal viewport with trackpad navigation and build playback`.

### Task 4: `--snapshot` renders the whole window to PNG

**Files:**
- Create: `native/app/BrickMotion/Snapshot.swift`.
- Modify: `main.swift`, `bmapp/viewport.h` (`Image readback()` wrapper: `std::vector<uint8_t> rgba; int w, h;`).
- Test: `native/app/tests/snapshot_check.sh` (a ctest script).

**Interfaces:**
- Produces: the command `BrickMotion --snapshot out.png --open <file> [--size 1440x900] [--appearance light|dark] [--select <piece index>…] [--play-to <seconds>]`.
  - It opens the document, lays out the window at that size off-screen, draws one settled viewport frame, then composites three things into `out.png` (2× scale) and exits 0:
    - the window from `bitmapImageRepForCachingDisplay`;
    - the viewport's readback, in the viewport's rect;
    - the toolbar.

- [ ] **Step 1: Write the failing check** `snapshot_check.sh`. It snapshots the helicopter at 1440×900 and asserts with `python3 -I`/`sips` that:
  - the PNG is 2880×1800;
  - the viewport rect (from a `--report` JSON the app prints) has more than 1,000 distinct colours;
  - the sidebar rect is not one flat colour.
- [ ] **Step 2:** Run it through ctest. Expected: FAIL.
- [ ] **Step 3:** Implement as the interface says. With `--snapshot` the app never shows a window on screen (`orderOut`, offscreen window) and never activates.
- [ ] **Step 4:** Run the check. Expected: PASS. Once, compare the snapshot by eye with a capture of the same window shown on screen (`screencapture -l <window id>`), toolbar and glass materials included. Write any difference in the commit message. Then send the PNG to the owner (`SendUserFile`) as the Milestone 1 picture.
- [ ] **Step 5: Commit.** Message: `feat(app): --snapshot renders the window for checks and reviews`.

---

## Milestone 2: editing core

### Task 5: `bm::doc::Source`, the editable hierarchical document

**Files:**
- Create:
  - `native/core/include/bm/doc/source.h`
  - `native/core/src/doc/source.cpp`
  - `native/tests/doc_source_test.cpp`

**Interfaces:**
- Consumes:
  - `bm::io::PlanDoc`, `readPlan`, `readProject`, `fromPlan`;
  - `bm::ldraw::parseMpd`;
  - `bm::io::readStudioArchive`.
- Produces:

```cpp
namespace bm::doc {
using ItemId = uint64_t;                      // unique in a Source for its life; never reused
struct Placement { bool grid; double x, y, z; int rot; Xform exact; };  // grid: plan x/y/z/rot; else exact (ldu + matrix)
struct Item {
  ItemId id; bool submodel; std::string name; // part file ("3001.dat") or submodel name
  std::string colorText;                      // as the file had it (code or name), kept verbatim; "" = default
  int color;                                  // resolved code (16 default)
  Placement at; nlohmann::ordered_json extra; // every other key of the item, verbatim
};
struct Step { std::vector<Item> items; nlohmann::ordered_json extra; };   // title, notes, pause... live in extra
struct Def  { std::vector<Step> steps; nlohmann::ordered_json extra; };
struct Source {
  Def root; std::vector<std::pair<std::string, Def>> submodels;          // file order kept
  std::vector<ldraw::File> inlineParts; nlohmann::ordered_json extra;    // plan's other top-level keys
  const Def* def(const std::string& submodel) const;                      // "" = root
};
Source fromPlan(const io::PlanDoc& plan);
io::PlanDoc toPlan(const Source& source);       // same key order as read; grid placements stay grid
Source fromLDraw(const std::vector<ldraw::File>& files);   // first file = root; files named by others become submodels; STEP splits steps
Source fromFile(const std::filesystem::path& path);        // any format bm::io reads; .brickmotion -> its plan
// Flattening: the Model the planner and renderer read, plus which item made each piece.
struct PieceRef { std::vector<ItemId> chain; };  // root item ... the part's own item
struct Flat { Model model; std::vector<PieceRef> refs; };   // refs[i] belongs to model.pieces()[i]
Flat flatten(const Source& source, const ldraw::Library& library, ldraw::PartCache& cache);
}
```

- [ ] **Step 1: Write the failing tests.**
  - `plan round trip is identical`: for every `*.json` plan and `.brickmotion` project in `native/tests/fixtures` and `native/corpus` that the tests already read, `toPlan(fromPlan(p)).json == p.json` (ordered compare, `dump()` equal).
  - `ldraw import places pieces as io::load does`: for each fixture `.ldr`/`.mpd`, `flatten(fromLDraw(...))` and `io::load` give equal piece counts, parts and colours, with every world matrix within 1e-9.
  - `source keeps unknown part and colour names` (Review Focus 1): a plan with part `"nosuch.dat"` and colour `"Mauve Sparkle"` round-trips verbatim, and `flatten` reports both in `model.report()`.
  - `flatten ids are stable across an insert`: inserting an item at the front of step 0 changes no other item's `ItemId`.
  - `flatten matches fromPlan`: `flatten(fromPlan(p)).model` has the same pieces as `io::fromPlan(p, …)`, with the same order and placements to 1e-12.
- [ ] **Step 2:** Run `ctest --test-dir native/build -R doc_source`. Expected: FAIL.
- [ ] **Step 3: Implement `fromPlan`, `toPlan`, `fromLDraw` and `flatten` in `source.cpp`.**
  - **`flatten`** walks the Source the way `PlanBuilder` in `plan_json.cpp` walks JSON. Do not call it through JSON, because `flatten` runs after every structural edit.
  - **Grid rule:** move the grid placement code (`gridPlacement`) out of `plan_json.cpp`'s anonymous namespace into `bm/doc/source.h` as `Xform placeOnGrid(const Placement&, const Box& body)`, and have `plan_json.cpp` call it. This file is not on the excluded list.
  - **`fromLDraw` mirrors the plan form:**
    - each `0 FILE` is a def;
    - a ref to a def is a submodel item;
    - any other ref is a part item with `exact` placement;
    - `0 STEP` closes a step;
    - an empty trailing step is dropped.
- [ ] **Step 4:** Run. Expected: PASS. Also run the whole `bmcore_tests`, which must stay green (the grid code moved).
- [ ] **Step 5: Commit.** Message: `feat(doc): an editable document that keeps every field and flattens to a model`.

### Task 6: Writers for `.brickmotion` projects and LDraw MPD

**Files:**
- Create:
  - `native/core/include/bm/doc/write.h`
  - `native/core/src/doc/write.cpp`
  - `native/tests/doc_write_test.cpp`

**Interfaces:**
- Consumes: Task 5.
- Produces:

```cpp
namespace bm::doc {
struct Project { nlohmann::ordered_json json; };          // whole project; "plan" replaced on write
Project readProjectFile(std::string_view text);           // throws io::Error as readProject does
std::string writeProject(const Project& base, const Source& source, bool planChanged);  // base = {} for a new project: {"format":"brickmotion-project","version":1,"plan":...}
// planChanged: the web's "timelines" are a cache of planned animation keyed to the plan's pieces
// (src/io/projectFile.ts; the web plans again when one is missing). An edited plan drops the
// "timelines" key, so the web never plays stale motion; "settings" and every other key are kept.
// "savedAt" is set to the time of writing (ISO 8601, UTC).
std::string writeMpd(const Source& source, const ldraw::Library& library);  // 0 FILE per def (root first), 0 STEP between steps, inline parts last; colours as codes
}
```

- [ ] **Step 1: Write the failing tests.**
  - `project round trip keeps every other field` (Review Focus 3): for each fixture `.brickmotion`, `writeProject(p, fromPlan(plan of p), false)` parses to JSON equal to the input apart from `savedAt`.
  - `edited project changes only the edited item`: after changing one item's colour, a JSON diff of `plan` shows exactly one changed value; `settings` is equal; `timelines` is gone.
  - `delete drops the stale animation`: after deleting a piece, the written project has no `timelines`, and the web check in Task 12 opens and plays it.
  - `mpd keeps submodels and steps`: for a fixture MPD, `io::load(writeMpd(fromLDraw(f)))` equals `io::load(f)` in pieces, steps (`Piece::steps`) and submodel names, with placements within 1e-6. `writeMpd` writes 6 decimals.
  - `new project is version 1`: `writeProject({}, s)` passes `io::readProject`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Placement numbers are written in shortest round-trip form (`std::to_chars`), so an unedited value is written exactly as it was read.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat(doc): write projects the web app opens, and MPD with submodels and steps`.

### Task 7: Commands, the command log and undo in bmapp

**Files:**
- Create:
  - `native/app/bmapp/src/commands.h`
  - `native/app/bmapp/src/commands.cpp`
  - `native/app/bmapp/tests/commands_test.cpp`
- Modify: `session.h`, `session.cpp` (the session owns a `doc::Source` + `doc::Flat`).

**Interfaces:**
- Consumes: Tasks 5–6.
- Produces (Swift-visible, in `session.h`; `PieceIndex` = `uint32_t` index into the current flat model):

```cpp
namespace bmapp {
enum class Edit { Move, Rotate, Recolor, Delete, Duplicate, Paste, ReplacePart, MakeUnique };
struct Changed { bool structure; std::vector<uint32_t> moved; std::vector<uint32_t> recolored; uint64_t version; };
class Session {  // additions
  Changed move(const std::vector<uint32_t>& pieces, Vec3 deltaLdu, bool continuing);   // continuing: coalesce with the previous move of this gesture
  Changed rotate(const std::vector<uint32_t>& pieces, Vec3 axis, double degrees, Vec3 pivot, bool continuing);
  Changed recolor(const std::vector<uint32_t>& pieces, int colorCode);
  Changed remove(const std::vector<uint32_t>& pieces);
  Changed duplicate(const std::vector<uint32_t>& pieces, Vec3 offsetLdu);          // copies go into the same def and step as each original
  std::string copy(const std::vector<uint32_t>& pieces) const;                      // LDraw text (type-1 lines, world placements)
  Changed paste(const std::string& ldrawText, Vec3 offsetLdu);                       // into the root def, last step
  Changed replacePart(const std::vector<uint32_t>& pieces, const std::string& part);
  Changed makeUnique(uint32_t piece);                                               // forks the submodel use holding `piece` into "<name> 2" (next free number)
  void endGesture();
  bool canUndo() const; bool canRedo() const;
  std::string undoName() const; std::string redoName() const;   // "Move 3 Pieces", "Recolour Piece", ...
  Changed undo(); Changed redo();
  bool dirty() const; void markSaved();
  uint64_t version() const;
};
}
```

- **Command semantics:**
  - Every command changes `doc::Source`, never `Model` directly.
  - **Pieces inside submodels.** A piece reached through a submodel is changed in the submodel def. Its new local placement is `inverse(parentWorld) * newWorld`, taken through the use it was picked in. Every use of that submodel then changes.
  - **`Changed`.** After a command the session re-flattens. `structure` is false when only placements or colours changed and the piece count is the same; then `moved`/`recolored` list every flat piece affected, across all uses.
  - **Grid placements.** A grid item that is moved by whole studs and plates and turned by 90° about y stays grid. Otherwise it becomes `exact`.
  - **Which items a selection edits.** Before any command, the selection is resolved to items:
    - When every piece of one submodel use is selected, the command edits **the use** (its item in the parent def), not the submodel. Deleting a whole wheel assembly deletes that use only.
    - Otherwise each selected piece edits its own item in the deepest def. An item reached through two selected uses is edited once.
    - For move and rotate, the world delta is the same for every selected piece. Each item's local change is that delta taken through its own use, mirrored or turned uses included.
  - **In place.** A command that only moves or recolours pieces (`structure == false`) updates `doc::Flat` in place with `Model::setPlacement` and a new `Model::setColor(uint32_t, int)` (add it to `model.h` beside `setPlacement`). Only structural commands re-flatten.

- [ ] **Step 1: Write the failing tests.**
  - `every command undoes exactly`: for each `Edit`, apply it to a fixture, then `undo()`. `toPlan` JSON must be equal to the original; then `redo()`, and it must be equal to after-apply.
  - `move inside a shared submodel moves every use, undo restores` (Review Focus 2): use a fixture MPD whose submodel is placed twice, or write one into the test.
  - `a drag is one undo step`: three `move(..., continuing=true)` then `endGesture()` give one undo, named "Move Piece".
  - `grid stays grid on whole-stud moves`: moving 20 LDU in x keeps `at.grid`; moving 10 LDU makes it exact.
  - `dirty follows the saved mark through undo`.
  - `make unique forks one use`: after `makeUnique`, moving a piece in that use moves only it.
  - `deleting a whole use deletes the use, not the submodel`: in a model with a submodel used four times, select all pieces of one use and remove them. The submodel keeps its pieces, the model has three uses, and the piece count falls by one use.
  - `an item reached twice is edited once`: select one piece in each of two uses of the same submodel and recolour it. The def item changes once, and one undo restores it.
  - `select all and move gives one world delta`: in a model with a mirrored and a turned use, select all and move by (20, 0, 0). Every piece's world position changes by exactly (20, 0, 0), to 1e-9.
  - `in-place edits equal a full flatten`: after a move and a recolour, the in-place `Flat` equals `flatten(source)` exactly.
  - `an edit during planning cancels it`: start a plan, `move`, then wait for the job. `planState()` is not `Ready` for the old version, and asking to play again plans the edited model (pieces at the moved place).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. A `Command` stores the before and after of each `Item` it touches, plus inserted and removed item positions. Undo restores them, and no command is replayed from scratch.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat(app): every edit is an undoable command on the document`.

### Task 8: The renderer follows edits

**Files:**
- Modify: `native/render/include/bmr/renderer.h`, `native/render/src/metal/renderer.mm`, `native/render/include/bmr/scene.h`, `native/render/src/prep/scene.cpp`.
- Create: `native/render/tests/renderer_edit_test.mm`. Add it to `render/CMakeLists.txt`'s test list; that file is not on the excluded list.

**Interfaces:**
- Consumes: `bmr::buildScene`, `applyRest`, `Impl::upload`.
- Produces:

```cpp
// bmr::Renderer
/// The model changed. With `moved` and the same piece count, only those instances are re-placed
/// (no scene rebuild); otherwise the scene is rebuilt and meshes already loaded are reused.
/// `model` replaces the one given to create() and must outlive the renderer.
void modelChanged(const bm::Model& model, const std::vector<uint32_t>* moved = nullptr);
void recolored(const std::vector<uint32_t>& pieces);   // pieces whose colour changed: moved into their new (part, colour) group without a rebuild
void setHidden(const std::vector<uint32_t>& pieces);   // view-state hiding; kept apart from the timeline's kHidden (see Task 9)
// bmr (scene.h)
std::vector<std::pair<uint32_t, uint32_t>> applyMoved(Scene& scene, const bm::Model& model, const std::vector<uint32_t>& pieces);
/// Moves each piece's instance to the group of its part and new colour, making the group at the
/// end of its opaque or transparent run if it does not exist (order inside a run is not kept).
void applyRecolored(Scene& scene, const bm::Model& model, const std::vector<uint32_t>& pieces);
```

- [ ] **Step 1: Write the failing tests.**
  - `move updates only that instance` (Review Focus 4): `applyMoved` returns exactly one pair for one piece and leaves `scene.groups` sizes unchanged.
  - `recolour moves the instance, no rebuild`: after `applyRecolored`, the piece's `where` points to a group with the new colour, every other piece's `where` is unchanged, and `draw(nullptr)` matches a freshly built scene's picture exactly.
  - `recolour to glass moves it to the transparent run`.
  - `delete then draw`: after a piece is removed, `modelChanged` and `draw(nullptr)` succeed and `scene().where.size()` equals the new piece count.
  - `selection survives a rebuild`.
- [ ] **Step 2:** Run `ctest -R bmrender`. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - `MeshLibrary` keeps meshes by part name, so a rebuild loads only parts new to the model.
  - Selection flags are re-applied after a rebuild.
  - `updateLiveBounds()` runs after either path.
- [ ] **Step 4:** Run all `bmrender_tests`. Expected: PASS. Run `bmshot --bench` on the gate model before and after this task. The p95 must be within the noise noted in the README (±0.7 ms).
- [ ] **Step 5: Commit.** Message: `feat(render): the renderer follows edits without rebuilding for a move`.

### Task 9: Selection, picking, marquee and snapshots

Hiding is view state, kept in the session and sent with `Renderer::setHidden` (Task 8). It is a separate flag from the timeline's `kHidden`, so playback and `applyRest` never show a piece the user hid. Name it `kUserHidden = 8` in `scene.h`, and have every draw and pick path skip either flag.

**Files:**
- Modify: `bmapp/session.h`, `session.cpp`, `viewport.h`, `viewport.mm`.
- Create: `native/app/bmapp/tests/selection_test.cpp`.

**Interfaces:**
- Consumes: Tasks 3, 7, 8; `bmr::Renderer::pick`, `select`, `scene().groups[].restBoxes`.
- Produces:

```cpp
namespace bmapp {
struct PieceInfo { uint32_t piece; std::string part, description, colorName; int color; int step; std::string submodelPath; bool inSharedSubmodel; Vec3 position; };
struct Snapshot { uint64_t version; size_t pieces; std::vector<uint32_t> selection; std::vector<PieceInfo> selected;  // at most 200 described
                  std::string undoName, redoName; bool dirty; size_t hidden; };
class Session { // additions
  void select(const std::vector<uint32_t>& pieces, SelectMode mode);  // Replace, Add, Toggle
  void selectAll(); void selectNone();
  void hide(const std::vector<uint32_t>& pieces); void showAll();     // view state
  Snapshot snapshot() const;                                          // cheap: built once per version + selection change
};
class Viewport { // additions
  uint32_t pick(double xPoints, double yPoints);                      // UINT32_MAX for none; hidden pieces never picked
  std::vector<uint32_t> marquee(double x0, double y0, double x1, double y1, bool touching);  // touching=false: wholly inside
  void showSelection();                                               // outline from session selection
  void frameSelection();
};
}
```

- [ ] **Step 1: Write the failing tests.**
  - `marquee wholly inside`: with a fixed camera on a 2×2 grid of bricks, a rect around one brick returns exactly that piece.
  - `touching returns neighbours too`.
  - `hidden pieces are neither drawn nor picked`.
  - `user-hidden pieces stay hidden through playback and rest`.
  - `selection is remapped after delete`: delete piece 0 with piece 3 selected, and the selection becomes `{2}`. Pieces deleted are dropped.
  - `snapshot version changes on every command and not on a redraw`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - Marquee: project each visible piece's world box corners with the viewport camera's matrices (`bmr::viewMatrix`, `projectionMatrix`).
  - Hiding uses `kUserHidden` through `Renderer::setHidden` (Task 8).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat(app): selection, marquee, hiding and snapshots`.

### Task 10: Mouse, keyboard and menus for editing

**Files:**
- Create in `native/app/BrickMotion/`: `EditCommands.swift` (menu items, key equivalents, validation), `Pasteboard.swift`.
- Create: `native/app/bmapp/src/keys.cpp`, `native/app/bmapp/tests/keys_test.cpp`.
- Modify: `ViewportView.swift`, `AppDelegate.swift` (main menu).

**Interfaces:**
- Consumes: Tasks 7 and 9.
- Produces:

```cpp
namespace bmapp {
/// The model axis an arrow key moves along for this camera: the world x or z axis whose screen
/// direction is nearest the arrow's (ties go to x), signed. Up/down arrows use the camera's
/// forward projected on the floor.
Vec3 arrowAxis(const CameraState& camera, Arrow arrow);   // Arrow: Left, Right, Up, Down
inline constexpr double kStud = 20, kPlate = 8, kBrick = 24;  // LDU
}
```

- **Bindings.** These are the web's keys (parity §5, §20). The Mac standard wins on a clash.

  | Input | Action |
  |---|---|
  | Click | Select |
  | ⇧-click | Toggle in selection |
  | Drag on empty space | Marquee (wholly inside; ⌥ for touching) |
  | Double-click a piece in a submodel | Select the whole use |
  | ←→↑↓ | Move one stud, camera-relative (`arrowAxis`) |
  | ⇧↑ / ⇧↓, E / Q, Page Up / Page Down | Raise or lower one plate; with ⌥, one brick (24) |
  | R / ⇧R | Rotate 90° about y through the selection's centre, the other way with ⇧ |
  | ⌫ / Delete | Delete |
  | ⌘D | Duplicate, offset one stud in x |
  | ⌘C / ⌘X / ⌘V | Copy / cut / paste LDraw text on `NSPasteboard.general` as `public.utf8-plain-text` |
  | C | Clone: duplicate in place, then select the copies |
  | H / ⇧H | Hide / show all |
  | ⌥H | Hide everything else |
  | A / ⌘A | Select all |
  | Esc / ⌥A | Select none |
  | F | Fit all |
  | ⌘F | Frame selection |
  | 1, 3, 7 (⌃ for the opposite side), 5 | View presets; 5 toggles orthographic |

  - **Undo and redo:** ⌘Z and ⇧⌘Z through `Document.undoManager`. Each command registers one undo whose action name is `undoName()`.
  - **Edit menu:** Undo, Redo, Cut, Copy, Paste, Duplicate, Delete, Select All, Select None, Hide, Hide Others, Show All.
  - **Object menu:** Rotate 90°, Raise, Lower, Make Unique, Replace Part… (a sheet with a search field over the library). Every item's validation follows `Snapshot`.
  - **Bad selections:** an edit with nothing selected beeps (`NSSound.beep()`) and changes nothing.
  - **⌘G:** not bound in this milestone. The web's dead ⌘G is not reproduced.

- [ ] **Step 1: Write the failing tests** `arrowAxis follows the camera`: for yaw 0, 90, 180, 270 and 45 (a tie, so x), assert the signed axis for each arrow.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `arrowAxis` and the Swift bindings above.
- [ ] **Step 4:** Run the tests. Then use `--snapshot --select 0 3 7` to confirm the outline. By hand on the helicopter: move, rotate, duplicate, copy/paste between two documents, delete, then undo everything back to a clean document (the dot in the close button goes away).
- [ ] **Step 5: Commit.** Message: `feat(app): editing by mouse, keys and menus, with named undo`.

### Task 11: Move and rotate gizmos

**Files:**
- Create:
  - `native/app/bmapp/src/gizmo.cpp`
  - `native/app/bmapp/include/bmapp/gizmo.h`
  - `native/app/bmapp/tests/gizmo_test.cpp`
  - `native/app/BrickMotion/GizmoLayer.swift`
- Modify: `ViewportView.swift`, the toolbar (a `Select | Move | Rotate` segmented tool control), `WindowController.swift`.

**Interfaces:**
- Consumes: Tasks 3 and 7; `bmr::viewMatrix`, `projectionMatrix`.
- Produces:

```cpp
namespace bmapp {
enum class GizmoKind { None, Move, Rotate };
enum class Handle { None, X, Y, Z, XY, YZ, XZ, View };      // planes for Move; View = screen ring for Rotate
struct GizmoShape { struct Seg { Vec2 a, b; Handle h; }; std::vector<Seg> lines; std::vector<std::vector<Vec2>> rings; std::vector<Handle> ringHandles; };
GizmoShape gizmoShape(const CameraState&, Vec2 viewportPoints, Vec3 origin, Mat3 axes, GizmoKind); // axes: identity (world) or the first selected piece's rotation (local)
Handle hitGizmo(const GizmoShape&, Vec2 point, double tolerancePoints = 6);
/// Movement for a drag from a to b on `handle`: along the axis or in the plane, in LDU,
/// snapped to `snap` (20 in x/z, 8 in y; 0 = free when the user holds Option).
Vec3 dragMove(const CameraState&, Vec2 viewportPoints, Vec3 origin, Mat3 axes, Handle, Vec2 a, Vec2 b, Vec3 snap);
/// Angle for a rotate drag, in degrees, snapped to 15 unless `free` (Shift held).
double dragRotate(const CameraState&, Vec2 viewportPoints, Vec3 origin, Mat3 axes, Handle, Vec2 a, Vec2 b, bool free);
}
```

- [ ] **Step 1: Write the failing tests.**
  - `X handle moves only in x`: dragging across the screen along the projected x axis gives `(k*20, 0, 0)`.
  - `snap rounds to studs and plates`.
  - `a drag parallel to the line of sight moves nothing` (a degenerate axis gives 0, not inf).
  - `rotate snaps to 15 and is free with shift`.
  - `hitGizmo picks the nearest handle within tolerance, None outside`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Drawing:** `GizmoLayer` is a `CAShapeLayer` tree over the Metal layer, rebuilt from `gizmoShape` each frame the camera or selection changes. Axis colours are the system red, green and blue.
  - **Hover:** the hovered handle is drawn thicker in `controlAccentColor`.
  - **Dragging:** a drag calls `Session::move` or `rotate` with `continuing = true`, and `endGesture()` on mouse-up. During the drag, a small `NSTextField` capsule near the cursor reads out the offset in studs and plates (or the angle).
  - **Tool keys:** V Select, M Move; the Rotate tool has no key (as in the web) and is chosen in the toolbar. R stays rotate 90° (Task 10). **L** switches world/local axes.
- [ ] **Step 4:** Run. Then `--snapshot` with a selection and the Move tool. Check by hand that the handles track while orbiting and that a drag is one undo.
- [ ] **Step 5: Commit.** Message: `feat(app): move and rotate gizmos with stud, plate and 15° snapping`.

### Task 12: Saving, imports, Export LDraw, autosave and Versions

**Files:**
- Modify: `Document.swift`, `DocumentController.swift`, `AppDelegate.swift` (File menu), `bmapp/session.h`, `session.cpp`.
- Create: `native/app/bmapp/tests/save_test.cpp`, `native/app/tests/import_check.sh`.

**Interfaces:**
- Consumes: Task 6.
- Produces:

```cpp
namespace bmapp {
class Session { // additions
  std::string projectBytes() const;                       // doc::writeProject(base project or {}, source)
  OpenResult openBytes(const std::string& bytes, const std::string& nameForErrors);   // used by NSDocument read(from:ofType:) for projects
  std::string mpdBytes() const;                            // doc::writeMpd
};
}
```

- **Swift:**
  - `Document.data(ofType:)` returns `projectBytes()`; `read(from:ofType:)` calls `openBytes`.
  - **File menu:** Export LDraw… writes `mpdBytes()` through an `NSSavePanel` with type `.mpd`.
  - **Versions:** `autosavesInPlace` and `preservesVersions` are both true, so Browse All Versions works.
  - **After a save:** `markSaved()`.
  - **Revert, Versions and reloads** call `read(from:ofType:)` on a live document. That resets everything: a new `Session`, an empty command log, `undoManager.removeAllActions()`, an empty selection, a new `Viewport` and renderer, and any planning job cancelled.

- [ ] **Step 1: Write the failing tests.**
  - `save then reopen is the same document` (`save_test.cpp`): open a fixture, edit, take `projectBytes()`, `openBytes` it into a new session; `toPlan` must be equal.
  - `reopening resets the log`: after edits, `openBytes` into the same session gives `canUndo() == false`, an empty selection and `dirty() == false`.
  - `import opens untitled, source untouched` (Review Focus 5, `import_check.sh`):
    - hash a fixture `.ldr`;
    - run `BrickMotion --open <it> --edit-move 0 20 0 0 --save-to <tmp>.brickmotion`, test-only flags that drive the same code path as ⌘S on an untitled document;
    - assert the `.ldr` hash is unchanged, the `.brickmotion` reads with `io::readProject`, and its piece 0 is 20 LDU to the right.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. The `--edit-move` and `--save-to` flags live next to `--snapshot` in `main.swift`, and run headless.
- [ ] **Step 4:** Run the tests. Then check by hand:
  - open a web-made `.brickmotion`, edit (one move and one delete) and save, then open it in the web app (`npm run dev`), which shows both edits and plans the animation again;
  - Browse All Versions lists the saves.
- [ ] **Step 5: Commit.** Message: `feat(app): save projects the web opens, export MPD, autosave and versions`.

### Task 13: Measurements, docs and the Milestone 2 picture

**Files:**
- Create: `native/app/tests/bench_app.sh`.
- Modify:
  - `native/README.md` (a new "Phase 8 results" section, appended; do not touch others' hunks);
  - `docs/superpowers/specs/2026-11-19-native-app-parity.md` (mark rows done);
  - the plan status note at the top of this file.

**Interfaces:**
- Consumes: everything above.
- Produces: `BrickMotion --bench-open <file>` and `--bench-edit <file>` print JSON:
  - `{"openToFirstFrameMs":…}`, with a warm part cache, measured from process start;
  - `{"moveP95Ms":…, "recolorP95Ms":…}`, from 200 edits each, command to frame presented (`CAMetalDrawable` `addPresentedHandler`).

- [ ] **Step 1:** Add the two flags and `bench_app.sh`. The script runs both on the helicopter and on `10030-1` ×4 (`bmshot --repeat 2x2 --save-model` makes the file).
- [ ] **Step 2: Run them and record the results.**
  - The design gates: helicopter open ≤ 500 ms; a move and a recolour each ≤ 8.33 ms p95 on both models.
  - Measure the web for the same open on the same machine, so the design's "measure" cells are filled.
  - A gate that is missed is written down as missed, with the cause.
- [ ] **Step 3:** Update the README and the parity checklist. Each Phase 8 row this plan covers gets `done (M2)` or `partial: …`, saying what is left.
- [ ] **Step 4:** Take `--snapshot` pictures, light and dark, of the helicopter with a selection and the Move gizmo, and send them to the owner.
- [ ] **Step 5: Commit.** Message: `docs(app): phase 8 milestone 1–2 results and measurements`.

---

## Self-review notes (kept for the executor)

- **Covered here:** design goals 1 (the editing part) and 2 (documents, undo, menus, gestures; accessibility labels arrive with real panels in Milestone 3), gate rows "open", "edit to screen", "undo" and "data safety", and all five Review Focus cases.
- **Not covered here, by design:**
  - Milestone 3: palette, browser, inspector, Settings, welcome window, part drag-in with snapping, step and submodel structure editing.
  - Milestone 4: timelines and re-plan speed.
  - Milestone 5: polish.
- **Refines design calls** (the design doc is amended to match):
  - The design said an off-grid piece needs "one additive field". The plan file already has `ldu` + `matrix` and the web reads them, so no new field is added.
  - The build is CMake + Ninja, Swift included, in its own tree `native/build-app`. There is no Xcode project; `cmake -G Xcode` can make one when wanted.
  - The window shell is AppKit (`NSDocument`, `NSSplitViewController` with sidebar and inspector items) with SwiftUI inside the panes. SwiftUI's `DocumentGroup` cannot host the Metal viewport and the split items this precisely.
  - An edited project drops the web's cached `timelines`; the web plans again on open.
