# Native Rewrite Phases 0–1 (Baseline and Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the current engine over a fixed corpus, then build the C++ core (`bmcore` + `bm` CLI) that loads every model in that corpus.

**Architecture:** Phase 0 adds TypeScript scripts that run the existing engine headless and write a scoreboard. Phase 1 creates `native/` with a portable C++20 static library (`bmcore`), Catch2 tests and a CLI. Nothing in `src/` changes.

**Tech Stack:** C++20, CMake ≥ 3.28, Catch2 v3, nlohmann/json, miniz (all via `FetchContent`, pinned by tag); TypeScript + tsx for phase 0.

**Spec:** `docs/superpowers/specs/2026-11-15-native-rewrite-design.md`

## Global Constraints

- All new native code lives in `native/`. `bmcore` includes no Apple headers.
- macOS 15+, Apple silicon only; C++20; `-Wall -Wextra -Werror`.
- Third-party code limited to: Catch2, nlohmann/json, miniz (this plan). No Qt, no Boost.
- No per-set special cases in engine code.
- The plan file schema (`src/plan/schema.ts`) is kept; new fields are additive; unknown fields survive a read→write round trip.
- The web app keeps working: no edits under `src/`.
- Data is read from outside `native/`, located by environment variables: `BM_LDRAW_DIR` (default `<repo>/public/ldraw`), `BM_DATA_DIR` (default `/Users/mac/Projects/BrickMotion-Data`). Never copy the corpus into the repo (disk is tight: ~18 GB free).
- Namespace `bm`. Lengths in LDU, doubles in the engine. LDraw axes (−Y up).
- Work on a new branch `feat/native-engine`; commit after each task.
- Long runs (corpus audits) go through `jw run` and print `::progress n/N`.

## Review Focus

