# V8 verification and unresolved risk register

Status as of October 30, 2026 (local project development session).

| Gate | Result | Evidence limits |
|---|---|---|
| V4 offline mechanisms | Pass | Earlier limited V4 regression fixtures |
| V5 transmission offline | Pass | Earlier ideal gear/transmission and render-program checks |
| V6 spatial offline | Pass | Earlier simulated constraints, geometry and rig import checks |
| V7 mechanics offline | Pass | Earlier ideal mechanics and vehicle equations |
| V8 targeted iterations (`V8-I01`–`V8-I20`) | **20/20 pass** | 20 engineering tasks, not 20 benchmarked LEGO sets |
| V8 property checks (`V8-P01`–`V8-P06`) | **6/6 pass** | Includes 200 deterministic randomized slider-crank cases |
| V8 pure-math TypeScript typecheck | **Pass** | Excludes external application packages |
| V8 TypeScript + TSX parser | **9/9 pass** | Syntax only; cannot substitute for full app typecheck |
| Full `npm ci` + Vite build | **Blocked / NOT verified** | npm registry unreachable (`EAI_AGAIN`), missing React/Three/Vite dependencies |
| Interactive Mechanism Lab/browser smoke test | **NOT verified** | Requires successful dependency installation and browser runtime |
| Comparison on official Kinebrick/OMR real LEGO-set functions | **NOT run** | No grounded accuracy/performance ranking yet |
| Collision clearance and contact forces for V8 poses | **NOT verified** | Only ideal sampled kinematics; V4 collision tools remain separate |

The complete offline gate is `npm run verify:v8:all`, which passed. Some underlying V4 tests are run by multiple offline scripts, so reported legacy PASS lines overlap and must not be summed as independent physical mechanisms.

Remaining high-priority work: full TypeScript/React build and UI smoke test; converting spatial clips into native saved-video keyframes; sampled + continuous collision checks on the spatial path; real-set function-level benchmarks; and physics/contact for flexible belts, hoses, rope, springs and tyres.
