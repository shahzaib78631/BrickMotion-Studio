# Instructions → MPD, Phase 2a (agent placement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Phase 1's unplaced steps into a placed MPD: per step, CommandCode DeepSeek describes where the new parts went (from the booklet pictures) and then emits `place` commands; our script applies them, checks overlap/floating, retries, and saves resumably.

**Architecture:** Phase 1's CLI additionally writes `steps.json` (resolved parts + picture per step, plus left-over parts). A new CLI `instructions:place` runs a step loop over it. Pure modules in `src/instructions/place/` (state text, command parsing/applying, check, prompts, loop); the only process-spawning code is the agent runner in `scripts/instructions/agent.ts`, injected into the loop so tests use fakes.

**Tech Stack:** TypeScript (tsx scripts, vitest), existing `src/plan`, `src/model/assemble.ts`, `src/model/validate.ts`, `src/io/ldrawExport.ts`; `commandcode` CLI.

**Spec:** `docs/superpowers/specs/2026-10-29-instructions-to-mpd-design.md` (see "Phase 2 update").

## Global Constraints

- Agent: `commandcode -p <prompt> -m deepseek/deepseek-v4.1-flash --trust --skip-onboarding --no-session --no-auto-update --max-turns <n>`, run with `cwd` = a fresh per-call folder holding copies of the images it should open. No OpenCode/Big Pickle.
- Agents never touch the repo or the MPD: they only answer text; our script parses and applies.
- Every agent call logs `prompt.txt`, `output.txt`, `meta.json` (`{ms, exitCode, model, step, attempt}`) under `.cache/instructions/<name>/agent/<model>/<step>-<kind>-<attempt>/`.
- Coordinates: x, z in studs, y in plates, up positive; `rot` 0/90/180/270 about vertical — the `Grid` convention in `src/plan/types.ts`.
- At most 3 place attempts per step; `--max-calls N` stops cleanly after N agent calls; re-running resumes from `progress.json`.
- Never silently drop or invent parts: a part the agent does not place stays in the step's tray row and is flagged.
- REBRICKABLE key handling and Phase 1 behaviour unchanged.

## Review Focus

1. Agent answers with prose, code fences or extra lines around the commands → parser still extracts the valid lines and reports the rest, never crashes.
2. Agent places a part not in the step, the wrong colour, or more copies than the step has → rejected with a message fed back on retry, never applied.
3. Run stopped mid-model (`--max-calls`, Ctrl-C, crash) → re-run continues at the first unaccepted step with identical earlier placements.
4. A model that is turned between pictures (booklet "turn" steps) → the describe answer carries the visible side and the place prompt states it.
5. Two figures (submodels) in one set → each has its own state; step numbers restart per model without clobbering logs or progress.

---

### Task 1: `steps.json` from Phase 1

**Files:**
- Create: `src/instructions/stepsFile.ts`
- Modify: `scripts/instructions-to-mpd.ts` (write `<work>/steps.json` after the plan is built)
- Test: `tests/instructions/stepsFile.test.ts`

**Interfaces:**
- Consumes: `Booklet`, `Matches` (`src/instructions/types.ts`), `Resolved` (`rebrickable.ts`).
- Produces:
  ```ts
  export type StepPart = { part: string; color: number; count: number; element: string | null };
  export type StepEntry = { model: number; number: number; page: number; picture: string | null; parts: StepPart[]; subBuild: { substeps: number[]; repeat?: number } | null };
  export type StepsFile = { name: string; models: { name: string; steps: StepEntry[] }[]; leftover: StepPart[] };
  export function stepsFile(name: string, models: Booklet[][], matches: Matches, resolve: (e: string) => Resolved, bookletDir: string): StepsFile;
  ```
  Model names follow `planFromBooklets`: one model → `name`; several → `"<name> <k>"`. `picture` is an absolute path (`bookletDir/<booklet id>/<picture>`). Parts merge identical part+colour within a step (counts add). Unidentified callout parts use part `3001`, colour 16, `element: null` (same as Phase 1). `leftover` = `matches.unused` resolved (count = `left`), skipping ids that resolve to no part.