1. A malformed or truncated LDraw line (too few numbers, `NaN`, stray text): the line is skipped and counted in `LDrawFile::skipped`; loading never crashes.
2. A reference to a part or submodel that does not exist: the model still loads, the name is listed in `LoadReport::missing`, the piece is kept with no geometry.
3. A submodel that references itself, directly or through a chain: reported in `LoadReport::cycles`, the cycle edge dropped, no infinite recursion.
4. File names with spaces, backslashes, mixed case, or a `s\` / `48\` prefix: resolved the way LDraw tools resolve them.
5. A corrupt, truncated or old-version part-cache file: detected, rebuilt, never read as valid.

Each has a named test in the owning task below (Tasks 4, 9, 9, 5, 8).

---

## File Structure

```
scripts/native/corpus-manifest.ts      builds the corpus list
scripts/native/baseline-audit.ts       runs the current engine over it
scripts/native/baseline-worker.ts      one model per child process
native/CMakeLists.txt                  top-level build, FetchContent pins
native/corpus/manifest.json            generated; committed
native/corpus/baseline.json            generated summary; committed
native/core/include/bm/*.h             public headers
native/core/src/<module>/*.cpp         math, ldraw, cache, jobs, model, io, audit
native/tools/bm/main.cpp               CLI
native/tests/<module>_test.cpp         Catch2 tests
native/tests/fixtures/                 small hand-written .ldr/.mpd/.json
```

## Scoreboard format (shared by both engines)

One JSON object per model, and a summary. Fields a phase has not reached are absent.

```json
{ "id": "omr/10001-1/main.mpd", "engine": "web|native", "ok": true, "error": null,
  "pieces": 412, "unknownParts": ["x123.dat"], "missingSubmodels": [],
  "loadMs": 81.2,
  "joined": 398, "groups": 3, "overlaps": 0, "floating": 2,
  "planOk": true, "planMs": 5120.4, "planFlagged": 0 }
```

Summary: `{ "engine", "date", "models", "failed", "totals": {…sums…}, "p50": {…}, "p95": {…} }`.

---

## Phase 0 — corpus and baseline

### Task 1: Corpus manifest

**Files:**
- Create: `scripts/native/corpus-manifest.ts`, `native/corpus/manifest.json`
- Test: `tests/scripts/corpusManifest.test.ts`

**Interfaces:**
- Produces: `buildManifest(dataDir: string, repoDir: string): CorpusEntry[]` where
  `type CorpusEntry = { id: string; path: string; source: 'omr'|'bricknet'|'reference'|'fixture'; tier: 'smoke'|'full' }`.
  `id` is the path relative to its source root, prefixed by source (`omr/10001-1/…`). `path` is relative to `BM_DATA_DIR` for omr/bricknet and to the repo for the others.

Corpus contents:
- **omr:** every `.mpd`/`.ldr` under `BM_DATA_DIR/omr/models`.
- **bricknet:** a fixed sample of 2,000 of `BM_DATA_DIR/bricknet/models/*.ldr`, chosen by sorting names and taking every ⌊N/2000⌋-th (deterministic, no RNG). The native engine may later run all 67,185; the baseline uses the sample.
- **reference:** `samples/helicopter/helicopter.mpd`, `samples/8880-1-axle-fix.mpd`, `public/data/test-10001.mpd`, and any file in `samples/` whose name starts with `5590`, `8880`, `10156`, `42000`, `21065`.
- **fixture:** `*.mpd`/`*.ldr` under `tests/fixtures`.
- `tier: 'smoke'` for all reference and fixture entries plus the first 25 omr and first 25 bricknet entries; everything else `full`.

- [ ] **Step 1: Write the failing test** — `buildManifest` on a temp directory tree with 3 omr files, 5,000 bricknet files and 1 fixture returns 3 + 2,000 + 1 entries, sorted by `id`, identical on a second call, with every `path` existing.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/corpusManifest.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `buildManifest` and a `main` that writes `native/corpus/manifest.json` (2-space JSON, trailing newline).
- [ ] **Step 4: Run the test** — PASS. Then `npx tsx scripts/native/corpus-manifest.ts`; expect a line `manifest: <n> entries (omr <a>, bricknet 2000, reference <b>, fixture <c>)`.
- [ ] **Step 5: Commit** `feat(native): corpus manifest`.

### Task 2: Baseline audit of the current engine

**Files:**
- Create: `scripts/native/baseline-worker.ts`, `scripts/native/baseline-audit.ts`, `native/corpus/baseline.json`
- Test: `tests/scripts/baselineWorker.test.ts`

**Interfaces:**
- Consumes: `CorpusEntry`; from the app: `importLDraw` (`src/io/ldrawImport.ts`), `PartLibrary` (`src/ldraw/library.ts`) with a Node `FetchText` reading `BM_LDRAW_DIR`, `measurePart`, `assemble`, `validate`, `modelConnections` (`src/plan/connectionGraph.ts`), `planConstruction` (`src/anim/construction/planner.ts`). Follow `scripts/collision-audit.ts` and `scripts/benchmark-large-model.ts` for how a script loads parts headless.
- Produces: `auditModel(entry: CorpusEntry, opts: { plan: boolean }): Promise<ScoreRow>` (the scoreboard object above, `engine: 'web'`).

Rules:
- `joined` = pieces in the largest connected component of `modelConnections`; `groups` = number of components.
- `overlaps` / `floating` = counts of `validate` warnings of those kinds.
- Planning uses the app's default options; `planOk` is false on any `ConstructionError`, with `error` set to its code.
- From a successful plan also record `buildFloating`: walking the plan's operations in build order, the number of pieces that, when placed, share no `modelConnections` edge with any piece already placed (the first piece of the model is exempt). This is the baseline for the spec's "no floating pieces during build" rule.
- `baseline-audit.ts` runs one child process per model (`--max-old-space-size=4096`), 4 at a time, 180 s timeout each; a timeout or crash writes `{ ok:false, error:'timeout'|'crash' }` and continues. Rows go to `.cache/native-baseline/<id>.json` (not committed); the run is resumable (existing rows are skipped). `--tier smoke|full`, `--no-plan`.
- Prints `::progress n/N`. At the end writes `native/corpus/baseline.json` (summary only).

- [ ] **Step 1: Write the failing test** — `auditModel` on `public/data/test-10001.mpd` with `plan:false` returns `ok:true`, `pieces > 0`, `joined ≤ pieces`, `loadMs > 0`; on a fixture containing one unknown part returns that name in `unknownParts` and still `ok:true`.
- [ ] **Step 2: Run it** — FAIL.
- [ ] **Step 3: Implement** worker and runner.
- [ ] **Step 4: Run the test** — PASS.
- [ ] **Step 5: Run smoke tier:** `npx tsx scripts/native/baseline-audit.ts --tier smoke`. Expected: finishes, summary printed, no uncaught exception.
- [ ] **Step 6: Run full tier in the background:** `jw run --name native-baseline -- caffeinate -i npx tsx scripts/native/baseline-audit.ts --tier full`. Phase 1 does not wait for it. When done, record in the spec's Goals section the measured joined %, plan success % and p50/p95 plan time, and restate the speed targets against them.
- [ ] **Step 7: Commit** `feat(native): baseline audit of the web engine` (scripts and `baseline.json`).

---

## Phase 1 — core

### Task 3: Build skeleton and CLI

**Files:**
- Create: `native/CMakeLists.txt`, `native/core/CMakeLists.txt`, `native/tools/bm/main.cpp`, `native/tests/CMakeLists.txt`, `native/tests/version_test.cpp`, `native/core/include/bm/version.h`, `native/core/src/version.cpp`, `native/README.md`, `native/.gitignore` (`build/`)

**Interfaces:**
- Produces: targets `bmcore` (static), `bm` (executable), `bmcore_tests`; `const char* bm::version()` returning `"0.1.0"`; CLI dispatch `bm <command> [args]`, exit code 0 on success, 2 on usage error, 1 on failure; `bm version` prints `bm 0.1.0`.
- Pins: Catch2 `v3.7.1`, nlohmann/json `v3.11.3`, miniz `3.0.2`. `CMAKE_OSX_DEPLOYMENT_TARGET=15.0`, `CMAKE_OSX_ARCHITECTURES=arm64`, Release has `-O3 -flto`, a `BM_SANITIZE` option turns on ASan+UBSan for tests.

- [ ] **Step 1: Write** `version_test.cpp`: `REQUIRE(std::string(bm::version()) == "0.1.0")`.
- [ ] **Step 2: Configure and build:** `cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build native/build` — FAIL until sources exist.
- [ ] **Step 3: Implement** the skeleton.
- [ ] **Step 4: Run** `ctest --test-dir native/build --output-on-failure` — PASS; `native/build/tools/bm/bm version` prints `bm 0.1.0`; `bm nope` exits 2.
- [ ] **Step 5: Commit** `feat(native): build skeleton, bmcore, bm CLI`.

### Task 4: Math and LDraw parser

**Files:**
- Create: `native/core/include/bm/math.h`, `native/core/include/bm/ldraw/parse.h`, `native/core/src/ldraw/parse.cpp`
- Test: `native/tests/math_test.cpp`, `native/tests/ldraw_parse_test.cpp`

**Interfaces — produces:**
```cpp
namespace bm {
struct Vec3 { double x, y, z; };            // + - * dot cross length normalized
struct Mat3 { double m[9]; };               // row-major, LDraw a..i
struct Xform { Mat3 r; Vec3 t; };           // p' = r*p + t; operator*, inverse(), identity()
struct Box { Vec3 min, max; bool empty() const; void grow(Vec3); Box transformed(const Xform&) const; };
double determinant(const Mat3&);

namespace ldraw {
enum class Cmd : uint8_t { Ref, Line, Tri, Quad, Step, Bfc };
struct Command {
  Cmd type; int color = 16;
  Xform xf;                 // Ref
  std::string file;         // Ref: normalised name
  bool invert = false;      // Ref: preceded by BFC INVERTNEXT
  std::string group;        // Ref: MLCAD BTG / LeoCAD GROUP
  double pts[12];           // Line(6) Tri(9) Quad(12)
  enum class Wind : uint8_t { None, CCW, CW } winding = Wind::None;  // Bfc
  enum class Cert : uint8_t { None, CCW, CW, NoCertify } cert = Cert::None;
  int8_t clip = -1;         // Bfc: -1 unset, 0 noclip, 1 clip
};
struct File { std::string name, description, category; std::vector<std::string> help;
              std::vector<Command> cmds; int skipped = 0; };
std::string normalizeName(std::string_view);          // trim, '\'→'/', lower-case
File parse(std::string_view text, std::string_view name = "main.ldr");
std::vector<File> parseMpd(std::string_view text, std::string_view name);  // splits on "0 FILE"; a file with no FILE lines yields one File
}}
```
Behaviour matches `src/ldraw/parse.ts` (description on first comment line, `STEP`, `BFC` forms, `INVERTNEXT`, MLCAD/LeoCAD groups, `!CATEGORY`, `!HELP`, names with spaces taken from token 15 to end of line). Line types 5 (conditional lines) are ignored. Numbers parsed with `std::from_chars`.

- [ ] **Step 1: Write failing tests:**
  - math: `Xform * inverse == identity` within 1e-12 for a rotated, translated transform; `Box.transformed` of a unit box by a 90° turn has the expected corners.
  - parse: a 1-line ref gives `file == "3001.dat"`, `xf.t == {0,-24,0}`, `color == 4`; `"1 4 0 0 0 1 0 0 0 1 0 0 0 1 s\\My Part.DAT"` → `"s/my part.dat"`; CRLF input equals LF input; `0 BFC INVERTNEXT` sets `invert` on the next ref only; `0 STEP` yields `Cmd::Step`.
  - **Review Focus 1:** `"1 4 0 0 0"`, `"3 16 1 2 x 4 5 6 7 8 9"`, `"9 garbage"` and a ref with `nan` are each skipped, `skipped == 4`, no throw; a 5 MB buffer of random bytes parses without crashing.
  - `parseMpd` on a 3-file MPD returns 3 files with normalised names; inline `0 !DATA` blocks are skipped.
- [ ] **Step 2: Build and run** `ctest -R "math|ldraw_parse"` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(native): math types and LDraw parser`.

### Task 5: Part library and colours

**Files:**
- Create: `native/core/include/bm/ldraw/library.h`, `native/core/src/ldraw/library.cpp`, `native/core/src/ldraw/colors.cpp`
- Test: `native/tests/ldraw_library_test.cpp`, fixtures under `native/tests/fixtures/lib/`

**Interfaces — produces:**
```cpp
namespace bm::ldraw {
enum class Finish : uint8_t { Solid, Chrome, Metal, Pearl, Rubber, Trans };
struct Color { int code; std::string name; uint32_t rgb, edge; float alpha; Finish finish; };
class Library {
 public:
  explicit Library(std::filesystem::path root);          // the LDraw directory
  void addSearchRoot(std::filesystem::path);             // e.g. unofficial parts
  void addInline(std::vector<File> mpdFiles);            // MPD subfiles shadow disk files
  const File* find(std::string_view name) const;         // thread-safe, parsed once, cached; nullptr if absent
  std::optional<std::filesystem::path> resolve(std::string_view name) const;
  const std::unordered_map<int, Color>& colors() const;  // from LDConfig.ldr
  uint64_t contentHash(std::string_view name) const;     // hash of the file's bytes; 0 if absent
};
}
```
Resolution order for a normalised name: inline MPD files, then under each root `parts/`, `p/`, `models/`, the root itself, `unofficial/parts/`, `unofficial/p/`. A name already carrying `s/`, `48/` or `8/` resolves under `parts/` or `p/` respectively. Lookups are case-insensitive: the library indexes directory listings once at construction (lower-cased), it does not probe the filesystem per name.

- [ ] **Step 1: Write failing tests** on a fixture tree (`parts/3001.dat`, `parts/s/3001s01.dat`, `p/stud.dat`, `p/48/1-4cyli.dat`, `LDConfig.ldr` with 3 colours incl. one `ALPHA 128` and one `CHROME`):
  - `find("3001.dat")`, `find("s\\3001S01.DAT")`, `find("48\\1-4cyli.dat")`, `find("STUD.DAT")` all non-null — **Review Focus 4**.
  - `find("nope.dat") == nullptr`; inline file named `3001.dat` wins over disk.
  - colours: code, rgb, alpha `128/255`, finish `Trans`/`Chrome`.
  - 8 threads calling `find` on the same 50 names return identical pointers (run under `BM_SANITIZE`).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement. Step 4: Run** — PASS.
- [ ] **Step 5:** With `BM_LDRAW_DIR` set, a test tagged `[data]` asserts `find("3001.dat")` and `colors().at(4).name == "Red"`; it is skipped when the variable is unset.
- [ ] **Step 6: Commit** `feat(native): part library and colour table`.

### Task 6: Flatten parts to meshes

**Files:**
- Create: `native/core/include/bm/ldraw/mesh.h`, `native/core/src/ldraw/flatten.cpp`
- Test: `native/tests/ldraw_flatten_test.cpp`

**Interfaces — produces:**
```cpp
namespace bm::ldraw {
struct Mesh {
  std::vector<float> positions;        // xyz per vertex, part space, LDU
  std::vector<uint32_t> triangles;     // 3 indices, outward CCW
  std::vector<int32_t> triColor;       // per triangle; 16 = inherit
  std::vector<float> edges;            // xyz pairs (type-2 lines)
  Box bounds;
  std::vector<std::string> missing;    // subfiles not found
  uint64_t sourceHash;                 // combined contentHash of every file visited
};
struct FlattenOptions { bool hiResPrimitives = false; bool logoStuds = false; };
Mesh flatten(std::string_view partName, const Library&, const FlattenOptions& = {});
}
```
Rules: recursive subfile expansion with accumulated transform and colour (16 inherits, 24 is edge colour); BFC: honour `CERTIFY`, winding, `INVERTNEXT`, and flip winding when the accumulated matrix determinant is negative; uncertified geometry is emitted double-sided flagged by duplicating triangles in both windings; quads split into two triangles; vertices welded at 1e-4 LDU. Recursion depth capped at 64 — deeper is a cycle: stop and record the name in `missing`. Reference: `src/ldraw/flatten.ts` (do not port its shadow/bevel handling; those belong to later phases).

- [ ] **Step 1: Write failing tests:**
  - fixture box part (12 triangles, certified CCW): 8 welded vertices, bounds exact, signed volume `> 0` and equal to w·h·d within 1e-6.
  - the same box referenced through a mirroring matrix (`-1 0 0 / 0 1 0 / 0 0 1`): signed volume still `> 0`.
  - `INVERTNEXT` on a subfile flips that subfile only.
  - colour: a subfile drawn in 16 under a ref in colour 4 gets `triColor == 4`; an explicit colour 1 inside stays 1.
  - a part referencing a missing subfile: returns the rest, `missing == {"gone.dat"}`.
  - a part that references itself: terminates, name in `missing`.
  - `[data]`: `3005.dat` bounds are `x,z ∈ [-10,10]`, `y ∈ [-4,24]`; `3001.dat` signed volume `> 0`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement. Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(native): flatten LDraw parts to meshes`.

### Task 7: Job pool

**Files:**
- Create: `native/core/include/bm/jobs.h`, `native/core/src/jobs/pool.cpp`
- Test: `native/tests/jobs_test.cpp`

**Interfaces — produces:**
```cpp
namespace bm {
class CancelToken { public: void cancel(); bool cancelled() const; };
class JobPool {
 public:
  explicit JobPool(unsigned threads = 0);     // 0 = hardware_concurrency
  unsigned threads() const;
  // Calls fn(i) for i in [0,n) across the pool; blocks until done. Rethrows the
  // first exception after all running calls finish. Stops handing out indices once
  // token is cancelled. progress(done, n) is called on the calling thread.
  void parallelFor(size_t n, const std::function<void(size_t)>& fn,
                   const CancelToken* token = nullptr,
                   const std::function<void(size_t, size_t)>& progress = {});
  static JobPool& shared();
};
}
```
Nested `parallelFor` from inside a job runs inline on the calling worker (no deadlock).

- [ ] **Step 1: Write failing tests:** sum of 1..1,000,000 via `parallelFor` into per-index slots equals the serial sum; an exception thrown at index 7 is rethrown and no later crash; cancelling at index 10 of 10,000 runs fewer than 10,000 calls; nested call completes; `threads()==1` pool runs everything in index order.
- [ ] **Step 2: Run** (with `BM_SANITIZE=ON`, TSan variant) — FAIL. **Step 3: Implement. Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(native): job pool`.

### Task 8: Binary part cache

**Files:**
- Create: `native/core/include/bm/ldraw/part_cache.h`, `native/core/src/cache/part_cache.cpp`
- Test: `native/tests/part_cache_test.cpp`

**Interfaces:**
- Consumes: `flatten`, `Library::contentHash`, `Mesh::sourceHash`.
- Produces:
```cpp
namespace bm::ldraw {
class PartCache {
 public:
  PartCache(const Library&, std::filesystem::path cacheDir, FlattenOptions = {});
  std::shared_ptr<const Mesh> get(std::string_view partName);   // thread-safe; memory → disk → flatten
  struct Stats { size_t memoryHits, diskHits, flattened, rebuilt; };
  Stats stats() const;
};
}
```
File per part `<cacheDir>/<name with '/'→'_'>.bmp1`: header `{ char magic[4]="BMP1"; uint32 version=1; uint64 sourceHash; uint64 payloadBytes; uint64 payloadChecksum; }` then the arrays, little-endian, read with `mmap`. A file is valid only if magic, version, checksum match **and** `sourceHash` equals the hash recomputed from the files listed in a trailing dependency table (names + hashes). Writes go to a temp file then `rename`. Default cache dir for the CLI: `~/Library/Caches/BrickMotion/parts`.

- [ ] **Step 1: Write failing tests** (fixture library, temp cache dir):
  - first `get` → `flattened==1`; a new `PartCache` on the same dir → `diskHits==1, flattened==0`, mesh equal to the original.
  - editing a subfile the part depends on → next cache instance has `rebuilt==1` and the new geometry.
  - **Review Focus 5:** truncating the cache file to half, flipping one payload byte, and writing `version=99` each lead to `rebuilt==1` and a correct mesh; none crashes.
  - 8 threads requesting the same 20 parts: each part flattened exactly once.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement. Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(native): binary part cache`.

### Task 9: Model, plan files, import and export

**Files:**
- Create: `native/core/include/bm/model.h`, `native/core/include/bm/io.h`, `native/core/src/model/model.cpp`, `native/core/src/io/plan_json.cpp`, `native/core/src/io/ldraw_io.cpp`, `native/core/src/io/project.cpp`, `native/core/src/io/studio_io.cpp`
- Test: `native/tests/model_test.cpp`, `native/tests/io_test.cpp`, fixtures

**Interfaces — produces:**
```cpp
namespace bm {
struct Piece {                       // one placed part, flattened out of submodels
  std::string id;                    // stable: "<model path>/<item id or index>"
  std::string part; int color;
  Xform world;                       // LDU
  int step;                          // global step index
  std::vector<std::string> path;     // submodel names from the root
};
struct LoadReport { std::vector<std::string> missing, cycles, unknownColors; int skippedLines = 0; };
class Model {
 public:
  const std::vector<Piece>& pieces() const;
  const std::vector<std::string>& submodels() const;
  int stepCount() const;
  Box bounds(ldraw::PartCache&) const;
  const LoadReport& report() const;
};
namespace io {
enum class Format { LDraw, Plan, Project, StudioIo };
Format sniff(const std::filesystem::path&, std::string_view head);
Model load(const std::filesystem::path&, const ldraw::Library&);           // any format
std::string toLDraw(const Model&);                                          // MPD text
struct PlanDoc { nlohmann::ordered_json json; };                            // the plan file, verbatim
PlanDoc readPlan(std::string_view text);                                    // throws io::Error with a message list
std::string writePlan(const PlanDoc&);
Model fromPlan(const PlanDoc&, const ldraw::Library&, ldraw::PartCache&);
}}
```
Rules:
- LDraw/MPD: the first file is the root; a ref to an inline file or to a `models/` file is a submodel and is expanded; any other ref is a piece. `0 STEP` advances the step; a submodel's pieces take the step of the ref that placed them (sub-steps are preserved in `path` order).
- Plan JSON: read with `ordered_json` and kept verbatim so unknown and future fields survive. Grid placements (`x,z` studs, `y` plates, `rot`) convert as `src/model/assemble.ts` `itemPlacement`/`placementMatrix` do (stud = 20 LDU, plate = 8 LDU, −Y up, min corner of the rotated footprint — this needs the part's bounds from the cache). Raw placements (`ldu`, `matrix`) are used as is.
- Project (`.brickmotion`): JSON per `src/io/projectFile.ts`; take its `plan`, ignore timelines for now but keep them in the document.
- Studio `.io`: a zip; read `model.ldr` (or `model2.ldr` when present) per `src/io/studioIo.ts`, including its password handling, using miniz.

- [ ] **Step 1: Write failing tests:**
  - MPD with a submodel used twice: `pieces().size()` equals parts × uses, world transforms compose, `path` set, steps counted.
  - **Review Focus 2:** a ref to `gone.dat` → piece kept, `report().missing == {"gone.dat"}`; a ref to a missing submodel likewise.
  - **Review Focus 3:** `a.ldr`→`b.ldr`→`a.ldr` and a file referencing itself: load returns, `report().cycles` names the edge, pieces outside the cycle are present.
  - `toLDraw(load(x))` reloaded gives the same pieces (part, colour, transform within 1e-6, step).
  - plan round trip: `writePlan(readPlan(t))` parsed equals `t` parsed for `public/data/test-small.plan.json` and `mini-jet.plan.json`, and for a copy with an added unknown field at top level, on a step and on a piece.
  - `fromPlan` on `test-small.plan.json`: piece count equals the JSON's item count; a 2×4 brick at grid `{x:0,y:0,z:0,rot:0}` has world bounds `x∈[0,80] z∈[0,40]` bottom at `y=0` (`[data]`).
  - invalid plan JSON (not an object; `models` missing) throws `io::Error` with a non-empty message; a 0-byte file and a non-UTF-8 file give an error, not a crash.
  - `sniff` distinguishes all four formats by content, not extension.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement. Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(native): model, plan files, LDraw/project/Studio import`.

### Task 10: `bm load` and `bm audit` over the corpus

**Files:**
- Create: `native/core/include/bm/audit.h`, `native/core/src/audit/audit.cpp`, `native/tools/bm/cmd_load.cpp`, `native/tools/bm/cmd_audit.cpp`, `native/tools/compare_scoreboards.py`
- Modify: `native/tools/bm/main.cpp`
- Test: `native/tests/audit_test.cpp`

**Interfaces:**
- Consumes: everything above; `native/corpus/manifest.json`.
- Produces:
```cpp
namespace bm::audit {
struct Row { std::string id; bool ok; std::string error; int pieces;
             std::vector<std::string> unknownParts, missingSubmodels; double loadMs; };
Row loadRow(const std::filesystem::path& file, std::string id, const ldraw::Library&, ldraw::PartCache&);
nlohmann::json toJson(const Row&);          // scoreboard format, engine "native"
nlohmann::json summarize(const std::vector<Row>&);
}
```
- CLI: `bm load <file> [--json]` prints pieces, steps, submodels, bounds, missing names, load time. `bm audit --manifest <path> [--tier smoke|full] [--out <dir>] [--threads N]` loads every entry in parallel (one model per job; meshes for every distinct part are fetched so the cache is exercised), writes `<out>/rows.jsonl` and `<out>/summary.json`, prints `::progress n/N`, exits 0 even when models fail (failures are data), 1 only on bad arguments or unreadable manifest. A C++ exception in one model becomes `ok:false,error:<what>`.
- `compare_scoreboards.py <web rows dir> <native rows.jsonl>` prints, for models both loaded: count where `pieces` differ, and set differences of `unknownParts`.

- [ ] **Step 1: Write failing tests:** `loadRow` on a fixture gives the right `pieces`; on a file with an unknown part lists it and stays `ok`; on a directory path gives `ok:false` with an error; `summarize` totals match.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement. Step 4: Run** — PASS.
- [ ] **Step 5: Smoke:** `bm audit --manifest native/corpus/manifest.json --tier smoke --out .cache/native-audit/smoke`. Expected: every row `ok:true`.
- [ ] **Step 6: Full:** `jw run --name native-audit -- native/build/tools/bm/bm audit --manifest native/corpus/manifest.json --tier full --out .cache/native-audit/full`. **Acceptance for phase 1:**
  - 0 crashes; every `ok:false` row has an explained cause (file genuinely unreadable).
  - `compare_scoreboards.py` against the baseline: piece counts equal on ≥ 99% of models both engines loaded; each difference is looked at and either fixed or written down in `native/README.md` with the reason.
  - Sagrada 21065 (if present in `samples/`) loads cold in < 5 s and warm (cache hit) in < 1 s on the M1 Pro; record both numbers, and total audit wall time, in `native/README.md`.
- [ ] **Step 7: Commit** `feat(native): bm load and corpus audit`.

---

## After this plan

Phase 2 (connector database and connection graph) gets its own plan, written against the measured baseline columns from Task 2.
