# BrickMotion Desktop — Milestone 1 (Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Rust/egui Mac app in `desktop/` that opens an LDraw model or `.brickmotion` project through the existing C++ engine. It shows the model in a 3D viewport inside the locked SolidCraft-style layout, with orbit, pan, zoom, fit, view presets and click-to-select.

**Architecture:** The engine (`bmcore`, `bmrender`, `bmfilm`, `bmsound`, `bmmovie`, `bmtools_common`, `bmapp`) is unchanged C++ and is built by CMake. A new flat C shim, `bmffi`, is built as one shared library (`libbmffi.dylib`) linking all of them, so Rust links a single library. The Rust side has three crates: `bm-sys` (raw `extern "C"`), `bm` (safe wrappers) and `brickmotion` (the eframe app). In this milestone the viewport uses the engine's existing offscreen path: `draw(nullptr)`, then `readback()`, then an egui texture upload. The shared-GPU-texture path is milestone 2.

**Tech Stack:**
- Rust 1.97, edition 2024.
- eframe/egui 0.37 (wgpu backend), egui_extras 0.37 (svg), egui_kittest 0.37 (UI tests), rfd (file dialog), cmake crate (build.rs).
- C++20, Catch2 3.7.1 (existing).
- macOS arm64.

**Spec:** `docs/superpowers/specs/2026-11-25-rust-egui-app-design.md` (interface LOCKED 2026-11-25). Visual reference: `.superpowers/brainstorm/65433-1795584607/content/final-locked.html`.

## Global Constraints

- **Stack:** Rust + egui/eframe 0.37 + wgpu. The engine is reused through a bridge, with no Rust rewrite of engine logic.
- **Swift app frozen:** it must stay buildable, and its tests (`native/build-app` 619, `native/build` 462) stay green.
- **No SolidCraft brand assets:** no icons, glyphs, themes, design tokens or palettes from SolidCraft. Our own icons and theme only.
- **Calm UI:**
  - One stroke-icon family drawn by us. No emoji or unicode glyphs as icons.
  - One accent colour: blue `#4f8cff` for selection, orange `#ff9f43` only for the playhead and the active workspace mark.
  - 8-px spacing grid; 12.5-pt text with two weights.
  - Few tools visible; the rest on demand.
- **Workspaces:** Build has no timeline. Animate has the timeline and an Output ribbon tab. The Build | Animate switch sits directly under "Search commands" at the top right, and the left Workspace button mirrors it.
- **Engine first:** behaviour lives in C++. Rust holds view state and layout only.
- **Bundle id while both apps exist:** `com.brickmotion.studio.rs`.
- **Build:** `cargo build` drives CMake with `-DBM_APP_LIB=ON` into `native/build-rust`, and needs no Swift toolchain.
- **Platform:** CMake already pins `CMAKE_OSX_DEPLOYMENT_TARGET 15.0` and arm64. The Rust app targets the same.
- **Commits:** the working tree holds uncommitted engine and Swift work by the owner. Each task stages only the files it names (`git add <paths>`, never `git add -A`). Do not commit on `main`: work on a new branch `feat/desktop-m1` created from the current branch.

## Review Focus

1. **A file that fails to open** (missing path, unreadable file, an `.stl`): show an error naming the file and the reason, and keep the previous document. Test: Task 6 `open_failure_keeps_previous_document`.
2. **A very large model** (Sagrada 21065, about 12k parts): the window stays responsive while it loads, with a loading state in the Browser. Loading runs on a worker thread and is adopted on the UI thread. Test: Task 6 `open_runs_off_ui_thread`.
3. **The window resized to a tiny or zero-height viewport**, including Animate with the timeline taking all the space: no panic and no engine call with a 0 size. Test: Task 5 `zero_size_viewport_skips_draw`.
4. **Retina scale changing** when the window moves between displays: the picture is redrawn at the new pixels-per-point and stays sharp. Test: Task 5 `resize_tracks_pixels_per_point`.
5. **No LDraw library found:** a clear message saying where it looked, not a crash or an empty grey view. Test: Task 2 `open_without_ldraw_reports`.

---

## File Structure

```
native/app/CMakeLists.txt                 (modify) bmapp target moves out; Swift app keeps the rest
native/app/bmapp/CMakeLists.txt           (create) bmapp + bmapp_tests targets, no Swift
native/CMakeLists.txt                     (modify) option BM_APP_LIB → add_subdirectory(app/bmapp) + ../desktop/bmffi
desktop/Cargo.toml                        workspace: crates/bm-sys, crates/bm, crates/brickmotion
desktop/bmffi/CMakeLists.txt              SHARED bmffi + bmffi_tests
desktop/bmffi/include/bmffi.h             the C ABI (only header Rust mirrors)
desktop/bmffi/src/bmffi.cpp               shim over bmapp::Session / bmapp::Viewport
desktop/bmffi/tests/bmffi_test.cpp        Catch2
desktop/crates/bm-sys/{Cargo.toml,build.rs,src/lib.rs}   cmake build + extern "C" mirror of bmffi.h
desktop/crates/bm/src/{lib.rs,session.rs,viewport.rs,error.rs}
desktop/crates/bm/tests/render.rs
desktop/crates/brickmotion/src/
  main.rs            args (path, --snapshot), eframe::run_native
  app.rs             BrickMotionApp: document state, workspace, frame loop
  theme.rs           colour/spacing tokens, egui Style
  icons.rs + ../assets/icons/*.svg   our stroke icons, include_bytes!
  commands.rs        CommandId, Command {id,title,icon,shortcut,group}, registry for ribbon + search
  chrome/titlebar.rs, chrome/ribbon.rs, chrome/browser.rs, chrome/properties.rs, chrome/viewbar.rs, chrome/navigator.rs, chrome/timeline.rs
  viewport.rs        ViewportWidget: texture upload, gestures → engine calls
  loader.rs          background open + adopt
  snapshot.rs        --snapshot headless PNG
desktop/crates/brickmotion/tests/ui.rs   egui_kittest
desktop/scripts/bundle.sh                BrickMotion.app (Info.plist, libbmffi.dylib in Frameworks)
```

