
## M1 hardware profiling and the uploaded models (new pass)

For an M1 CPU-specific baseline on a Mac with the complete LDraw library, from your repository root:

```sh
export BM_LDRAW_DIR=/path/to/complete/ldraw
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native/build
ctest --test-dir native/build --output-on-failure
BM_PLAN_BUDGET=15 bash native/tools/perf/m1_profile.sh native/build/tools/bm/bm \
  '/path/to/9093-1.mpd' '/path/to/76897-1.mpd' \
  '/path/to/5590_-_whirl_n_wheel_super_truck.mpd' \
  '/path/to/MOC-272851_TheDeeGee_Simtek_S941.io' \
  "/path/to/Ma Odele's.io"
```

It creates a timestamped `bm-m1-profile-*` directory with `results.csv` and per-run logs. The automatic budget is per planning attempt, not for the entire script; plan commands also include certification by default. Comparing 4 vs 8 threads is useful on a base M1. Set `BM_RUN_OVERLAPS=1` to include a potentially expensive exact-overlap scan for each model.

The `model_complexity.py` tool counts LDraw references without needing a library. `blocker_index_verify.cpp` is a dependency-index random equivalence check and synthetic timing probe; compile it with any C++20 compiler (include paths are relative in the source):

```sh
c++ -std=c++20 -O3 -Wall -Wextra -Werror tools/perf/blocker_index_verify.cpp -o /tmp/bm-blocker-index-verify
/tmp/bm-blocker-index-verify
```

`inline_mesh_bench.cpp`, `world_build_bench.cpp`, `probe_world_bench.cpp`, and `plan_compare.cpp` are isolated comparison harnesses; see `M1_OPTIMIZATION_NOTES.md` for measured results, omissions and caveats. The Studio `.io` importer now loads reachable embedded custom `.dat` geometry, but whole-model collision correctness still requires the installed complete LDraw library and native M1 validation; see `EMBEDDED_COLLISION_VALIDATION.md`.


## Embedded custom collision regression (new)

```sh
# Runs synthetic import, collision, travel, independent certifier and concurrency checks:
bash tools/perf/studio_collision_verify.sh
# Optional: smoke-test user models using the fixture LDraw library (incomplete):
bash tools/perf/studio_collision_verify.sh /path/to/model.io /path/to/model.mpd
# Optional: use ASan/UBSan for the portable checks:
BM_PORTABLE_SANITIZE=1 bash tools/perf/studio_collision_verify.sh
```

The portable runner uses a test-only zlib compatibility adapter for miniz. Native
macOS CMake builds still use the pinned miniz dependency. For a complete-library
M1 audit with per-model JSON and CSV results:

```sh
export BM_LDRAW_DIR=/path/to/full/ldraw
bash tools/perf/m1_validate_geometry.sh build/tools/bm/bm /path/to/model.io
# CI gate (strict completeness; line-only parts need a documented exception):
BM_FAIL_ON_INCOMPLETE=1 bash tools/perf/m1_validate_geometry.sh build/tools/bm/bm /path/to/model.io
```