- [ ] **Step 1: Write the failing tests**
  - `'one model: parts merged by part and colour, picture absolute'` — booklet with step 1 callout `[count 2 → element A, count 1 → element A]` resolves to `[{part:'3001',color:4,count:3,element:'A'}]`; `picture === '/w/b/crops/p.png'` for `bookletDir='/w'`, booklet id `b`, picture `crops/p.png`.
  - `'two models are named like the plan submodels'` → `models.map(m=>m.name)` = `['40859 1','40859 2']`.
  - `'sub-build steps carry substeps and repeat'` → `subBuild` = `{substeps:[1,2],repeat:2}`; a plain step → `null`.
  - `'left-over inventory becomes candidate parts'` → `unused: [{element:'4243814',left:1}]` resolving to `3031`/4 gives `leftover = [{part:'3031',color:4,count:1,element:'4243814'}]`.
- [ ] **Step 2:** `npx vitest run tests/instructions/stepsFile.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `stepsFile`; in the CLI write `JSON.stringify(stepsFile(...), null, 1)` to `<work>/steps.json` and print `  Steps:  <path>`.
- [ ] **Step 4:** Run the test — Expected: PASS. Run `npx vitest run tests/instructions` — all pass.
- [ ] **Step 5:** Commit `feat: phase 1 writes steps.json for placement`.

### Task 2: Placed pieces, state text, commands

**Files:**
- Create: `src/instructions/place/pieces.ts`
- Test: `tests/instructions/place/pieces.test.ts`

**Interfaces:**
- Consumes: `StepPart` (Task 1); `PlanItem`, `Grid`, `Raw`, `Rot` (`src/plan/types.ts`); `gridToPlacement`, `rotatedBox`, `rotMatrix` (`src/plan/placement.ts`); `PartMetrics` (`src/ldraw/metrics.ts`).
- Produces:
  ```ts
  export type Up = 'y+' | 'y-' | 'x+' | 'x-' | 'z+' | 'z-';
  export type Placed = { part: string; color: number; x: number; y: number; z: number; rot: Rot; up: Up; step: number };
  export type Command = { op: 'place'; part: string; color: number; x: number; y: number; z: number; rot: Rot; up: Up } | { op: 'remove'; part: string; x: number; y: number; z: number };
  export function parseCommands(text: string): { commands: Command[]; errors: string[] };
  export function applyCommands(placed: Placed[], cmds: Command[], allowed: StepPart[], step: number): { placed: Placed[]; errors: string[]; unplaced: StepPart[] };
  export function stateText(placed: Placed[], metrics: (part: string) => PartMetrics): string;
  export function toPlanItem(p: Placed, metrics: (part: string) => PartMetrics): PlanItem;
  ```
  - Grammar (one per line, case-insensitive op): `place <part> <color> <x> <y> <z> <rot> [up]`, `remove <part> <x> <y> <z>`. `<color>` is an LDraw colour number (the prompt shows each part with its number). Lines that are blank, fences (```), or start with `#` are ignored silently; any other non-matching line → `errors: ["line N not understood: <line>"]`.
  - `applyCommands` rejects (error, not applied): part/colour not in `allowed`; more copies than `allowed` count; `remove` of a piece not placed in this `step` (earlier steps are fixed). `unplaced` = allowed minus what got placed.
  - `stateText`: one line per piece, `"<part> <colour#> at x=<x> y=<y> z=<z> rot=<rot>[ up=<up>] covers x<a>-<b> z<c>-<d>, top at y=<y+h>"` using the rotated footprint (`metrics.footprint` w/d swapped at 90/270) and `heightPlates`; sideways pieces state their LDU-derived box in studs/plates the same way.
  - `toPlanItem`: `up === 'y+'` → `{part,color,x,y,z,rot}` (Grid). Otherwise a `Raw` placement: matrix = rotation taking +y to `up`, then `rotMatrix(rot)`; position chosen so the rotated body box's min x = `x·20`, min z = `z·20`, bottom = `−y·8` (LDraw y is down).
- [ ] **Step 1: Write the failing tests**
  - `'parses place and remove lines, ignoring fences and comments'` — input with ```` ``` ````, `# note`, `place 3070b 14 0 1 3 0`, `PLACE 3020 14 0 1 1 90 z-`, `remove 3070b 0 1 3`, `hello` → 3 commands, `errors = ['line 6 not understood: hello']` (line numbers 1-based on the raw text).
  - `'rejects parts not in the step and extra copies'` — allowed `[{3070b,14,count 2}]`; commands place 3070b/14 ×3 and 3001/4 ×1 → placed 2, errors mention `3001 colour 4 is not in this step` and `3070b colour 14: only 2 in this step`.
  - `'cannot remove pieces from earlier steps'`.
  - `'unplaced lists what the step still needs'` — allowed 2, placed 1 → `unplaced=[{…count:1}]`.
  - `'state text gives footprint and top height'` with fixture metrics for `3020` (2×4 plate): `3020 14 at x=0 y=1 z=1 rot=0 covers x0-3 z1-2, top at y=2` and at rot 90 `covers x0-1 z1-4`.
  - `'sideways piece becomes an exact placement with its box at the grid corner'` — `3020` up `z-`: `toPlanItem` returns an item with `matrix`; its assembled box min x = 0, min z = 0 (LDU), bottom at y=0.
