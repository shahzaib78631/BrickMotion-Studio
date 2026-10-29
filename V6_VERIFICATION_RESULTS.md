# BrickMotion V6 verification snapshot — 2026-10-30

This report describes checks executed against this source package in an offline packaging environment. It is **not** a claim of physically correct animation for all LEGO models.

| Command | Outcome | Scope |
|---|---|---|
| `npm run verify:v4:mechanisms:offline` | 10 PASS / 0 FAIL | Legacy V4 ideal mechanism math (offline stubs) |
| `npm run verify:v5:offline` | 42 PASS / 0 FAIL | Inherited V4 + V5 network equations, multi-motor and playback checks |
| `npm run verify:v6:offline` | 33 PASS / 0 FAIL | Inherited V4 + V6 spatial constraint, geometry screen, rolling, adapter, JSON and sweep tests |
| `npm run typecheck:v5:core` | PASS | Isolated pure V5 core modules |
| `npm run typecheck:v6:math` | PASS | Isolated pure V6 math/geometry/sweep modules |
| TypeScript transpile/syntax check | PASS | All 15 modified/new TS/TSX files at integration review |
| Full `npm run build` | **NOT VERIFIED** | npm dependencies were unavailable for offline installation; no React/Vite/browser bundle produced |
| Real Kinebrick set benchmark | **NOT RUN** | No common reference corpus/run harness/ground-truth movement comparison available |

Some tests overlap across suites. **33 V6 suite checks** include the ten inherited V4 checks, not 33 separate real LEGO models. Additional synthetic four-bar JSON example validation is included in the 33.

Use `npm install && npm run build` on a machine with network and the normal development dependencies, then test the Mechanism Lab UI and rendering in a real browser before production deployment.