---

### Task 1: Move bmapp out of the Swift build

**Files:**
- Create: `native/app/bmapp/CMakeLists.txt`
- Modify: `native/app/CMakeLists.txt` (the bmapp and bmapp_tests blocks, currently lines 6–28), `native/CMakeLists.txt` (the end of the file, after `option(BM_APP …)`)

**Interfaces:**
- Produces: CMake targets `bmapp` (STATIC) and `bmapp_tests`, defined in `native/app/bmapp/CMakeLists.txt` and included by both `BM_APP=ON` (via `native/app/CMakeLists.txt` → `add_subdirectory(bmapp)`) and the new `option(BM_APP_LIB "bmapp without Swift, for the Rust app" OFF)`. With `BM_APP_LIB=ON`, `native/CMakeLists.txt` calls `add_subdirectory(app/bmapp)`, and in Task 2 also `add_subdirectory(${CMAKE_SOURCE_DIR}/../desktop/bmffi ${CMAKE_BINARY_DIR}/bmffi)`.

- [ ] **Step 1: Move the block.** Cut the `bmapp` library and `bmapp_tests` blocks verbatim (sources glob, `-fobjc-arc`, `BM_DEFAULT_LDRAW`/`BM_DEFAULT_HABITS` definitions, links, Catch discovery) into `native/app/bmapp/CMakeLists.txt`. Fix the relative paths: `bmapp/src/*.cpp` becomes `src/*.cpp`, and `${CMAKE_SOURCE_DIR}/..` stays as it is. In `native/app/CMakeLists.txt`, put `add_subdirectory(bmapp)` where the block was.
- [ ] **Step 2: Build and test the non-Swift tree**

Run: `cmake -S native -B native/build-rust -G Ninja -DBM_APP_LIB=ON && cmake --build native/build-rust --target bmapp_tests && ctest --test-dir native/build-rust -R bmapp --output-on-failure`
Expected: configures with no `enable_language(Swift)`. All bmapp tests pass; record the count.

- [ ] **Step 3: Check the Swift tree still builds**

Run: `cmake -S native -B native/build-app -G Ninja -DBM_APP=ON && cmake --build native/build-app && ctest --test-dir native/build-app 2>&1 | tail -3`
Expected: the same pass count as before the move (619 listed). Report any failure that also fails on the unmodified tree as pre-existing.

- [ ] **Step 4: Commit**

```bash
git switch -c feat/desktop-m1
git add native/CMakeLists.txt native/app/CMakeLists.txt native/app/bmapp/CMakeLists.txt
git commit -m "build: bmapp builds without Swift (BM_APP_LIB)"
```

---

### Task 2: bmffi C shim

**Files:**
- Create: `desktop/bmffi/CMakeLists.txt`, `desktop/bmffi/include/bmffi.h`, `desktop/bmffi/src/bmffi.cpp`, `desktop/bmffi/tests/bmffi_test.cpp`
- Modify: `native/CMakeLists.txt` (BM_APP_LIB branch: add bmffi)

**Interfaces:**
- Consumes: `bmapp::Session` (`open`, `openBytes`, `adoptLoadedSession`, `title`, `pieceCount`, `select`, `selection`, `ldrawDirectory`), `bmapp::Viewport` (`create`, `ok`, `resize`, `draw(nullptr)`, `readback`, `needsDraw`, `orbit`, `pan`, `zoomToward`, `fitAll`, `view(ViewPreset)`, `setBackground`, `setOrthographic`, `pick`, `camera`).
- Produces (exact C ABI; every string returned is owned by the caller and freed with `bm_string_free`):

