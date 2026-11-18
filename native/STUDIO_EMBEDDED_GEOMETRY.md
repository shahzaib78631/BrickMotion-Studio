# BrickMotion — Studio embedded custom-part geometry importer

Implemented on top of `BrickMotion-M1-optimized.zip` (18 November 2026).

## What changed

The previous Studio `.io` reader extracted `model.ldr` but **discarded** `CustomParts/*.dat`. That made custom items appear with empty geometry or placeholder dimensions unless their names already happened to exist in the installed LDraw library. Consequently, custom-part collision results could be absent or incomplete.

The new importer provides **model-scoped, reference-driven embedded LDraw geometry**:

1. Validates the `.io` archive's end record, central directory, local headers and entry sizes before accessing entry bytes; supports stored/deflate and the traditional Studio/PKZIP encryption. Validates extracted CRC and exact uncompressed lengths. Does not extract files to the filesystem.
2. Indexes embedded `.dat` files by normalized, case-insensitive LDraw name. Maps `CustomParts/<part>.dat` to `<part>.dat`, `CustomParts/p/<primitive>.dat` to `<primitive>.dat`, `CustomParts/p/48/<primitive>.dat` to `48/<primitive>.dat`, and `CustomParts/s/s/<subpart>.dat` to `s/<subpart>.dat`. Also accepts `CustomParts/parts/...`.
3. Parses the model's MPD sections, follows references into embedded parts, recursively follows subpart/primitive references, and inflates **only reachable** embedded `.dat` entries. Ignores irrelevant thumbnail/image/model-version resources. Rejects aliases that map to the same normalized part name, unsafe paths, corrupt referenced entries and excessive geometry resources.
4. Adds parsed files to the model's own `ldraw::Library`, with precedence **MPD inline definitions > Studio embedded custom parts > installed disk library**. The global disk library and part cache are not modified. Existing model-local mesh caching (`Model::mesh`) shares flattened meshes with the collision and rendering subsystems without rebuilding each mesh per collision world.
5. Adds the embedded files to `Model::inlineParts()`, so `io::toLDraw()` exports self-contained geometry in an MPD rather than losing it during a save/export round trip. `bm load --json` now shows how many embedded `.dat` files were available versus reachable and loaded.

## Safety / performance bounds

- Maximum `.io` byte size: 96 MiB; main LDraw file: 32 MiB; ZIP directory: 12,000 entries.
- Maximum indexed custom `.dat` entries: 4,096; maximum extracted custom part: 16 MiB; combined extracted custom-part text: 64 MiB.
- Maximum parsed commands: 250,000 per custom part and 750,000 across all imported custom parts. The legacy LDraw flatten recursion cap of 64 levels still applies; cyclic references remain reported through mesh dependencies.
- No filesystem extraction, network access, runtime plugin download or globally installed part overrides.
- All custom data stays within its `Model` and can be shared across safe copies through existing model-scoped caching.

## Validation accomplished in this environment

The portable C++ importer, LDraw parser, model/mesh pipeline and collision-shape builder were compiled with `-Wall -Wextra -Werror` and exercised against the two uploaded real `.io` models. The standalone Linux harness used a **zlib-backed compatibility header for miniz**; the code in the project continues to use the existing `miniz` 3.0.2 dependency on macOS. The shape tests used the small repository LDraw fixture library, not the user's complete LDraw installation.

| Real Studio model | Expanded pieces | Embedded `.dat` imported | Distinct placed custom parts with collision shapes | Triangles in these placed custom-part meshes | Unresolved references inside these custom meshes | MPD geometry round trip |
|---|---:|---:|---:|---:|---:|---|
| `MOC-272851_TheDeeGee_Simtek_S941.io` | 789 | 124 / 124 | 28 / 28 | 40,378 | 0 | Matched |
| `Ma Odele's.io` | 2,119 | 23 / 23 | 8 / 8 | 9,056 | 0 | Matched |

The test archives in `tests/fixtures/studio/` cover plain, stored, traditionally encrypted, nested primitive/subpart geometry, unreferenced entries, CRC failure, unsafe paths, alias collisions, uncompressed-size limits and **two independent model scopes containing different parts with the same name**. The focused ZIP importer security harness also ran with AddressSanitizer and UndefinedBehaviorSanitizer without an error. A full-project sanitizer build exceeded the container's execution limit and is not claimed as completed.

## Still out of scope

- Studio embedded `CustomParts/connectivity/*.conn` and `CustomParts/collider/*.col` **are not imported**. Existing BrickMotion collision shapes continue to be generated from LDraw triangle geometry; Studio-specific collider metadata is a separate format requiring separate parsing/validation.
- `PE_TEX_INFO`, Studio texture PNGs and other Studio-specific texture metadata are not preserved by the existing LDraw parser/MPD writer. Geometry/colour commands are preserved; textured surface appearance is not guaranteed to match Studio.
- The existing planner's collision algorithm, contact tolerances, rotational sweep sampling, and `ShapeCache` logic were **not altered** in this change. Importing previously missing triangles may increase collision/planning work; no whole-app speedup is claimed.
- The full native CMake/Catch2/Metal macOS build and full-model M1 planning benchmarks were **not run here**. These remain required before shipping.

## Verification on the M1 Mac

Use the modified source tree and your full `BM_LDRAW_DIR`. In the **Release** build:

```bash
# Run from the extracted BrickMotion-Studio-Geometry source directory.
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j 4
ctest --test-dir build --output-on-failure
BM_LDRAW_DIR=/path/to/complete/ldraw build/tools/bm/bm load "/path/to/Ma Odele's.io" --json
BM_LDRAW_DIR=/path/to/complete/ldraw build/tools/bm/bm load '/path/to/MOC-272851_TheDeeGee_Simtek_S941.io' --json
```

Confirm `studioCustomParts.available` and `.loaded`, and compare `bm audit` / collision and plan results against the previous build using the **same** LDraw library. A newly loaded custom collision shape is expected to change old plans that previously ignored it. Verify correctness and memory usage before concluding that the resulting plan is valid. Keep the pre-change build intact until this verification is complete.

## Subsequent collision integration validation (18 November 2026)

The importer is now complemented by an opt-in, deterministic transitive geometry
completeness audit, an independent plan-certifier collision regression, concurrent
cache tests, and M1 validation scripts. See `EMBEDDED_COLLISION_VALIDATION.md`.
The native M1 suite and full installed-library planning benchmarks remain open.
