# BrickMotion native engine

The C++ rewrite of BrickMotion Studio. Design: `docs/superpowers/specs/2026-11-15-native-rewrite-design.md`.

- `core/` — `bmcore`, the portable C++20 engine library (no Apple headers).
- `tools/bm/` — `bm`, the command-line tool; every engine feature runs from here.
- `tests/` — Catch2 tests.
- `corpus/` — the list of models both engines are measured on, and the web engine's baseline.

## Build and test

```bash
cmake -S native -B native/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build native/build
ctest --test-dir native/build --output-on-failure
```

Sanitizer builds for the tests: add `-DBM_SANITIZE=address` (ASan + UBSan) or `-DBM_SANITIZE=thread`
to a separate build directory, e.g. `-B native/build-asan`.

## Data

Read from outside this directory:

- `BM_LDRAW_DIR` — the LDraw library (default `<repo>/public/ldraw`).
- `BM_DATA_DIR` — the corpus (default `/Users/mac/Projects/BrickMotion-Data`).

Tests tagged `[data]` need `BM_LDRAW_DIR` and are skipped without it.