```c
typedef struct BmSession BmSession;   // wraps bmapp::Session* (retained)
typedef struct BmViewport BmViewport; // wraps bmapp::Viewport* (retained)
typedef struct { char* ptr; size_t len; } BmString;
typedef struct { bool ok; BmString error; BmString warnings; } BmOpenResult;
typedef enum { BM_VIEW_FRONT, BM_VIEW_BACK, BM_VIEW_RIGHT, BM_VIEW_LEFT, BM_VIEW_TOP, BM_VIEW_BOTTOM } BmViewPreset;
typedef enum { BM_SELECT_REPLACE, BM_SELECT_ADD, BM_SELECT_TOGGLE } BmSelectMode;
#define BM_NO_PIECE UINT32_MAX

void          bm_string_free(BmString s);
BmString      bm_ldraw_directory(void);          // "" when none
BmString      bm_engine_version(void);
BmSession*    bm_session_new(void);
void          bm_session_free(BmSession*);
BmOpenResult  bm_session_open(BmSession*, const char* utf8_path);   // safe on any thread for a session no other thread uses
void          bm_open_result_free(BmOpenResult);
void          bm_session_adopt(BmSession* into, const BmSession* loaded);  // UI thread
BmString      bm_session_title(const BmSession*);
size_t        bm_session_piece_count(const BmSession*);
uint64_t      bm_session_generation(const BmSession*);
void          bm_session_select(BmSession*, const uint32_t* pieces, size_t n, BmSelectMode);
size_t        bm_session_selection(const BmSession*, uint32_t* out, size_t cap); // returns total; writes min(total,cap)

BmViewport*   bm_viewport_new(BmSession*);       // NULL when Metal is unavailable
void          bm_viewport_free(BmViewport*);
bool          bm_viewport_ok(const BmViewport*);
void          bm_viewport_resize(BmViewport*, int px_w, int px_h, double scale); // ignores w<=0 || h<=0
bool          bm_viewport_draw(BmViewport*);     // draw(nullptr); true = wants another frame soon
bool          bm_viewport_needs_draw(const BmViewport*);
bool          bm_viewport_readback(BmViewport*, uint8_t* rgba, size_t cap, int* w, int* h); // false if cap too small (w,h still set)
void          bm_viewport_orbit(BmViewport*, double dx_pt, double dy_pt);
void          bm_viewport_pan(BmViewport*, double dx_pt, double dy_pt);
void          bm_viewport_zoom_toward(BmViewport*, double factor, double x_pt, double y_pt);
void          bm_viewport_fit_all(BmViewport*);
void          bm_viewport_view(BmViewport*, BmViewPreset);
void          bm_viewport_set_background(BmViewport*, double r, double g, double b);
void          bm_viewport_set_orthographic(BmViewport*, bool);
uint32_t      bm_viewport_pick(BmViewport*, double x_pt, double y_pt);  // BM_NO_PIECE on empty space
```

`bmffi` is `add_library(bmffi SHARED …)`, linking `bmapp` PRIVATE (bmapp brings the rest). It is built with `-fvisibility=hidden`, and `bmffi.h` marks each function `__attribute__((visibility("default")))` through a `BMFFI_API` macro. Its install name is `@rpath/libbmffi.dylib`. Every entry point catches C++ exceptions: `bm_session_open` turns one into `ok=false` with the exception message, and the others swallow it and return their neutral value.

- [ ] **Step 1: Write the failing tests** in `desktop/bmffi/tests/bmffi_test.cpp`, using `BM_REPO` (defined like `bmapp_tests`)

```cpp
TEST_CASE("open helicopter and render a frame") {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, BM_REPO "/samples/helicopter/helicopter.mpd");
  REQUIRE(r.ok); bm_open_result_free(r);
  CHECK(bm_session_piece_count(s) > 100);
  BmViewport* v = bm_viewport_new(s); REQUIRE(v); REQUIRE(bm_viewport_ok(v));
  bm_viewport_set_background(v, 0.1, 0.1, 0.12);
  bm_viewport_resize(v, 320, 240, 1.0); bm_viewport_fit_all(v);
  for (int i = 0; i < 30 && bm_viewport_draw(v); ++i) {}
  std::vector<uint8_t> px(320*240*4); int w=0,h=0;
  REQUIRE(bm_viewport_readback(v, px.data(), px.size(), &w, &h));
  CHECK(w == 320); CHECK(h == 240);
  size_t lit = 0; for (size_t i = 0; i < px.size(); i += 4) lit += (px[i] > 60 || px[i+1] > 60 || px[i+2] > 60);
  CHECK(lit > 1000);                                   // the model is in the picture
  CHECK(bm_viewport_pick(v, 160, 120) != BM_NO_PIECE); // centre hits a piece after fit
  CHECK(bm_viewport_pick(v, 2, 2) == BM_NO_PIECE);
  bm_viewport_free(v); bm_session_free(s);
}
TEST_CASE("open failure keeps the message") {
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, "/no/such/file.mpd");
  CHECK_FALSE(r.ok); CHECK(r.error.len > 0); bm_open_result_free(r); bm_session_free(s);
}
TEST_CASE("open_without_ldraw_reports") {   // Review Focus 5
  setenv("BM_LDRAW_DIR", "/nonexistent-ldraw", 1);
  BmSession* s = bm_session_new();
  BmOpenResult r = bm_session_open(s, BM_REPO "/samples/helicopter/helicopter.mpd");
  CHECK((!r.ok || r.warnings.len > 0));   // never silent
  bm_open_result_free(r); bm_session_free(s); unsetenv("BM_LDRAW_DIR");
}
TEST_CASE("zero size resize is ignored") {
  BmSession* s = bm_session_new(); bm_open_result_free(bm_session_open(s, BM_REPO "/samples/helicopter/helicopter.mpd"));
  BmViewport* v = bm_viewport_new(s); bm_viewport_resize(v, 0, 0, 2.0); bm_viewport_draw(v); // must not crash
  bm_viewport_free(v); bm_session_free(s);
}
TEST_CASE("adopt moves a worker-loaded document") {
  BmSession* ui = bm_session_new(); BmSession* w = bm_session_new();
  std::thread([&]{ bm_open_result_free(bm_session_open(w, BM_REPO "/samples/helicopter/helicopter.mpd")); }).join();
  uint64_t g0 = bm_session_generation(ui); bm_session_adopt(ui, w);
  CHECK(bm_session_piece_count(ui) == bm_session_piece_count(w)); CHECK(bm_session_generation(ui) != g0);
  bm_session_free(w); bm_session_free(ui);
}
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cmake --build native/build-rust --target bmffi_tests`
Expected: compile error (`bmffi.h` functions undefined).