- [ ] **Step 2:** `npx vitest run tests/instructions/place/pieces.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Test — Expected: PASS.
- [ ] **Step 5:** Commit `feat: placement commands and model state text`.

### Task 3: Check

**Files:**
- Create: `src/instructions/place/check.ts`
- Create: `scripts/instructions/partMetrics.ts` (move `partMetrics` out of `scripts/instructions-to-mpd.ts`, signature `partMetricsFor(partIds: Iterable<string>): (part: string) => PartMetrics`; the Phase 1 CLI uses it)
- Test: `tests/instructions/place/check.test.ts`

**Interfaces:**
- Consumes: `Placed`, `toPlanItem` (Task 2); `assemble`, `Metrics` (`src/model/assemble.ts`); `validate` (`src/model/validate.ts`); `ColorDef` map.
- Produces: `export function checkStep(placed: Placed[], step: number, metrics: Metrics, colors: Map<number, ColorDef>): string[];` — builds a one-step plan from all placed pieces, runs `validate`, and returns messages only for `overlap`/`floating` warnings that involve a piece of `step`, phrased with that piece's `stateText`-style position (e.g. `"3070b 14 at x=0 y=1 z=3 overlaps 1126 14 at x=1 y=1 z=3"`, `"3070b 14 at x=0 y=5 z=3 is floating"`). The model's first piece is never floating.
- [ ] **Step 1: Write the failing tests** (fixture parts `3001`, `3020`):
  - `'clean placement has no messages'` — 3020 at 0,0,0 then 3001 at 0,1,0 (step 2) → `[]`.
  - `'overlap with an earlier piece is reported for the new piece'` — 3001 at 0,0,0 step 2 against 3020 at 0,0,0 step 1 → one message containing `overlaps`.
  - `'floating new piece is reported'` — 3001 at 10,9,10 → message containing `is floating`.
  - `'problems between earlier pieces only are not this step's'` → `[]`.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Implement; move `partMetrics` and rewire Phase 1 CLI.
- [ ] **Step 4:** `npx vitest run tests/instructions` — Expected: all PASS.
- [ ] **Step 5:** Commit `feat: per-step overlap and floating check`.

### Task 4: Prompts and answer parsing

**Files:**
- Create: `src/instructions/place/prompts.ts`
- Test: `tests/instructions/place/prompts.test.ts`

**Interfaces:**
- Consumes: `StepEntry`, `StepPart` (Task 1); `stateText` output (Task 2).
- Produces:
  ```ts
  export type Description = { view: 'front' | 'back' | 'left' | 'right' | 'unknown'; placements: { part: string; where: string }[]; absent: string[]; confidence: number };
  export function describePrompt(o: { step: StepEntry; partNames: string[]; state: string; hasBefore: boolean; candidates: string[] }): string;
  export function parseDescription(text: string): Description | null;
  export function placePrompt(o: { step: StepEntry; parts: StepPart[]; state: string; description: Description; feedback: string[] }): string;
  ```
  - `describePrompt`: tells the agent to open `./after.png` (and `./before.png` when `hasBefore`), lists the step's parts by name/colour ("do NOT identify parts"), gives the current model state text, mentions a sub-build when `step.subBuild` is set ("this step builds a small sub-assembly and attaches it; say where its parts end up"), lists `candidates` as "parts that may also appear in this step without a callout — say for each whether it is visible, as `absent` or a placement", asks which side of the model faces the viewer, and demands ONLY JSON of the `Description` shape.
  - `parseDescription`: first `{…}` block that parses as JSON with a `placements` array; defaults `view:'unknown'`, `absent:[]`, `confidence:0`; anything else → `null`.
  - `placePrompt`: the coordinate rules (Global Constraints wording, plus the `up` option for sideways parts), the state text, the description JSON, the exact parts with counts as `"<count>x <part> colour <n> (<name>)"`, previous `feedback` lines under "Your previous answer had these problems:", "Do not use any tools", and the command grammar from Task 2.
