# Local evaluation — 18 November 2026

Branch: `codex/m1-incremental-evaluation`. Apple M1 Pro.

Applied the incremental patch over the existing working tree, preserving prior changes. Adapted the world.cpp include hunk and created the previously absent perf README from its added content.

## Results

- Native Release core/test build passed.
- Core suite: 226 passed, 22 skipped, 15,222 assertions passed. Environment-dependent tests were skipped; this is not full renderer/UI validation.
- Blocker bookkeeping: 4.79092 ms scan versus 0.020625 ms index (about 232x faster), synthetic 2,119 removals. 25,000 randomized equivalence events passed.
- World construction: five alternating runs, 4,096 synthetic triangles and 300 warm world constructions each. Before: 33.8926, 32.7507, 32.7988, 32.8912, 32.7442 ms. After: 28.9743, 28.3738, 28.2794, 27.9055, 28.4562 ms. Medians: 32.7988 versus 28.3738 ms, 13.5% reduction.

The world comparison links the saved original world.cpp implementation against the current core library, isolating that change with identical external geometry. Both world implementations were compiled at -O3; the patched library uses the project Release/LTO configuration. It does not compare complete old/new application binaries. The blocker harness compares both algorithms in one executable.

These measurements support improvements to isolated bookkeeping and world construction. Full-model planning latency, inline mesh caching performance, memory use and rendering performance remain unmeasured. Do not interpret the synthetic ratio as overall application acceleration. Raw build/test logs and comparison executables are in `/tmp/bm-m1-evaluation` (temporary).