- [ ] **Step 3: Implement `bmffi.h` and `bmffi.cpp`** with the signatures above. `BmSession` holds `bmapp::Session*` from `Session::create()` and frees it with `bmappReleaseSession`. `BmViewport` likewise uses `Viewport::create` and `bmappReleaseViewport`. `bm_viewport_new` returns NULL when `Viewport::metalDevice()` is null. Resize skips `w<=0||h<=0`. Readback copies `Picture::rgba`. If the `open_without_ldraw_reports` case shows the engine is silent, make the shim add a warning (`"LDraw library not found at <dir>"`) when `Session::ldrawDirectory()` is empty.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cmake --build native/build-rust --target bmffi_tests && ctest --test-dir native/build-rust -R bmffi --output-on-failure`
Expected: all 5 cases pass.

- [ ] **Step 5: Commit**

```bash
git add desktop/bmffi native/CMakeLists.txt
git commit -m "feat(desktop): bmffi C ABI over bmapp session and viewport"
```

---

### Task 3: Rust crates bm-sys and bm

**Files:**
- Create: `desktop/Cargo.toml` (workspace, `resolver = "3"`, edition 2024), `desktop/crates/bm-sys/{Cargo.toml,build.rs,src/lib.rs}`, `desktop/crates/bm/{Cargo.toml,src/lib.rs,src/session.rs,src/viewport.rs,src/error.rs,tests/render.rs}`, `desktop/.gitignore` (`target/`)

**Interfaces:**
- Consumes: the `bmffi.h` ABI (Task 2).
- Produces (crate `bm`):

```rust
pub struct Session;              // Send (one owner), !Sync
impl Session {
  pub fn new() -> Session;
  pub fn open(&mut self, path: &Path) -> Result<OpenInfo, OpenError>;
  pub fn adopt(&mut self, loaded: &Session);
  pub fn title(&self) -> String;
  pub fn piece_count(&self) -> usize;
  pub fn generation(&self) -> u64;
  pub fn select(&mut self, pieces: &[u32], mode: SelectMode);
  pub fn selection(&self) -> Vec<u32>;
}
pub struct OpenInfo { pub warnings: Vec<String> }        // one per line
pub struct OpenError { pub path: PathBuf, pub message: String } // impl Display: "<file name>: <message>"
pub enum SelectMode { Replace, Add, Toggle }
pub enum ViewPreset { Front, Back, Right, Left, Top, Bottom }
pub struct Frame { pub width: u32, pub height: u32, pub rgba: Vec<u8> }
pub struct Document;              // owns one Session and its Viewport; drops the viewport first
impl Document {
  pub fn new(session: Session) -> Document;              // makes the viewport if Metal is available and the model is ok
  pub fn session(&self) -> &Session; pub fn session_mut(&mut self) -> &mut Session;
  pub fn viewport(&mut self) -> Option<&mut Viewport>;
  pub fn replace(&mut self, loaded: Session);            // drop viewport, adopt `loaded`, new viewport
}
pub struct Viewport;              // only reachable through Document (holds the raw BmViewport*)
impl Viewport {
  pub fn resize(&mut self, px_w: u32, px_h: u32, scale: f64);
  pub fn draw(&mut self) -> bool;
  pub fn needs_draw(&self) -> bool;
  pub fn read_frame(&mut self, into: &mut Frame);        // grows rgba as needed
  pub fn orbit(&mut self, dx: f64, dy: f64); pub fn pan(&mut self, dx: f64, dy: f64);
  pub fn zoom_toward(&mut self, factor: f64, x: f64, y: f64);
  pub fn fit_all(&mut self); pub fn view(&mut self, p: ViewPreset);
  pub fn set_background(&mut self, rgb: [f64; 3]); pub fn set_orthographic(&mut self, on: bool);
  pub fn pick(&mut self, x: f64, y: f64) -> Option<u32>;
}
pub fn ldraw_directory() -> Option<PathBuf>; pub fn engine_version() -> String;
```

The engine's viewport keeps a pointer to its session, so `Document` owns the session in a `Box` (a stable address) and drops the viewport before the session. `Document::replace` is the only way to swap documents, and the app (Task 6) relies on it.

`bm-sys/build.rs` does the following:
- Runs `cmake::Config::new("../../../native").define("BM_APP_LIB","ON").generator("Ninja").out_dir(<repo>/native/build-rust).build_target("bmffi")`.
- Emits `cargo:rustc-link-search=native=<build>/bmffi`, `cargo:rustc-link-lib=dylib=bmffi` and `cargo:rustc-link-arg=-Wl,-rpath,<build>/bmffi`. The bundle script rewrites the rpath for the .app.
- Emits `cargo:rerun-if-changed` for `desktop/bmffi` and `native/app/bmapp/src`.
- Exports `DEP_BMFFI_LIBDIR` for the app crate.

The `extern "C"` block in `bm-sys/src/lib.rs` mirrors `bmffi.h` by hand. The header check in Step 1 keeps the two in step.

- [ ] **Step 1: Write the failing tests** in `desktop/crates/bm/tests/render.rs`

```rust
const HELI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../samples/helicopter/helicopter.mpd");
#[test] fn opens_and_renders() {
    let mut s = bm::Session::new();
    s.open(Path::new(HELI)).unwrap();
    assert!(s.piece_count() > 100);
    let mut doc = bm::Document::new(s);
    let v = doc.viewport().expect("metal");
    v.set_background([0.1, 0.1, 0.12]); v.resize(320, 240, 1.0); v.fit_all();
    for _ in 0..30 { if !v.draw() { break } }
    let mut f = bm::Frame::default(); v.read_frame(&mut f);
    assert_eq!((f.width, f.height), (320, 240));
    assert!(f.rgba.chunks(4).filter(|p| p[0] > 60 || p[1] > 60 || p[2] > 60).count() > 1000);
    assert!(v.pick(160.0, 120.0).is_some()); assert_eq!(v.pick(2.0, 2.0), None);
}
#[test] fn open_error_names_file() {
    let e = bm::Session::new().open(Path::new("/no/such/thing.mpd")).unwrap_err();
    assert!(e.to_string().starts_with("thing.mpd: "));
}
#[test] fn replace_swaps_document_and_viewport() {
    let mut doc = bm::Document::new(bm::Session::new());
    let mut s = bm::Session::new(); s.open(Path::new(HELI)).unwrap(); let n = s.piece_count();
    doc.replace(s);
    assert_eq!(doc.session().piece_count(), n); assert!(doc.viewport().is_some());
}
#[test] fn selection_round_trips() {
    let mut s = bm::Session::new(); s.open(Path::new(HELI)).unwrap();
    s.select(&[3, 5], bm::SelectMode::Replace); assert_eq!(s.selection(), vec![3, 5]);
    s.select(&[5], bm::SelectMode::Toggle); assert_eq!(s.selection(), vec![3]);
}
#[test] fn header_and_rust_decls_agree() {   // every BMFFI_API name in bmffi.h is declared in bm-sys
    let h = include_str!("../../../bmffi/include/bmffi.h");
    for name in h.split("BMFFI_API").skip(1).filter_map(|t| t.split('(').next()?.split_whitespace().last()) {
        assert!(bm_sys::DECLARED.contains(&name.trim_start_matches('*')), "missing {name}");
    }
}
```

(`bm_sys::DECLARED: &[&str]` lists the function names in the extern block.)

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd desktop && cargo test -p bm`
Expected: compile errors (crate items missing).