- [ ] **Step 1: Write the failing tests**
  - `'describe prompt names before/after images, parts and candidates'` — contains `./before.png` only when `hasBefore`; contains each part name and the candidate name; contains `ONLY JSON`.
  - `'describe prompt mentions the sub-build'` when `subBuild` set.
  - `'parses a description wrapped in prose and fences'` — "Here:\n```json\n{\"view\":\"front\",\"placements\":[{\"part\":\"tile\",\"where\":\"row 4 col 1\"}],\"confidence\":0.7}\n```" → parsed with `absent: []`.
  - `'unparseable description is null'`.
  - `'place prompt carries parts with counts, feedback and the grammar'` — contains `2x 3070b colour 14`, the feedback line, `place <part> <color> <x> <y> <z> <rot> [up]`.
- [ ] **Step 2:** Run — Expected: FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: describe and place prompts`.

### Task 5: Agent runner

**Files:**
- Create: `scripts/instructions/agent.ts`
- Test: `tests/instructions/agent.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AgentCall = { prompt: string; images: Record<string, string>; logDir: string; maxTurns: number; meta: Record<string, unknown> };
  export type Agent = (call: AgentCall) => Promise<{ text: string; ms: number; ok: boolean }>;
  export function commandCodeAgent(spawnImpl?: typeof import('node:child_process').spawn, timeoutMs?: number): Agent;
  ```
  Creates `logDir`, copies each `images[name] = sourcePath` into it as `name`, writes `prompt.txt`, spawns `commandcode` with the Global Constraints flags (`-p <prompt>`, `--max-turns <maxTurns>`) and `cwd = logDir`, collects stdout+stderr into `output.txt`, writes `meta.json` (`{...meta, ms, exitCode, model:'deepseek/deepseek-v4.1-flash'}`). Kills the process after `timeoutMs` (default 300000) and returns `ok:false`. `ok` = exit 0 and not timed out.
- [ ] **Step 1: Write the failing tests** with a fake `spawn` (an `EventEmitter` child with `stdout`/`stderr` streams):
  - `'copies images, logs prompt/output/meta, passes the model flags'` — asserts argv contains `-m`, `deepseek/deepseek-v4.1-flash`, `--max-turns`, `6`; `cwd` = logDir; files exist; returned `text` = fake stdout.
  - `'a hung call is killed and reported not ok'` — `timeoutMs: 50`, child never exits → `ok:false`, `kill` called, `meta.json` has `exitCode: null`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: logged CommandCode agent runner`.

### Task 6: Step loop with resume and budget

**Files:**
- Create: `src/instructions/place/loop.ts`
- Test: `tests/instructions/place/loop.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5 (`Agent` type is imported as a type only; the loop takes it as a dependency).
- Produces:
  ```ts
  export type StepResult = { model: string; number: number; status: 'accepted' | 'flagged' | 'skipped'; attempts: number; problems: string[]; unplaced: StepPart[]; view: Description['view'] };
  export type Progress = { models: Record<string, { placed: Placed[]; results: StepResult[] }>; calls: number; ms: number };
  export type LoopDeps = { agent: Agent; check: (placed: Placed[], step: number) => string[]; state: (placed: Placed[]) => string; partName: (p: StepPart) => string; logRoot: string; maxCalls: number; save: (p: Progress) => void };
  export async function placeModels(file: StepsFile, progress: Progress, deps: LoopDeps): Promise<{ progress: Progress; stopped: boolean }>;
  ```
  Per model, per step in order, skipping steps that already have a result in `progress`:
  1. Step with no parts and no candidates → result `skipped`.
  2. Describe call: images `after.png` = picture, `before.png` = previous step's picture (same model) when present; `maxTurns` 14; candidates = `file.leftover` not yet placed anywhere, offered only at each model's first step. Unparseable/failed description → description `{view:'unknown', placements:[], absent:[], confidence:0}` plus problem `"description unreadable"` (still try to place).
  3. Up to 3 place calls (`maxTurns` 4): parse → apply (allowed = step parts + offered candidates; candidates are optional) → `check`. Accept when no parse/apply errors, nothing of the step's own parts unplaced, and `check` is `[]`. Otherwise feedback = errors + unplaced ("still to place: …") + check messages, and retry from the state before this step.
  4. After the last failed attempt keep the attempt with the fewest problems; status `flagged`, `problems` = its problems.
  5. After each step: `progress.calls` and `progress.ms` (sum of agent call times) updated, `save(progress)`. If `calls >= maxCalls` before a call is needed, return `{stopped:true}` without a result for that step.
  Log dirs: `<logRoot>/<model>/<number>-describe-1`, `<number>-place-<attempt>`.
- [ ] **Step 1: Write the failing tests** with a scripted fake agent (returns queued texts, records calls) and fake `check`:
  - `'accepts a step whose placement is clean on the first try'` → status `accepted`, attempts 1, 2 agent calls, `placed` has the pieces.
  - `'retries with feedback and accepts on the second attempt'` — first place answer has an extra part; second clean → attempts 2; the 2nd place prompt contains the first attempt's error.
  - `'flags after three failed attempts and keeps the best attempt'`.
  - `'resumes after the last saved step'` — progress with step 1 result → no calls for step 1.
  - `'stops at max calls and saves'` → `stopped: true`, `save` called, unfinished step has no result.
  - `'left-over parts are offered at the first step of each model only'` — describe prompt for step 1 contains `3031`, step 2 does not; once placed in model 1 it is not offered in model 2.
  - `'step without parts is skipped without agent calls'`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: resumable describe-place-check step loop`.