- [ ] **Step 3: Implement bm-sys (build.rs and the extern block) and the bm wrappers.** `BmString` becomes a `String` via `from_utf8_lossy`, then `bm_string_free`. Each wrapper calls the matching `bm_*` function.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `cd desktop && cargo test -p bm`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add desktop/Cargo.toml desktop/.gitignore desktop/crates/bm-sys desktop/crates/bm
git commit -m "feat(desktop): bm-sys and safe bm wrappers"
```

---

### Task 4: App shell in the locked layout

**Files:**
- Create: `desktop/crates/brickmotion/{Cargo.toml,src/main.rs,src/app.rs,src/theme.rs,src/icons.rs,src/commands.rs,src/chrome/mod.rs,src/chrome/titlebar.rs,src/chrome/ribbon.rs,src/chrome/browser.rs,src/chrome/properties.rs,src/chrome/viewbar.rs,src/chrome/navigator.rs,src/chrome/timeline.rs,tests/ui.rs}`, `desktop/crates/brickmotion/assets/icons/*.svg`

**Interfaces:**
- Consumes: `bm::Session` (title, piece_count) for the Browser root row and the title-bar status.
- Produces:

```rust
pub enum Workspace { Build, Animate }
pub struct Theme { pub bg0: Color32 /*#141518*/, pub bg1 /*#1a1b1f*/, pub bg2 /*#202227*/, pub bg3 /*#272a30*/,
  pub border /*#2c2f36*/, pub border2 /*#34383f*/, pub text1 /*#e8eaed*/, pub text2 /*#a4a9b1*/, pub text3 /*#6c727c*/,
  pub accent /*#4f8cff*/, pub playhead /*#ff9f43*/, pub radius: f32 /*6*/, pub grid: f32 /*8*/ }
pub fn apply(ctx: &egui::Context, t: &Theme);
pub enum Icon { Brick, Plus, Import, Inventory, Move, Rotate, Paint, Replace, Copy, Group, Extract, Step, Seat, Search,
  Eye, EyeOff, Sliders, Home, Undo, Redo, Close, Gear, Help, Grip, Chevron, Down, Up, Orbit, Pan, Fit, LookAt, Sun,
  Layers, Cam, Keys, Wave, Fly, Plan, Regen, Stage, Wand, Vid, Queue, Target, More }
pub fn icon(ui: &mut egui::Ui, i: Icon, size: f32, tint: Color32) -> egui::Response;
pub struct Command { pub id: &'static str, pub title: &'static str, pub icon: Icon, pub shortcut: Option<&'static str>,
  pub tip: &'static str, pub workspace: Workspace, pub tab: &'static str, pub group: &'static str, pub enabled: bool }
pub fn registry() -> &'static [Command];  // ribbon + Search commands read only this
pub struct BrickMotionApp { pub workspace: Workspace, pub ribbon_tab: &'static str, /* … */ }
impl BrickMotionApp { pub fn new(cc: &eframe::CreationContext, path: Option<PathBuf>) -> Self; }
impl eframe::App for BrickMotionApp { fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame); }
```

The registry holds exactly the ribbon content of `final-locked.html`:
- **Build tabs:** Model, Parts, Steps, Inspect, Suggest, View. The Model tab's groups are Insert (Add Part, Import, Inventory), Modify (Move, Rotate, Recolour, Replace, Duplicate), Arrange (Submodel, Extract, To Step), Fit (Seat Loose, What Fits) and Configure (Look, Build Settings).
- **Animate tabs:** Build Video, Keyframes, Camera, Motion, Sound, Output. The Build Video tab's groups are Plan (Plan Build, Regenerate, Order), Staging (Staging, Straighten, Flights), Keys (Add Key, Bake Flight, Group), Camera (Camera Key, Auto-direct, Follow) and Audio (Snap Sound, Mix). The Output tab holds Export Movie, Export Still and Render Queue.
- **Tips:** copy each hover-card tip from the mockup's `TIP` table.
- **Enabled in M1:** only `view.fit`, `view.home` and `file.open`. Every other command is visible but disabled, with the tip suffix " — coming soon".

Layout, all in egui:
- **Title bar** (`TopBottomPanel` 38 px): logo, Home, File, Undo/Redo (disabled), the document tab with the title, and the status text "`<n> pieces`" on the right.
- **Ribbon** (104 px): the left Workspace button (96 px wide); underlined tabs; groups of 56-px-wide icon+label tools, with group labels below and a 1-px divider between groups. The right column (250 px) holds the "Search commands ⌘K" field and, under it, the Build | Animate segmented switch.
- **Central area:** the viewport placeholder (Task 5 fills it) plus floating `egui::Area`s: the Browser (300 px, left/top 10 px; Models/Steps/Parts/Library tabs, filter field, root row with title and piece count), the Properties panel (292 px, right 10, top 122; it shows "Nothing selected", the title and the piece count when nothing is selected), the navigator (top right), the view bar (bottom centre) and the selection chip (bottom left).
- **Timeline** (`TopBottomPanel::bottom`, 220 px): only when `workspace == Animate`. It contains the header row (tool buttons, timecode `00:00:00`, transport, Tracks|Curves, zoom) and the four empty track rows Camera, Build, Keys, Snaps.

Icons:
- **Files:** 16×16 SVG with `stroke="currentColor" stroke-width="1.5"`. Copy the path data verbatim from `const I` / `Object.assign(I, …)` in `final-locked.html` (our own drawings).
- **Loading:** through `egui_extras::install_image_loaders` with `include_bytes!`.
- **Tint:** via `egui::Image::tint`.

- [ ] **Step 1: Write the failing UI tests** in `tests/ui.rs` with `egui_kittest::Harness` (size 1440×900)

```rust
#[test] fn build_has_no_timeline() {
    let mut h = harness(); // BrickMotionApp::new_for_test(None)
    assert!(h.query_by_label("Search commands").is_some());
    assert!(h.query_by_label("Snaps").is_none());          // timeline track
    h.get_by_label("Animate").click(); h.run();
    assert!(h.query_by_label("Snaps").is_some());
    assert!(h.query_by_label("Output").is_some());          // Animate ribbon tab
    h.get_by_label("Build").click(); h.run();
    assert!(h.query_by_label("Snaps").is_none());
}
#[test] fn workspace_button_mirrors_switch() {
    let mut h = harness(); h.get_by_label("Workspace").click(); h.run();
    assert_eq!(h.state().workspace, Workspace::Animate);
}
#[test] fn ribbon_comes_from_registry() {
    let h = harness();
    for c in registry().iter().filter(|c| c.workspace == Workspace::Build && c.tab == "Model") {
        assert!(h.query_by_label(c.title).is_some(), "{}", c.title);
    }
}
#[test] fn disabled_commands_say_so() {
    assert!(registry().iter().filter(|c| !c.enabled).all(|c| c.tip.ends_with(" — coming soon")));
}
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd desktop && cargo test -p brickmotion --test ui`
Expected: compile errors.

- [ ] **Step 3: Implement theme, icons, commands, the chrome modules and app.rs** as described above. `main.rs` sets the window to 1440×900 with min size 960×640, title "BrickMotion" and app id `com.brickmotion.studio.rs`, and `fullsize_content_view` so the custom title bar sits beside the traffic lights.

- [ ] **Step 4: Run the tests to make sure they pass, then compare with the mockup by eye**

Run: `cd desktop && cargo test -p brickmotion --test ui && cargo run -p brickmotion`
Expected: the tests pass. The window matches `final-locked.html` in both workspaces: the switch is under the search field, Build shows no timeline, Animate shows the timeline, and no emoji or unicode glyph is used as an icon. Take a screenshot of each workspace into `desktop/docs/m1-build.png` and `m1-animate.png`.

- [ ] **Step 5: Commit**

```bash
git add desktop/crates/brickmotion desktop/docs
git commit -m "feat(desktop): locked layout shell, theme, icons, command registry"
```

---

### Task 5: Viewport widget

**Files:**
- Create: `desktop/crates/brickmotion/src/viewport.rs`
- Modify: `desktop/crates/brickmotion/src/app.rs`, `src/chrome/viewbar.rs`, `src/chrome/navigator.rs`
- Test: `desktop/crates/brickmotion/src/viewport.rs` (unit tests)

**Interfaces:**
- Consumes: `bm::Document`, `bm::Viewport` (Task 3).
- Produces:

```rust
pub enum ViewOp { Orbit(f64,f64), Pan(f64,f64), ZoomToward(f64,f64,f64), Fit, Preset(bm::ViewPreset), Pick(f64,f64, bm::SelectMode) }
pub struct Gesture { pub primary_drag: Vec2, pub secondary_or_middle_drag: Vec2, pub scroll: Vec2, pub pinch: f32,
                     pub click: Option<(Pos2, Modifiers)>, pub double_click: bool, pub origin: Pos2 }