### Task 7: CLI, MPD output and report; real run

**Files:**
- Create: `scripts/instructions-place.ts`, `src/instructions/place/output.ts`
- Modify: `package.json` (`"instructions:place": "tsx scripts/instructions-place.ts"`), `README.md` (section "Instruction PDFs → MPD": Phase 2 usage)
- Test: `tests/instructions/place/output.test.ts`

**Interfaces:**
- Consumes: everything above; `exportLDraw`, `parseLDConfig`.
- Produces:
  ```ts
  export function placedPlan(file: StepsFile, progress: Progress, metrics: Metrics): Plan;
  export function placeReport(file: StepsFile, progress: Progress): string;
  ```
  - `placedPlan`: same model/submodel layout as Phase 1 (`FIGURE_GAP` 24). Each step's pieces = its placed pieces (`toPlanItem`) + its still-unplaced parts laid in the step's tray row exactly as Phase 1 does (`z = -(8+4k)`, pitch 8). Placed left-over parts go into the step that placed them.
  - `placeReport`: `# <name>: placement report`, summary line `Steps: N · accepted A (P%) · flagged F · skipped S · agent calls C · agent time M min`, then a table `| model | step | status | attempts | problems |` listing every flagged step first, then the rest.
  - CLI: `npm run instructions:place -- --name <name> [--max-calls N] [--restart]`; reads `<work>/steps.json` (error "Run `npm run instructions` first" if missing), loads/creates `<work>/progress.json` (`--restart` deletes it), runs `placeModels` with `commandCodeAgent()`, then writes `<work>/<name>-placed.mpd` and `<work>/place-report.md`; prints the summary line and paths. Ctrl-C: progress is already saved after every step.
- [ ] **Step 1: Write the failing tests**
  - `'unplaced parts stay in the tray row, placed ones at their coordinates'`.
  - `'two models become submodels side by side'`.
  - `'report lists flagged steps first with the summary line'` — exact summary for a 3-step fixture: `Steps: 3 · accepted 1 (33%) · flagged 1 · skipped 1 · agent calls 4 · agent time 0.1 min`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; `npx vitest run tests/instructions` all pass; `npx tsc --noEmit -p .` clean.
- [ ] **Step 5: Real run, part 1** — `npm run instructions -- --name 40859 --set 40859-1 --pdf 6668730 --pdf 6668732` then `npm run instructions:place -- --name 40859 --max-calls 12`. Expected: stops after 12 calls with progress saved; Superman steps 1–~5 have results; Superman step 4 places `3070b` 14 at x=0 and x=3 front row; step 1 places the red `3031` base from the left-overs.
- [ ] **Step 6: Real run, part 2** — re-run without `--max-calls` (resumes). Record in the ledger: accepted %, flagged steps, total agent minutes. Open `<work>/40859-placed.mpd` in BrickMotion (dev server, import) and screenshot Superman and Batman. The spec's target is ≥80% accepted; record the number either way — it is the input to the Phase 2b plan, not a gate on this one.
- [ ] **Step 7:** Commit `feat: instructions:place CLI, placed MPD and report`.