pub fn ops_for(g: &Gesture) -> Vec<ViewOp>;                    // pure; positions in points relative to the view's top-left
pub fn target_size(rect: Rect, pixels_per_point: f32) -> Option<(u32, u32, f64)>; // None when either side < 1 px
pub struct ViewportWidget { /* texture: Option<TextureHandle>, frame: bm::Frame, last_size */ }
impl ViewportWidget { pub fn show(&mut self, ui: &mut Ui, doc: &mut bm::Document); }
```

`ops_for` follows these rules:
- **Primary drag:** `Orbit(dx,dy)`. With ⌥ held, Pan.
- **Secondary or middle drag:** `Pan`.
- **Scroll and pinch:** `ZoomToward(1.0015^(scroll.y) * (1+pinch), x, y)`. A pinch alone is just `1+pinch`.
- **Click:** a click with no drag gives `Pick`. ⇧ makes it Add, ⌘ makes it Toggle, otherwise Replace.
- **Double-click on empty space:** `Fit`.

Each frame, `show` does the following:
1. Allocates the full central rect.
2. Calls `target_size`. On `None` it draws nothing and returns. This is Review Focus 3.
3. Calls `vp.resize(...)` when the size or pixels-per-point changed. This is Review Focus 4.
4. Applies the ops.
5. When `needs_draw()` or an op was applied, calls `draw()` and `read_frame`, then updates the texture. It uses `ctx.request_repaint()` while `draw()` returns true.

The background comes from the theme `bg1` (sRGB 0..1). The navigator's axis discs map Y→Top, X→Right and Z→Front, and its home button maps to `Fit`. The view bar has Orbit/Pan/Zoom mode toggles (which change what a primary drag does), Fit, Look At (disabled in M1), Home (Fit) and the Pieces popover. The popover lists Pieces checked, with Submodels, Whole step and Connections disabled.

- [ ] **Step 1: Write the failing unit tests**

```rust
#[test] fn drag_orbits_and_option_drag_pans() { /* primary_drag (10,-4) → [Orbit(10,-4)]; with alt → [Pan(10,-4)] */ }
#[test] fn scroll_zooms_toward_pointer() { /* scroll.y=100 at origin (50,60) → [ZoomToward(1.0015f64.powf(100.0), 50, 60)] */ }
#[test] fn click_picks_with_modifiers() { /* click+shift → Pick(..,Add); +cmd → Toggle; none → Replace */ }
#[test] fn double_click_fits() { /* double_click → [Fit] */ }
#[test] fn zero_size_viewport_skips_draw() { assert_eq!(target_size(Rect::from_min_size(Pos2::ZERO, vec2(800.0, 0.0)), 2.0), None); }
#[test] fn resize_tracks_pixels_per_point() {
    assert_eq!(target_size(Rect::from_min_size(Pos2::ZERO, vec2(400.0, 300.0)), 2.0), Some((800, 600, 2.0)));
    assert_eq!(target_size(Rect::from_min_size(Pos2::ZERO, vec2(400.0, 300.0)), 1.0), Some((400, 300, 1.0)));
}
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd desktop && cargo test -p brickmotion viewport::`
Expected: compile errors.

- [ ] **Step 3: Implement `ops_for`, `target_size` and `ViewportWidget::show`,** and wire the view bar, navigator and selection chip ("`<n> pieces` selected" from `session.selection().len()`; hidden when the selection is empty).

- [ ] **Step 4: Run the tests to make sure they pass, then try it by hand**

Run: `cd desktop && cargo test -p brickmotion && cargo run -p brickmotion -- ../samples/helicopter/helicopter.mpd`
Expected: the tests pass, and in the app:
- **Model:** the helicopter shows in the viewport.
- **Gestures:** drag orbits, right-drag pans, scroll zooms toward the pointer, and double-clicking empty space fits.
- **Selection:** clicking a piece selects it (the engine outlines it) and the chip shows "1 pieces selected".
- **Navigator:** its discs change the view.
- **Window moves:** dragging the window between a Retina and a non-Retina display keeps the picture sharp.

- [ ] **Step 5: Commit**

```bash
git add desktop/crates/brickmotion/src
git commit -m "feat(desktop): engine viewport with orbit, pan, zoom, fit, presets, pick"
```

---

### Task 6: Opening documents, snapshot flag, app bundle

**Files:**
- Create: `desktop/crates/brickmotion/src/loader.rs`, `src/snapshot.rs`, `desktop/scripts/bundle.sh`, `desktop/scripts/Info.plist`
- Modify: `src/main.rs`, `src/app.rs`, `src/chrome/titlebar.rs`, `src/chrome/browser.rs`
- Test: `desktop/crates/brickmotion/tests/open.rs`

**Interfaces:**
- Consumes: `bm::Session::open`, `bm::Document::{new, replace}`, `ViewportWidget`.
- Produces:

```rust
pub struct Loader;   // one load at a time; a newer request replaces an older pending one
impl Loader {
  pub fn start(&mut self, path: PathBuf);                       // spawns std::thread, opens into a fresh bm::Session
  pub fn poll(&mut self) -> Option<Result<(bm::Session, bm::OpenInfo), bm::OpenError>>; // UI thread, non-blocking
  pub fn loading(&self) -> Option<&Path>;
}
pub enum Notice { Error { title: String, detail: String }, Warning { title: String, detail: String } }
pub fn snapshot(path: &Path, out: &Path, size: (u32, u32)) -> Result<(), String>; // headless: open, fit, draw until idle, PNG
```

The app opens documents as follows:
- **Starting a load:** `file.open` (⌘O, the Home title-bar button, the ribbon Import tool) shows an `rfd::FileDialog` filtered to `brickmotion, json, ldr, mpd, dat, io` and calls `Loader::start`. A path on the command line does the same at launch.
- **While loading:** the Browser root row shows a spinner and "Opening <file name>…".
- **On success:** `doc.replace(loaded)`, then `fit_all`, and show warnings as a dismissible `Notice::Warning` at the bottom right. Its title is "Opened with warnings" and its detail lists the first 5 lines plus "and N more".
- **On failure:** keep the current document and show `Notice::Error`. Its title is "Couldn't open <file name>" and its detail is the engine message. This is Review Focus 1.

`main.rs` also accepts `--snapshot <out.png> [--size WxH] <path>`: it runs `snapshot` without opening a window and exits with 0, or with 1 and a stderr message.

`bundle.sh` builds `desktop/target/BrickMotion.app`:
- `Contents/MacOS/brickmotion`.
- `Contents/Frameworks/libbmffi.dylib`, with `install_name_tool -add_rpath @executable_path/../Frameworks`.
- `Info.plist` with `CFBundleIdentifier=com.brickmotion.studio.rs` and `CFBundleName=BrickMotion`. `.brickmotion` is registered with `LSHandlerRank=Alternate`.
- `codesign --force --sign -`.

- [ ] **Step 1: Write the failing tests** in `tests/open.rs`

```rust
#[test] fn open_runs_off_ui_thread() {          // Review Focus 2
    let mut l = Loader::default(); let ui = std::thread::current().id();
    l.start(HELI.into());
    let t0 = Instant::now(); let r = loop { if let Some(r) = l.poll() { break r } assert!(t0.elapsed() < Duration::from_secs(60)); std::thread::sleep(Duration::from_millis(5)) };
    let (s, _) = r.unwrap(); assert!(s.piece_count() > 100);
    assert_eq!(std::thread::current().id(), ui);   // poll never blocked on the open
}
#[test] fn newer_request_wins() { /* start(missing) then start(HELI) → the first poll result is Ok with the helicopter */ }
#[test] fn open_failure_keeps_previous_document() { // Review Focus 1, through the app state
    let mut app = BrickMotionApp::new_for_test(Some(HELI.into())); app.wait_loaded();
    let n = app.session().piece_count();
    app.open(PathBuf::from("/no/such/file.mpd")); app.wait_loaded();
    assert_eq!(app.session().piece_count(), n);
    assert!(matches!(app.notices().last(), Some(Notice::Error { title, .. }) if title == "Couldn't open file.mpd"));
}
#[test] fn snapshot_writes_png() {
    let out = std::env::temp_dir().join("bm-m1-snap.png");
    snapshot(Path::new(HELI), &out, (640, 400)).unwrap();
    let img = image::open(&out).unwrap(); assert_eq!((img.width(), img.height()), (640, 400));
}
```

(`BrickMotionApp::new_for_test`, `wait_loaded`, `open`, `session` and `notices` are `#[doc(hidden)] pub` test hooks.)

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `cd desktop && cargo test -p brickmotion --test open`
Expected: compile errors.

- [ ] **Step 3: Implement the loader, the notices (bottom-right stack, 8-px radius, an icon tinted by kind, a close button), the open flow, the snapshot path and the bundle script.**

- [ ] **Step 4: Run all tests and the end-to-end checks**

Run: `cd desktop && cargo test --workspace && cargo run -p brickmotion --release -- --snapshot /tmp/bm-heli.png ../samples/helicopter/helicopter.mpd && ./scripts/bundle.sh && open target/BrickMotion.app`
Expected:
- **Tests:** all pass, and `/tmp/bm-heli.png` shows the helicopter.
- **App launch:** the app opens from Finder.
- **Large model:** opening `samples/` Sagrada 21065, or the largest `.mpd` in the repo, keeps the window responsive with the Browser spinner showing.
- **Bad file:** opening a `.stl` shows "Couldn't open …" and leaves the previous model on screen.
- **Swift app:** `ctest --test-dir native/build-app` still passes.

- [ ] **Step 5: Commit**

```bash
git add desktop/crates/brickmotion desktop/scripts
git commit -m "feat(desktop): background open, notices, snapshot, app bundle"
```

---

## After milestone 1

Milestones 2–8 from the spec each get their own plan when milestone 1 has shipped:

- **M2 Document:** save, autosave, recents, undo, tree, selection, properties, menus, palette, and the shared-GPU-texture viewport.
- **M3 Editing.**
- **M4 Build & play.**
- **M5 Animate & camera,** where the professional timeline gets its full behaviour.
- **M6 Render & export.**
- **M7 Extras.**
- **M8 Parity sweep.**

Each plan starts from the parity ledger rows for its area.
