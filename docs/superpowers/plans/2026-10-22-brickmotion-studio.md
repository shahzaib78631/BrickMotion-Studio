# BrickMotion Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web app that turns an AI-written (or imported LDraw) brick build plan into an editable 3D model and a 1080×1920 MP4 build animation in the "knolled parts fly into place" style.

**Architecture:** Pure TypeScript core (LDraw parsing, plan format, assembly, validation, animation timeline) with no DOM dependencies and full unit tests. Three.js renders the model with instanced meshes in a white studio scene. A React UI (zustand store with undo history) hosts the editor, preview player, AI dialog, and export. Mediabunny encodes the offline-rendered frames to MP4 in the browser. A one-time setup script downloads the LDraw library and Rebrickable CSVs into `public/`.

**Tech Stack:** Vite, React 18, TypeScript, three.js, zustand, zod, idb-keyval, mediabunny, @anthropic-ai/sdk, Vitest (+ happy-dom, @testing-library/react), tsx for scripts.

**Spec:** `docs/superpowers/specs/2026-10-22-brickmotion-studio-design.md`

## Global Constraints

- Video export: 1080×1920, 30 fps, MP4 (H.264 / `avc`), rendered frame by frame offline, never screen-recorded.
- Target video length: default 15 s, user range 5–60 s.
- LDraw units: 1 stud = 20 LDU, brick height = 24 LDU, plate height = 8 LDU, −Y is up. 1 brick = 3 plates.
- Plan grid: `x`, `z` in studs, `y` in plates (up is positive). The position is the min corner of the rotated footprint and the bottom of the piece. `rot` ∈ {0, 90, 180, 270}.
- Plan format id `"brickmotion-plan"`, `version: 1`.
- The LDraw library is served from `/ldraw/` (on disk: `public/ldraw/`). The catalog is served from `/data/catalog.json`.
- AI: Claude API from the browser with the user's own key (`dangerouslyAllowBrowser: true`). Default model `claude-opus-5-5`; settings offer `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`. Use adaptive thinking, `effort: "high"`, streaming with `finalMessage()`, and `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`.
- Credit both data sources in the About dialog. LDraw parts library: CC BY 4.0, ldraw.org. Catalog data: Rebrickable.com.
- Runs locally in Chrome with `npm run setup` (once), then `npm run dev`.
- `public/ldraw/`, `public/data/` and `.cache/` are gitignored.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Part not in the library, or a part with no solid body** (sticker, typo like `"3001x"`). Expected: a grey placeholder box sized 1×1×1 brick, an "unknown part" warning, and no crash anywhere downstream. Tests are in Task 4 (`loadPart` returns null), Task 7 (placeholder instance) and Task 8 (warning).
2. **Submodel cycles or missing submodel references** in AI output or imported `.mpd`. Expected: a warning, the offending placement skipped, and no infinite recursion. Tests are in Task 7.
3. **AI reply truncated (`max_tokens`), refused, or invalid JSON.** Expected: a clear error message, and the current plan left untouched. Tests are in Task 15.
4. **Very large imported models** (3,000+ pieces). Expected: validation finishes in under 300 ms and the viewport uses instancing. Tests: the performance test in Task 8, plus the instance-count test in Task 11.
5. **Empty plan, or empty steps** (new project, AI returns no pieces). Expected: the editor shows an empty floor, the timeline has zero duration plus the outro, and Export is disabled. Tests are in Task 13 (`buildTimeline` with 0 units) and Task 6 (schema accepts empty `steps`).

---

## File Structure

```
package.json, vite.config.ts, tsconfig.json, index.html, .gitignore
scripts/setup-data.ts               one-time download + unzip + catalog build
src/main.tsx, src/App.tsx           app shell / layout
src/ldraw/parse.ts                  LDraw/MPD text → commands
src/ldraw/colors.ts                 LDConfig.ldr → color table, name/code lookup
src/ldraw/library.ts                file resolution + caching (fetch-based, injectable)
src/ldraw/flatten.ts                part → triangles per color, BFC, stud tagging
src/ldraw/metrics.ts                body/full boxes, footprint, height
src/ldraw/geometry.ts               flattened part → three BufferGeometries
src/plan/types.ts                   Plan types
src/plan/schema.ts                  zod schema + parsePlan
src/plan/ids.ts                     ensureIds
src/plan/placement.ts               grid ↔ LDraw transform math
src/plan/ops.ts                     pure edit operations
src/model/assemble.ts               plan → assembly tree + world instances
src/model/spatialHash.ts            broad-phase for validation
src/model/validate.ts               warnings
src/io/ldrawImport.ts, ldrawExport.ts, planFile.ts
src/catalog/buildCatalog.ts         (used by setup script) .dat headers + Rebrickable → entries
src/catalog/catalog.ts              load + search
src/render/materials.ts, bricks.ts, studio.ts, thumbnails.ts
src/anim/easing.ts, pacing.ts, floorLayout.ts, timeline.ts, camera.ts
src/export/exportVideo.ts
src/ai/palette.ts, prompt.ts, schema.ts, claude.ts, parsePasted.ts
src/storage/projects.ts, settings.ts
src/state/store.ts, keymap.ts, partService.ts
src/ui/*.tsx                        TopBar, PartsPanel, Viewport, Inspector, WarningsList,
                                    StepsTimeline, PreviewPlayer, ExportDialog, AiDialog,
                                    SettingsDialog, ProjectsDialog, AboutDialog
tests/fixtures/ldraw/               tiny hand-made LDraw library for unit tests
tests/**/*.test.ts                  mirrors src/
samples/mini-jet.plan.json          sample plan with a submodel (Task 17)
```

Shared helper used by many tests: `tests/helpers/fixtureLibrary.ts` exports `fixtureFetchText(path: string): Promise<string | null>`, which reads from `tests/fixtures/ldraw/` (lower-cased path, null if missing). Created in Task 4.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `.gitignore`, `src/main.tsx`, `src/App.tsx`, `tests/smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `test` (`vitest run`), `setup` (`tsx scripts/setup-data.ts`), `typecheck` (`tsc --noEmit`).

- [ ] **Step 1:** Run `git init` in the project root, then scaffold the Vite React-TS app by hand. The folder already has `docs/`, so don't use the interactive template. Install the dependencies `react react-dom three zustand zod idb-keyval mediabunny @anthropic-ai/sdk` and the dev dependencies `typescript vite @vitejs/plugin-react vitest happy-dom @testing-library/react @types/three @types/react @types/react-dom tsx`.
- [ ] **Step 2:** Configure Vitest in `vite.config.ts` (`test: { environment: 'node', include: ['tests/**/*.test.{ts,tsx}'] }`). UI tests opt in with `// @vitest-environment happy-dom`. Set `tsconfig` to strict mode.
- [ ] **Step 3: Write the smoke test** `tests/smoke.test.ts`: `expect(1 + 1).toBe(2)`, and import `three` and assert `new THREE.Vector3(1,2,3).length()` ≈ 3.742.
- [ ] **Step 4:** Run `npm test`. Expected: 1 file passes. Run `npm run typecheck`. Expected: no errors. Run `npm run dev` and open the page: it shows "BrickMotion Studio".
- [ ] **Step 5:** Add `.gitignore` with `node_modules`, `dist`, `.cache`, `public/ldraw`, `public/data`. Commit as "chore: scaffold BrickMotion Studio".

### Task 2: Data setup script and catalog builder

**Files:**
- Create: `scripts/setup-data.ts`, `src/catalog/buildCatalog.ts`
- Test: `tests/catalog/buildCatalog.test.ts`

**Interfaces:**
- Produces: `type CatalogEntry = { id: string; name: string; category: string }`
- Produces: `parseDatHeader(fileName: string, text: string): CatalogEntry | null`
- Produces: `buildCatalog(headers: CatalogEntry[], rebrickable: { parts: Map<string,string /*cat id*/>; categories: Map<string,string /*cat name*/> }): CatalogEntry[]`
- Produces on disk (after `npm run setup`): `public/ldraw/{LDConfig.ldr,parts/,p/}` and `public/data/catalog.json` (an array of `CatalogEntry`).

- [ ] **Step 1: Write the failing tests.**

```ts
test('parses description and category', () => {
  expect(parseDatHeader('3001.dat', '0 Brick  2 x  4\n0 Name: 3001.dat\n0 !CATEGORY Brick\n'))
    .toEqual({ id: '3001', name: 'Brick 2 x 4', category: 'Brick' });
});
test('falls back to first word for category', () => {
  expect(parseDatHeader('3039.dat', '0 Slope Brick 45  2 x  2\n')!.category).toBe('Slope');
});
test('skips moved, alias and obsolete parts', () => {
  expect(parseDatHeader('x.dat', '0 ~Moved to 3001\n')).toBeNull();
  expect(parseDatHeader('y.dat', '0 =Brick 2 x 4\n')).toBeNull();
  expect(parseDatHeader('z.dat', '0 _Brick 2 x 4 obsolete\n')).toBeNull();
});
test('prefers Rebrickable category name when the part number matches', () => {
  const out = buildCatalog([{ id: '3001', name: 'Brick 2 x 4', category: 'Brick' }],
    { parts: new Map([['3001', '11']]), categories: new Map([['11', 'Bricks']]) });
  expect(out[0].category).toBe('Bricks');
});
```

- [ ] **Step 2:** Run `npx vitest run tests/catalog`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `buildCatalog.ts`. Collapse runs of whitespace in names, and sort the output by id with a natural number sort.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Implement `scripts/setup-data.ts`. Download `https://library.ldraw.org/library/updates/complete.zip` to `.cache/complete.zip`, skipping the download if the file exists and its size is above 100 MB. Print progress percentages. Unzip it into `public/` with the system `unzip -q -o`; the zip contains a top-level `ldraw/` folder. Download `https://cdn.rebrickable.com/media/downloads/{parts,part_categories}.csv.gz` to `.cache/` and gunzip them with `node:zlib`. Read the first 30 lines of every `public/ldraw/parts/*.dat` (top level only, not `s/`), then write `public/data/catalog.json`. Also copy `public/ldraw/LDConfig.ldr` to make sure it's present. The script is safe to re-run.
- [ ] **Step 6:** Run `npm run setup`. Expected: it finishes, `public/data/catalog.json` has more than 10,000 entries, and `public/ldraw/parts/3001.dat` exists.
- [ ] **Step 7:** Commit as "feat: data setup script and catalog builder".

### Task 3: LDraw parser and colors

**Files:**
- Create: `src/ldraw/parse.ts`, `src/ldraw/colors.ts`, `tests/fixtures/ldraw/LDConfig.ldr`
- Test: `tests/ldraw/parse.test.ts`, `tests/ldraw/colors.test.ts`

**Interfaces:**
- Produces:
```ts
type Mat3 = [number,number,number,number,number,number,number,number,number]; // row-major a..i
type LDrawCmd =
  | { t: 'ref'; color: number; pos: [number,number,number]; m: Mat3; file: string; invert: boolean }
  | { t: 'tri' | 'quad'; color: number; pts: number[] /* 9 or 12 */ }
  | { t: 'step' }
  | { t: 'bfc'; cert?: 'CCW' | 'CW' | 'NOCERTIFY'; winding?: 'CCW' | 'CW'; clip?: boolean };
type LDrawFile = { name: string; description: string; category?: string; cmds: LDrawCmd[] };
parseLDraw(text: string, name?: string): LDrawFile
parseMpd(text: string): { main: string; files: Map<string, LDrawFile> } // keys lower-cased, '\'→'/'
type ColorDef = { code: number; name: string; hex: string; edge: string; alpha: number; finish: 'solid'|'chrome'|'metal'|'pearl'|'rubber'|'trans' };
parseLDConfig(text: string): Map<number, ColorDef>
resolveColor(table: Map<number,ColorDef>, c: string | number): number | undefined
```
- In `ref.file`, backslashes are turned into `/` and the name is lower-cased. `invert` is true when the preceding meta was `0 BFC INVERTNEXT`. Line types 2 and 5 are dropped. An `.mpd` file with no `0 FILE` line is treated as a single file named `main.ldr`.

- [ ] **Step 1: Write the failing tests.** For the parser: a ref line `1 16 10 0 0 1 0 0 0 1 0 0 0 1 S\\3001s01.dat` parses to `{color:16,pos:[10,0,0],file:'s/3001s01.dat'}`. A quad parses to 12 numbers. `0 STEP` becomes a step. `0 BFC INVERTNEXT` sets `invert` on the next ref only. `parseMpd` with two `0 FILE` blocks gives 2 files, and `main` is the first one. For the fixture `LDConfig.ldr`, which contains the lines below, `resolveColor(t,'Light Bluish Grey')===71`, `resolveColor(t,'light_bluish_gray')===71`, `resolveColor(t,72)===72`, `resolveColor(t,'71')===71`, `resolveColor(t,'nope')===undefined`, and `t.get(47).alpha===128`, `t.get(47).finish==='trans'`, `t.get(383).finish==='chrome'`.

```
0 !COLOUR Light_Bluish_Gray CODE 71 VALUE #A0A5A9 EDGE #333333
0 !COLOUR Dark_Bluish_Gray CODE 72 VALUE #6C6E68 EDGE #333333
0 !COLOUR Black CODE 0 VALUE #1B2A34 EDGE #808080
0 !COLOUR Trans_Clear CODE 47 VALUE #FCFCFC EDGE #C3C3C3 ALPHA 128
0 !COLOUR Chrome_Silver CODE 383 VALUE #E0E0E0 EDGE #A4A4A4 CHROME
```

- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement both modules. To normalize names, lower-case them, turn `_` into a space, turn `grey` into `gray`, and trim.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit as "feat: LDraw parser and color table".

### Task 4: Part library, flattening and metrics

**Files:**
- Create: `src/ldraw/library.ts`, `src/ldraw/flatten.ts`, `src/ldraw/metrics.ts`, `tests/helpers/fixtureLibrary.ts`, and the fixtures `tests/fixtures/ldraw/parts/3001.dat`, `parts/3020.dat`, `parts/s/3001s01.dat`, `p/stud.dat`, `parts/nobfc.dat`
- Test: `tests/ldraw/library.test.ts`, `tests/ldraw/metrics.test.ts`

**Fixtures (hand-made, simplified):**
- `3001.dat` is a 2×4 brick, long side along X. It references `s/3001s01.dat` (the body: six quads of the box x ±40, y 0..24, z ±20, BFC CCW certified) and 8 × `stud.dat` at y=0, x ∈ {±10, ±30}, z ∈ {±10}.
- `stud.dat` is a box x/z ±6, y −4..0.
- `3020.dat` is a 2×4 plate: the same as 3001 with y 0..8.
- `nobfc.dat` is a single triangle with no BFC header.

**Interfaces:**
- Consumes: `parseLDraw`, `parseMpd` (Task 3).
- Produces:
```ts
type FetchText = (path: string) => Promise<string | null>;
class PartLibrary {
  constructor(fetchText: FetchText);
  addInline(files: Map<string, LDrawFile>): void;            // MPD-embedded files take priority
  getFile(name: string): Promise<LDrawFile | null>;          // tries parts/, p/, parts/s via 's/', p/48 via '48/', models/, as-is; lower-cased; cached
  loadPart(id: string): Promise<FlatPart | null>;            // cached; null if the file is missing
}
type FlatPart = {
  id: string;
  tris: Map<number, number[]>;  // color code (16 = main) → flat xyz list in part space (LDU), CCW front faces
  doubleSided: Map<number, number[]>; // tris from non-BFC-certified files
  bodyBox: Box | null;          // excludes geometry from any file whose base name matches /^stud.*\.dat$/
  fullBox: Box | null;
};
type Box = { min: [number,number,number]; max: [number,number,number] };
type PartMetrics = { id: string; body: Box; full: Box; footprint: { w: number; d: number }; heightPlates: number; placeholder: boolean };
measurePart(flat: FlatPart | null, id: string): PartMetrics
```
- Placeholder metrics, for a null part or a part with no geometry: body = full = box x 0..20, y 0..24, z 0..20; footprint {1,1}; heightPlates 3; `placeholder: true`.
- `footprint.w = max(1, round((body.max.x-body.min.x)/20))`; `d` is the same on z. `heightPlates = max(1, round((body.max.y-body.min.y)/8))`.
- Colors inside sub-files: color 16 in a child inherits the referencing line's color, and color 24 is kept as 24. The final `tris` keys are either 16 (main) or a fixed code.
- BFC: track the accumulated invert as `invert XOR (det(m) < 0)` and the file's winding (CW reverses). A file without `BFC CERTIFY` puts its tris into `doubleSided`.
- Use `fetch('/ldraw/' + path)` as the browser `FetchText`, returning null for anything other than 200. The app wires this in Task 10's `partService`.

- [ ] **Step 1: Write the failing tests.** `loadPart('3001')` gives `bodyBox` = {min:[-40,0,-20],max:[40,24,20]}, and `fullBox.min[1]` = −4. `measurePart` gives footprint {w:4,d:2} and heightPlates 3. For 3020, heightPlates is 1. `loadPart('3001x')` is null, and `measurePart(null,'3001x').placeholder` is true. `getFile('S\\3001s01.dat')` resolves. `loadPart('nobfc')` has its triangle in `doubleSided`. Fetch counting: loading 3001 twice calls fetchText for `3001.dat` only once. A sub-file referenced with an INVERTNEXT and an identity matrix has its triangle winding reversed compared with the same file without INVERTNEXT: compare the cross-product sign.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the three modules. Recursion is iterative-safe, with depth limited to 32, and a missing sub-file is skipped with `console.warn` once per name.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit as "feat: part library, flattening and metrics".

### Task 5: Part geometry for three.js

**Files:**
- Create: `src/ldraw/geometry.ts`
- Test: `tests/ldraw/geometry.test.ts`

**Interfaces:**
- Consumes: `FlatPart` (Task 4).
- Produces: `type PartGeometry = { main: THREE.BufferGeometry | null; fixed: { color: number; geometry: THREE.BufferGeometry; doubleSided: boolean }[]; mainDoubleSided: THREE.BufferGeometry | null }` and `buildPartGeometry(flat: FlatPart): PartGeometry`. Geometry stays in LDU part space. The −Y-up flip and scale happen on the scene root (Task 11).

- [ ] **Step 1: Write the failing test.** For the fixture 3001, `main` exists and its position count = 3 × the triangle count from `flat.tris.get(16)`, and `normal` exists. A fixed-color triangle (add fixture `parts/twocolor.dat` with one color-4 tri and one color-16 tri) produces exactly 1 `fixed` entry with color 4.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement. Merge vertices with `BufferGeometryUtils.mergeVertices` and then `toCreasedNormals(geom, Math.PI / 6)` so curved parts look smooth and box edges stay crisp. Call `computeBoundingSphere()`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit as "feat: part geometry builder".

### Task 6: Plan types, schema, ids and grid placement

**Files:**
- Create: `src/plan/types.ts`, `src/plan/schema.ts`, `src/plan/ids.ts`, `src/plan/placement.ts`
- Test: `tests/plan/schema.test.ts`, `tests/plan/placement.test.ts`

**Interfaces:**
- Produces:
```ts
type Rot = 0 | 90 | 180 | 270;
type Grid = { x: number; y: number; z: number; rot: Rot };
type Raw = { ldu: [number,number,number]; matrix: Mat3 };
type PieceItem = { id?: string; part: string; color: string | number } & (Grid | Raw);
type SubItem = { id?: string; submodel: string } & (Grid | Raw);
type PlanItem = PieceItem | SubItem;
type Step = { pieces: PlanItem[] };
type Plan = { format: 'brickmotion-plan'; version: 1; name: string; description?: string;
              submodels?: Record<string, { steps: Step[] }>; steps: Step[] };
isSub(i: PlanItem): i is SubItem;  isGrid(i): i is PlanItem & Grid;
parsePlan(json: unknown): { ok: true; plan: Plan } | { ok: false; errors: string[] }
ensureIds(plan: Plan): Plan                 // fills missing ids with 'i' + base36 counter, unique across the whole plan; returns a new plan
type Placement = { pos: [number,number,number]; m: Mat3 };  // LDraw transform, part space → parent model space
rotMatrix(rot: Rot): Mat3                   // [c,0,s, 0,1,0, -s,0,c]
gridToPlacement(g: Grid, body: Box): Placement
placementToGrid(p: Placement, body: Box): Grid | null   // null when m is not a pure vertical 90° rotation or not on the grid (±0.5 LDU)
rotatedBox(body: Box, m: Mat3): Box
```
- `gridToPlacement` math (decided): `rb = rotatedBox(body, rotMatrix(rot))`, `fw = max(1, round((rb.max.x-rb.min.x)/20))`, `fd` is the same on z. `pos.x = (x + fw/2)*20 - (rb.min.x+rb.max.x)/2`, `pos.z = (z + fd/2)*20 - (rb.min.z+rb.max.z)/2`, and `pos.y = -y*8 - rb.max.y`.
- The schema accepts an empty `steps` array, empty step `pieces`, numeric strings as color, and extra unknown keys, which are stripped. It rejects a missing `format`, a `rot` of 45, and an item with both `part` and `submodel`.

- [ ] **Step 1: Write the failing tests.**

```ts
const body3001 = { min: [-40,0,-20], max: [40,24,20] } as Box;
test('2x4 brick at origin', () => {
  expect(gridToPlacement({x:0,y:0,z:0,rot:0}, body3001)).toEqual({ pos:[40,-24,20], m:[1,0,0,0,1,0,0,0,1] });
});
test('rotated 90', () => {
  const p = gridToPlacement({x:0,y:0,z:0,rot:90}, body3001);
  expect(p.pos).toEqual([20,-24,40]); expect(p.m).toEqual([0,0,1,0,1,0,-1,0,0]);
});
test('plate stacked on a brick', () => {
  expect(gridToPlacement({x:0,y:3,z:0,rot:0}, {min:[-40,0,-20],max:[40,8,20]}).pos[1]).toBe(-32);
});
test('round trip grid → placement → grid for all rotations', () => { /* x=3,y=2,z=-1 for each rot */ });
test('placementToGrid returns null for 45° rotation', () => { /* m from 45° about Y */ });
```
Also add schema tests for the accept and reject cases above, and an `ensureIds` uniqueness test across steps and submodels.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Normalize `-0` to `0` in outputs.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit as "feat: plan format, schema and grid placement".

### Task 7: Assembly

**Files:**
- Create: `src/model/assemble.ts`
- Test: `tests/model/assemble.test.ts`

**Interfaces:**
- Consumes: Plan types and placement (Task 6), `PartMetrics` (Task 4).
- Produces:
```ts
type Metrics = (part: string) => PartMetrics;   // sync; the caller preloads all parts (partService, Task 10)
type ANode = {
  itemId: string; model: string /* '' = main */; step: number; order: number; // order within the step
  local: Placement;                       // in the parent model's space
  kind: 'piece'; part: string; color: number /* resolved code, 16 → 71 at top level */; placeholder: boolean;
} | {
  itemId: string; model: string; step: number; order: number; local: Placement;
  kind: 'sub'; submodel: string; children: ANode[]; body: Box /* union of children's world-in-sub boxes */;
};
type Instance = { key: string /* path of itemIds joined by '/' */; itemId: string; model: string; part: string; color: number;
                  world: THREE.Matrix4 /* LDU */; worldBox: Box; placeholder: boolean };
type Assembly = { nodes: ANode[]; instances: Instance[]; bounds: Box | null; problems: AssemblyProblem[] };
type AssemblyProblem = { kind: 'missing-submodel' | 'submodel-cycle' | 'unknown-color'; model: string; itemId: string; detail: string };
assemble(plan: Plan, metrics: Metrics, colors: Map<number, ColorDef>): Assembly
```
- A submodel placed on the grid uses `gridToPlacement(grid, submodelBody)`, where `submodelBody` is the submodel's own assembled body bounds. Compute it once per submodel name and memoize it.
- Colors: an unresolvable color produces a problem and renders as 71. Color 16 at the top level becomes 71, and inside a submodel it inherits the parent's color. A grid submodel placement has no color, so pieces with 16 under it become 71.
- A cycle or missing submodel produces a problem, and the placement is skipped. Recursion depth is limited to 16.

- [ ] **Step 1: Write the failing tests.** These use the fixture metrics from Task 4, via a sync map built in `beforeAll` with `measurePart`.
  - A single 3001 at the origin gives 1 instance, and its `worldBox` = {min:[0,-24,0], max:[80,0,40]}.
  - Submodel `engine` (one 3020 at the origin) placed twice, at x=0 and x=10, gives 2 instances whose keys differ (`a/b` style). Their worldBox min x values are 0 and 200.
  - Submodel `a` places `b`, and `b` places `a`: the result has a `submodel-cycle` problem, and it terminates.
  - A placement of a missing `ghost` submodel gives a `missing-submodel` problem and 0 instances for it.
  - An unknown part gives an instance with `placeholder: true`.
  - An empty plan gives 0 instances and `bounds === null`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit as "feat: plan assembly with submodels".

### Task 8: Validation

**Files:**
- Create: `src/model/spatialHash.ts`, `src/model/validate.ts`
- Test: `tests/model/validate.test.ts`

**Interfaces:**
- Consumes: `Assembly` (Task 7).
- Produces:
```ts
type Warning = { kind: 'unknown-part' | 'unknown-color' | 'missing-submodel' | 'submodel-cycle' | 'overlap' | 'floating';
                 itemIds: string[]; instanceKeys: string[]; model: string; message: string };
validate(asm: Assembly): Warning[]
```
- Overlap (decided): two instances' `worldBox`es intersect by more than 2 LDU on every axis.
- Contact: a gap of at most 1 LDU on one axis, plus an intersection of more than 2 LDU on the other two axes.
- Ground: the largest `worldBox.max.y` across all instances.
- Floating: an instance that is not in a contact-connected component containing an instance within 1 LDU of the ground.
- Use a spatial hash with 40-LDU cells. Messages are plain English, e.g. "Brick 2 x 4 overlaps Plate 2 x 4". The name lookup is injected via an optional `names?: (part)=>string`, defaulting to the part id.

- [ ] **Step 1: Write the failing tests.**
  - Two 3001s at the same grid spot give 1 overlap warning listing both itemIds.
  - A 3001 at y=0 with a 3020 at y=3 directly on top gives no warnings.
  - A 3020 at y=10 above an empty spot gives 1 floating warning.
  - Tower: 3001s at y=0, 3, 6 at x=0, plus a 3001 at x=4, y=6 touching the tower's side: no floating warning.
  - A placeholder instance gives an `unknown-part` warning.
  - Assembly problems map to warnings 1:1.
  - Performance: a 3,000-brick grid of non-overlapping 3001s (15×20 footprint, 10 layers) validates in under 300 ms (`performance.now()`) with 0 warnings.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit as "feat: overlap and floating validation".

### Task 9: LDraw import/export and plan files

**Files:**
- Create: `src/io/ldrawImport.ts`, `src/io/ldrawExport.ts`, `src/io/planFile.ts`
- Test: `tests/io/ldraw.test.ts`, `tests/io/planFile.test.ts`

**Interfaces:**
- Consumes: `parseMpd` (Task 3), Plan types (Task 6), `placementToGrid` (Task 6).
- Produces:
```ts
importLDraw(text: string, fileName: string, isPart: (name: string) => boolean): Plan
exportLDraw(plan: Plan, metrics: Metrics, colors: Map<number, ColorDef>): string  // MPD text; grid items converted with gridToPlacement
planToJson(plan: Plan): string                               // pretty, 2-space
readPlanFile(text: string, fileName: string, isPart): { ok: true; plan: Plan } | { ok: false; errors: string[] }  // .json → parsePlan, .ldr/.mpd → importLDraw
```
- Import (decided): the first file is the main model. A ref is a submodel if its name (lower-cased) is one of the MPD's `0 FILE` names, and otherwise a part (strip `.dat`). All imported items are `Raw` (`ldu` + `matrix`), and colors are kept as numeric codes. `0 STEP` splits steps, and the trailing pieces after the last STEP form a final step. Empty steps are dropped. Submodel names drop the `.ldr`/`.dat` extension. The plan name is the file name without its extension.
- Export: each submodel is written as `0 FILE <name>.ldr`, the main model comes first as `0 FILE <planname>.ldr`, steps end with `0 STEP`, and string colors are resolved via `colors`.

- [ ] **Step 1: Write the failing tests.**
  - An MPD with a main model of 2 steps, where the second places `wing.ldr` (one 3020), imports to `steps.length===2` and `submodels.wing.steps[0].pieces.length===1`.
  - Round trip: `importLDraw(exportLDraw(plan))` keeps the instance world boxes, assembling both sides and comparing.
  - `readPlanFile` handles `.json` and `.mpd`, and rejects a `.txt` with an error.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit as "feat: LDraw import/export and plan files".

### Task 10: Edit operations, store, keymap, part service

**Files:**
- Create: `src/plan/ops.ts`, `src/state/store.ts`, `src/state/keymap.ts`, `src/state/partService.ts`
- Test: `tests/plan/ops.test.ts`, `tests/state/store.test.ts`, `tests/state/keymap.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 6, 7, 8.
- Produces (ops, all pure; they return a new Plan and never mutate):
```ts
type ModelName = string; // '' = main
type Footprint = (item: PlanItem) => { w: number; d: number };
moveItems(p: Plan, m: ModelName, ids: string[], d: { x: number; y: number; z: number }): Plan   // grid += d; raw ldu += [20dx, -8dy, 20dz]
rotateItems(p: Plan, m: ModelName, ids: string[], fp: Footprint, body: (i: PlanItem) => Box): Plan
deleteItems(p, m, ids): Plan
setColor(p, m, ids, color: string | number): Plan
setPart(p, m, ids, part: string): Plan
addItem(p, m, step: number, item: PlanItem): Plan          // step === steps.length appends a new step
moveItemsToStep(p, m, ids, step: number): Plan
reorderStep(p, m, from: number, to: number): Plan
insertStep(p, m, at: number): Plan
deleteStep(p, m, at: number): Plan                          // pieces move to the previous step (or next if at === 0)
```
- Rotate (decided): grid items get `rot += 90 mod 360`, with `x' = floor(x + fw/2 - fw'/2 + 0.5)`, `z'` the same with d, where fw/fw' are the footprints before and after. Raw items have their matrix pre-multiplied by `rotMatrix(90)` about the vertical axis through their rotated body box centre, with `ldu` adjusted to keep that centre.
- Store (zustand):
```ts
type StudioState = {
  plan: Plan; past: Plan[]; future: Plan[];                 // history limited to 200
  selection: { model: ModelName; ids: string[] };
  editingModel: ModelName; mode: 'edit' | 'preview'; currentStep: number | null; // null = show all
  apply(fn: (p: Plan) => Plan): void;                       // pushes history, clears future
  undo(): void; redo(): void; setPlan(p: Plan, opts?: { resetHistory: boolean }): void;
  select(ids: string[], additive?: boolean): void;
};
useStudio: UseBoundStore<StoreApi<StudioState>>
```
- Keymap: `commandForKey(e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, cameraAzimuthDeg: number): Command | null`, where
  `type Command = { kind: 'move'; d: {x,y,z} } | { kind: 'rotate' } | { kind: 'delete' } | { kind: 'undo' } | { kind: 'redo' }`.
  Azimuth 0 means the camera sits at +Z looking toward −Z. Arrow keys are camera-relative, snapped to the nearest axis. PageUp/PageDown are y ±1. `r` rotates. `Delete`/`Backspace` delete. Cmd/Ctrl+Z is undo, and Cmd/Ctrl+Shift+Z is redo.
- partService:
```ts
initPartService(fetchText?: FetchText): Promise<void>        // loads LDConfig + catalog
getColors(): Map<number, ColorDef>; getCatalog(): CatalogEntry[];
ensureParts(ids: string[]): Promise<void>                    // loads + measures + builds geometry, 6 concurrent fetches
metricsOf(id: string): PartMetrics                           // placeholder if not loaded/missing
geometryOf(id: string): PartGeometry | null
partName(id: string): string
```

- [ ] **Step 1: Write the failing tests.**
  - Move: a grid piece at x=0 moved {1,0,0} → x=1. A raw piece moved {0,1,0} → ldu y −8.
  - Rotate: a 3001 (fw=4, fd=2) at x=0,z=0, rot 0 → rot 90, x=1, z=−1. Rotating 4 times returns the original.
  - `deleteStep(0)` moves its pieces into the new step 0.
  - `reorderStep(0,2)` order is correct.
  - Ops on a submodel (`m='engine'`) leave main untouched.
  - Store: apply → undo → redo restores the plans by reference equality. A new apply after undo clears future. History is capped at 200.
  - Keymap: azimuth 0: ArrowRight → x+1, ArrowUp → z−1. Azimuth 90: ArrowRight → z−1, ArrowUp → x−1. Cmd+Shift+Z → redo. A plain `z` → null.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement ops, store, keymap and partService. partService isn't unit tested beyond typecheck; it's exercised in Task 12.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit as "feat: edit operations, store with undo, keymap".

### Task 11: Studio scene and instanced brick renderer

**Files:**
- Create: `src/render/materials.ts`, `src/render/bricks.ts`, `src/render/studio.ts`, `src/render/thumbnails.ts`
- Test: `tests/render/bricks.test.ts`

**Interfaces:**
- Consumes: `Instance` (Task 7), `PartGeometry` (Task 5), `ColorDef` (Task 3), partService (Task 10).
- Produces:
```ts
materialFor(color: ColorDef, doubleSided: boolean): THREE.Material        // cached per (code, side)
class BrickRenderer {
  readonly root: THREE.Group;     // rotation.x = Math.PI, scale = 1/20 → 1 world unit = 1 stud, +Y up
  constructor(geometryOf: (part: string) => PartGeometry | null, colors: Map<number, ColorDef>);
  setInstances(list: Instance[]): void;                        // rebuilds InstancedMeshes grouped by (part, color, sub-geometry)
  setMatrices(get: (key: string) => THREE.Matrix4 | null): void; // null hides the instance (zero scale)
  setHighlight(keys: Set<string>, kind: 'select' | 'warn'): void;
  pick(raycaster: THREE.Raycaster): string | null;             // instance key
  meshCount(): number; dispose(): void;
}
type Studio = { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; bricks: BrickRenderer;
                setSize(w: number, h: number): void; render(): void; dispose(): void };
createStudio(canvas: HTMLCanvasElement | OffscreenCanvas, opts: { preserveDrawingBuffer?: boolean }): Studio
getThumbnail(partId: string, colorCode?: number): Promise<string>   // object URL, 128×128, cached in IndexedDB key 'thumb:<id>:<color>'
```
- Look (from the spec): background and floor `#EDEDEF`, matching fog, a large floor plane receiving shadows, and `RoomEnvironment` via PMREM for soft reflections. One directional key light (shadow map 2048, PCFSoftShadowMap, radius 4) plus a hemisphere fill. Bricks use `MeshPhysicalMaterial` with roughness 0.35, clearcoat 0.25 and clearcoatRoughness 0.3. `trans` finishes use `transparent`, `opacity = alpha/255`, `depthWrite: false` and `transmission: 0.6`. `chrome` uses metalness 1 and roughness 0.15, and `metal` uses metalness 0.8 and roughness 0.3. Output uses `ACESFilmicToneMapping` and sRGB.
- Highlights: selection is a cyan emissive tint, and warnings are a red emissive tint, applied with a per-instance color attribute (`instanceColor`) multiplied in. The highlight tint must not change the base color for unhighlighted instances.

- [ ] **Step 1: Write the failing tests.** They run under node, with no WebGL; construct `BrickRenderer` only.
  - 3 instances of 3001/71 plus 1 of 3020/0 give `meshCount() === 2`.
  - `pick` with a ray straight down onto the 3020 returns its key. The ray is built in world units: account for the root transform.
  - `setMatrices` returning null for a key makes that instance's matrix scale 0.
  - 3,000 instances of 1 part/color give `meshCount() === 1`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS. Check visually in Task 12.
- [ ] **Step 5:** Commit as "feat: studio scene and instanced brick renderer".

### Task 12: Editor UI

**Files:**
- Create: `src/App.tsx` (layout), `src/ui/TopBar.tsx`, `src/ui/PartsPanel.tsx`, `src/ui/Viewport.tsx`, `src/ui/Inspector.tsx`, `src/ui/WarningsList.tsx`, `src/ui/StepsTimeline.tsx`, `src/catalog/catalog.ts`, `src/state/useModel.ts`
- Test: `tests/catalog/search.test.ts`, `tests/ui/StepsTimeline.test.tsx`

**Interfaces:**
- Consumes: store and ops (Task 10), Studio (Task 11), assemble and validate (Tasks 7–8), `readPlanFile` and `exportLDraw` (Task 9).
- Produces:
  - `searchCatalog(entries: CatalogEntry[], q: string, limit = 60): CatalogEntry[]`. Ranking: exact id, then id prefix, then all query tokens contained in the name. Normalize `2x4`/`2 x 4`.
  - `useModel(): { assembly: Assembly; warnings: Warning[]; ready: boolean }`. This memoized hook ensures parts (via `ensureParts`), assembles the plan and validates it whenever the plan changes.
- Layout (decided):
  - Top bar: project name (editable), New, Open project, Import file (`.json/.ldr/.mpd`), Export ▾ (Plan JSON, LDraw .mpd), Generate with AI, Paste plan, Copy AI prompt, Preview, Export video, Settings, About.
  - Left (280 px): parts panel with search, a category filter and a thumbnail grid. Clicking a part adds it to the current step (or a new last step when none is selected) at the free grid spot nearest the model centre on the floor, then selects it.
  - Centre: the viewport.
  - Right (300 px): the inspector, showing the selected piece's name, part number with a "change part" search, a color swatch grid from `getColors()` (solid colors first, sorted by name), the step number, and grid x/y/z/rot read-only. Below it is the warnings list.
  - Bottom (140 px): the steps timeline.
- Viewport: OrbitControls. Clicking picks a piece, Shift+click adds to the selection, and Esc clears it. Keys go through `commandForKey` with the current camera azimuth. Warning instances get the red tint and selected ones the cyan tint. When `currentStep` is set, only items with step ≤ currentStep are shown. Double-clicking a submodel instance, or the inspector's "Edit submodel" button, sets `editingModel` and shows only that submodel, with a breadcrumb "Main › engine" to exit.
- Steps timeline: one chip per step showing the step number and piece count, horizontally scrollable. Clicking sets `currentStep`, and "All" clears it. Chips are drag-reorderable (`reorderStep`), and dropping a selected piece onto a chip calls `moveItemsToStep`. A submodel placement inside a step shows as a chip with a ▸ toggle that expands the submodel's own step chips inline; clicking one enters that submodel at that step. Each chip has a "+" step button between chips (`insertStep`) and a delete action on an empty or selected chip (`deleteStep`).
- Clicking a warning selects its items and frames the camera on them. While a submodel is being edited, the warnings list shows only warnings whose items belong to that submodel. This is how the spec's "validation inside each submodel" shows up.

- [ ] **Step 1: Write the failing tests.** Search: `'2x4'` puts `3001` (Brick 2 x 4) above `3002`, `'3001'` puts the exact id first, and `'slope 45'` matches "Slope Brick 45 2 x 2". StepsTimeline (happy-dom): with a plan of 3 steps it renders 3 chips plus "All", clicking chip 2 sets `currentStep` to 1, and a submodel chip expands to show its steps.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the UI. Use plain CSS modules or one `src/ui/app.css`, with a neutral light theme matching the studio look. No UI library.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `npm run dev` and, in the browser, create a new project and add a 2×4 brick, a plate and a slope from the parts panel. Move them with the arrow keys and rotate with R. Stack two bricks at the same spot and check the red outline plus the warning entry. Undo and redo. Import a fixture `.mpd` from the OMR (download one set file by hand, e.g. a small set) and check it renders.
- [ ] **Step 5:** Commit as "feat: editor UI".

### Task 13: Animation core: pacing, floor layout, timeline, camera

**Files:**
- Create: `src/anim/easing.ts`, `src/anim/pacing.ts`, `src/anim/floorLayout.ts`, `src/anim/timeline.ts`, `src/anim/camera.ts`
- Test: `tests/anim/pacing.test.ts`, `tests/anim/floorLayout.test.ts`, `tests/anim/timeline.test.ts`, `tests/anim/camera.test.ts`

**Interfaces:**
- Consumes: `Assembly`, `ANode` (Task 7), `PartMetrics` (Task 4).
- Produces:
```ts
type ArrivalMode = 'piece' | 'batch' | 'step';
type AnimOptions = { targetSeconds: number /* 15 */; heroOrbit: boolean /* true */; mode?: ArrivalMode };
type Pacing = { mode: ArrivalMode; intro: number; outro: number; stepPause: number; slot: number; flight: number; batchSize: number };
choosePacing(units: number, steps: number, opts: AnimOptions): Pacing
type FloorItem = { id: string; w: number; d: number; group: number };
type Region = { x0: number; z0: number; width: number; depth: number }; // studs
layoutFloor(items: FloorItem[], region: Region, gap?: number /* 1 */): { pos: Map<string, { x: number; z: number }>; overflow: string[] }
type Timeline = { duration: number; pacing: Pacing; /* opaque internals */ };
buildTimeline(asm: Assembly, metrics: Metrics, opts: AnimOptions): Timeline
poseAt(tl: Timeline, t: number): (key: string) => THREE.Matrix4 | null   // world LDU matrix per instance key, null = hidden
type CamPose = { position: THREE.Vector3; target: THREE.Vector3; fov: number };  // world units (studs, +Y up)
cameraAt(tl: Timeline, t: number, aspect: number): CamPose
fitDistance(box: THREE.Box3, fovDeg: number, aspect: number, azimuthDeg: number, elevationDeg: number): number
```
- Pacing (decided): `intro = 1.0`, `outro = heroOrbit ? 3.0 : 0.5`, `base = target − intro − outro`, `pauseTotal = min(0.25·(steps−1), 0.2·base)`, `build = base − pauseTotal`, `stepPause = pauseTotal/(steps−1)` (0 when steps ≤ 1).
  - Auto mode: `piece` if build/units ≥ 0.18 (`slot = build/units`, `flight = clamp(slot·2.5, 0.35, 0.9)`). Otherwise `step` if build/steps ≥ 0.6 (`slot = build/steps`, pieces in the step start staggered over 40% of the slot, `flight = min(0.9, 0.6·slot)`). Otherwise `batch` (`slot = 0.6`, `batchSize = ceil(units / floor(build/0.6))`, `flight = 0.5`).
  - A forced mode uses the same formulas. Units = pieces + one per submodel placement (the attach). Steps = all steps across main and submodels as played.
- Play order (decided): depth-first. When a main step contains a submodel placement, that submodel's steps play first (pieces fly to the submodel being built at its side spot), then the attach flight moves the whole chunk to its final place, then the rest of the step continues. Nested submodels recurse.
- Side spot: to the right of the main build area (+X), one footprint width plus 4 studs away, and on the floor.
- Floor layout: the floor region is the area around the build spot, excluding the model's final footprint plus a 2-stud margin. Use two bands, in front of and behind the model, with a total region of 3× the model footprint area. Pieces lie in their natural orientation (rot 0, bottom on the floor), grouped by step (`group`), then sorted by footprint area (descending), then color. Shelf-pack rows, left to right.
  - When `overflow` is non-empty, split the play order into windows that each fit. Only the current window's pieces are on the floor; the next window's pieces drop onto the floor (a 0.3 s fall from 3 bricks up) as soon as the previous window's last flight starts.
  - Submodel pieces are laid out in their own small region next to the side spot.
- Flight: position follows a parabolic arc with peak height `max(3 bricks, 0.15 × horizontal distance)` above the higher end. Rotation slerps from the floor orientation to the final one. Ease: `easeInOutCubic`. The last 12% of the flight is a settle: overshoot 2 LDU down, then back.
- Camera (decided): vertical fov 30, aspect 9/16. During the build, azimuth drifts linearly from 30° to 55° at elevation 42°, with the distance from `fitDistance` over the floor region plus the model bounds and a 1.08 margin, aimed at the region centre. While a submodel builds, the target eases (0.6 s) to the side spot and the distance fits that region, then eases back on attach. Outro: if heroOrbit, a 120° orbit over `outro` seconds around the finished model at elevation 30°, fitted to the model bounds with a 1.25 margin; otherwise hold.
- `duration = intro + build + pauseTotal + outro`. With 0 units, `duration = intro + outro`. Slot start times are compressed so the last flight (including the settle) ends exactly at `intro + build + pauseTotal`; flights never spill into the outro.

- [ ] **Step 1: Write the failing tests.**

```ts
test('small model → piece mode', () => {
  const p = choosePacing(40, 10, { targetSeconds: 15, heroOrbit: true });
  expect(p.mode).toBe('piece'); expect(p.slot).toBeCloseTo(0.22, 2);
});
test('medium model → step mode', () => expect(choosePacing(120, 12, { targetSeconds: 15, heroOrbit: true }).mode).toBe('step'));
test('huge model → batch mode', () => {
  const p = choosePacing(600, 60, { targetSeconds: 15, heroOrbit: true });
  expect(p.mode).toBe('batch'); expect(p.batchSize).toBe(43);
});
test('forced mode wins', () => expect(choosePacing(600, 60, { targetSeconds: 15, heroOrbit: true, mode: 'step' }).mode).toBe('step'));
```
  - Floor layout: 20 items of 2×4 in a 30×10 region have no overlapping rectangles (gap ≥ 1), all group-0 items come before group-1 items in row-major order, and 200 items in that region produce a non-empty overflow.
  - Timeline, built from fixture assemblies (Task 7 helpers):
    - A 3-piece main model: at `poseAt(tl,0)` each piece lies on the floor, so the bottom of its transformed body box (max LDU y) equals the assembly's ground level (largest `worldBox.max.y`) within 0.5 LDU, and it does not overlap the model's final footprint. `poseAt(tl, tl.duration)` equals each instance's `world`. Piece start times are strictly increasing in piece mode. `tl.duration` is within ±0.05 of 15.
    - Main step 0 places `engine` (2 pieces). Just before the engine's attach starts, both engine pieces sit at their side-spot poses (relative transform equal to the final), and at the end they're at their final world matrices.
    - With 0 units, `duration = 4.0`.
    - With 400 pieces and target 15, `duration` ≤ 15.05.
  - Camera: for each corner of the fitted box, the camera at `fitDistance` projects it inside NDC [−1, 1] using `THREE.PerspectiveCamera(30, 9/16)`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit as "feat: animation pacing, floor layout, timeline and camera".

### Task 14: Preview player and MP4 export

**Files:**
- Create: `src/ui/PreviewPlayer.tsx`, `src/ui/ExportDialog.tsx`, `src/export/exportVideo.ts`
- Test: `tests/export/exportVideo.test.ts`

**Interfaces:**
- Consumes: Timeline API (Task 13), `createStudio` (Task 11), settings (Task 16; until then pass `logo: null`).
- Produces:
```ts
frameCount(duration: number, fps: number): number                  // ceil(duration*fps)
type ExportOpts = { timeline: Timeline; instances: Instance[]; width: 1080; height: 1920; fps: 30;
                    logo: { image: ImageBitmap; corner: 'tl'|'tr'|'bl'|'br' } | null;
                    onProgress: (done: number, total: number) => void; signal: AbortSignal };
exportVideo(opts: ExportOpts, deps: { createStudio: typeof createStudio }): Promise<Blob>   // 'video/mp4'
drawLogo(ctx: CanvasRenderingContext2D, img: ImageBitmap, corner, w: number, h: number): void // logo width = 22% of w, 48 px margin, 90% opacity
```
- Export (decided): render into its own offscreen `Studio` at 1080×1920, then composite onto a 2D canvas (frame plus logo) that feeds Mediabunny:
```ts
const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
const source = new CanvasSource(compositeCanvas, { codec: 'avc', bitrate: QUALITY_HIGH });
output.addVideoTrack(source, { frameRate: 30 });
await output.start();
for (i of frames) { pose; camera; studio.render(); composite; await source.add(i / 30, 1 / 30); onProgress }
await output.finalize(); return new Blob([output.target.buffer!], { type: 'video/mp4' });
```
  On abort, call `output.cancel()` and reject with an `AbortError`. Check names against the installed `mediabunny` typings, and adjust only the call shapes, not the approach. If `canEncodeVideo('avc')` is false, show "Your browser can't encode MP4. Use Chrome."
- Preview player: same canvas as the editor (switch with `mode: 'preview'`), showing a 9:16 frame overlay with the area outside dimmed. Controls: play/pause, a scrubber, the time readout, and settings for target length (5–60 s slider), arrival mode (Auto/Piece/Batch/Step), hero orbit toggle, and logo toggle. Playback uses `requestAnimationFrame` with real time.
- Export dialog: progress bar, Cancel, and a download of the resulting blob as `<plan name>.mp4`. Export is disabled when the plan has 0 pieces.

- [ ] **Step 1: Write the failing tests.** `frameCount(15, 30) === 450` and `frameCount(4.01, 30) === 121`. `exportVideo` with a fake `createStudio` and an already-aborted signal rejects with `AbortError`, and with a 0.1 s timeline the fake studio's `render` is called 3 times. Mock `mediabunny` with `vi.mock`, asserting `source.add` timestamps `[0, 1/30, 2/30]`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS. In the browser, preview a small model and export it. The MP4 downloads, plays in QuickTime at 1080×1920, and its length matches the readout.
- [ ] **Step 5:** Commit as "feat: preview player and MP4 export".

### Task 15: AI generation, fix with AI, paste and copy prompt

**Files:**
- Create: `src/ai/palette.ts`, `src/ai/prompt.ts`, `src/ai/schema.ts`, `src/ai/claude.ts`, `src/ai/parsePasted.ts`, `src/ui/AiDialog.tsx`
- Test: `tests/ai/schema.test.ts`, `tests/ai/prompt.test.ts`, `tests/ai/parsePasted.test.ts`, `tests/ai/claude.test.ts`

**Interfaces:**
- Consumes: Plan types and `parsePlan` (Task 6), `Warning` (Task 8), partService (Task 10).
- Produces:
```ts
PALETTE: string[]   // curated LDraw ids, ~150–250: bricks 1x1..2x8, plates 1x1..6x6, tiles, slopes 30/45/65 + inverted,
                    // wedge plates L/R, cones, round 1x1 plates/bricks, headlight 4070, SNOT 87087/99780/99781, canopies,
                    // wheels/tyres small, jumper 3794b, grille 2412b, hinge-free only. The builder picks exact ids from catalog.json.
type PaletteEntry = { id: string; name: string; w: number; d: number; heightPlates: number };
AiPlanSchema: z.ZodType     // like Plan but submodels as an array [{ name, steps }], items without ids, grid-only (no Raw)
aiPlanToPlan(ai: z.infer<typeof AiPlanSchema>): Plan
buildSystemPrompt(palette: PaletteEntry[], colors: ColorDef[]): string
buildGenerateMessage(idea: string, opts: { maxPieces: number /* default 80 */ }): string
buildFixMessage(plan: Plan, warnings: Warning[], note: string): string
buildCopyPrompt(palette: PaletteEntry[], colors: ColorDef[], idea: string): string  // system + task + "reply with only the JSON"
parsePastedPlan(text: string): { ok: true; plan: Plan } | { ok: false; error: string }
class AiError extends Error { kind: 'refusal' | 'truncated' | 'invalid' | 'network' | 'auth' }
generatePlan(args: { apiKey: string; model: string; system: string; user: string; signal?: AbortSignal },
             deps?: { createClient?: (apiKey: string) => Anthropic }): Promise<Plan>
```
- The system prompt must state:
  - the grid convention (copy the Global Constraints wording);
  - that studs are on top and every piece must rest on the ground or touch another piece;
  - that only palette ids may be used, each listed with its `w×d×h(plates)`;
  - color names from the solid and transparent list;
  - that submodels may be used for repeated or separately built assemblies (engines, wings), and are built aside then attached;
  - that steps should read like real instructions (bottom up, 1–6 pieces per step);
  - the max piece count;
  - one short worked example (a 2×4 brick with a 2×4 plate on top, as JSON).
- `generatePlan` (decided):
```ts
const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
const stream = client.beta.messages.stream({
  model, max_tokens: 64000, thinking: { type: 'adaptive' },
  output_config: { effort: 'high', format: zodOutputFormat(AiPlanSchema) },
  betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
  system, messages: [{ role: 'user', content: user }],
}, { signal });
const msg = await stream.finalMessage();
```
  Check `stop_reason` before reading content: `refusal` → `AiError('refusal')`, and `max_tokens` → `AiError('truncated')`. Then JSON.parse the text block, `AiPlanSchema.safeParse` it, and convert; failures → `AiError('invalid')`. Map `AuthenticationError` → `'auth'` and `APIConnectionError` → `'network'` using the SDK's typed classes. If the installed SDK types lack `fallbacks` or `output_config.format` on the beta stream, keep the request body unchanged and add a narrowly scoped type cast with a comment.
- AI dialog has two tabs. **Generate**: idea text, max pieces, Generate. It shows a spinner with elapsed time and Cancel. On success it replaces the plan after a confirm if the current plan isn't empty, as an undoable `apply`. **Fix**: note text, plus the current warnings listed and included, then Fix. This is enabled only when every item is grid-based.
- The "Paste plan" dialog has a textarea and Load (using `parsePastedPlan`). "Copy AI prompt" asks for an idea and copies `buildCopyPrompt` to the clipboard.
- With no API key in settings, Generate/Fix show "Add your Claude API key in Settings" and link to settings.

- [ ] **Step 1: Write the failing tests.**
  - `aiPlanToPlan` maps the submodels array to a record and preserves step order.
  - `buildSystemPrompt` contains every palette id and the string "x and z are in studs".
  - `buildFixMessage` contains the note, each warning message, and the plan JSON.
  - `parsePastedPlan` accepts a reply wrapped in a ```json fence with prose before it, accepts the AI array form, and rejects "hello" with an error.
  - `generatePlan` with a fake client whose `finalMessage` returns `stop_reason: 'max_tokens'` rejects with `kind: 'truncated'`. With `refusal` it rejects with `'refusal'`. With valid JSON text it resolves to a Plan with `format: 'brickmotion-plan'`. With text `"{oops"` it rejects with `'invalid'`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. The palette entries' measurements come from `ensureParts(PALETTE)` plus `metricsOf` at prompt-build time. Drop any palette id that loads as a placeholder.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit as "feat: AI plan generation, fix, paste and copy prompt".

### Task 16: Projects, settings and About

**Files:**
- Create: `src/storage/projects.ts`, `src/storage/settings.ts`, `src/ui/ProjectsDialog.tsx`, `src/ui/SettingsDialog.tsx`, `src/ui/AboutDialog.tsx`
- Test: `tests/storage/projects.test.ts`

**Interfaces:**
- Produces:
```ts
type ProjectMeta = { id: string; name: string; updatedAt: number; pieceCount: number };
listProjects(): Promise<ProjectMeta[]>          // newest first
loadProject(id: string): Promise<Plan | null>
saveProject(id: string, plan: Plan): Promise<void>
deleteProject(id: string): Promise<void>
type Settings = { apiKey: string; model: string; logo: Blob | null; logoCorner: 'tl'|'tr'|'bl'|'br'; logoEnabled: boolean;
                  video: { targetSeconds: number; heroOrbit: boolean; mode: ArrivalMode | 'auto' } };
loadSettings(): Promise<Settings>; saveSettings(s: Settings): Promise<void>
```
- Storage uses idb-keyval with keys `project:<id>`, `projects:index` and `settings`. Autosave runs 1 s after the last plan change, and the app reopens the last project on load. A new project starts with the name "Untitled set" and an empty `steps`.
- Settings dialog: the API key as a password field with the note "Stored only in this browser", a model select (the three ids from Global Constraints), logo upload with a preview, corner and enable toggles, and video defaults.
- About dialog: credits for the LDraw parts library (CC BY 4.0, ldraw.org) and Rebrickable, plus "LEGO® is a trademark of the LEGO Group, which does not sponsor or endorse this app."

- [ ] **Step 1: Write the failing tests.** Use `fake-indexeddb/auto` (add it as a dev dependency). Save two projects and list them: newest first, with correct piece counts. Delete removes the project from the index. `loadSettings` with nothing stored returns defaults (`model: 'claude-opus-5-5'`, `targetSeconds: 15`, `heroOrbit: true`, `mode: 'auto'`, `logoEnabled: false`).
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement, and wire everything into TopBar, ExportDialog (the logo) and PreviewPlayer (the defaults).
- [ ] **Step 4:** Run the tests. Expected: PASS. In the browser, reload the page and confirm the project and settings persist.
- [ ] **Step 5:** Commit as "feat: projects, settings and About".

### Task 17: Sample plan and end-to-end verification

**Files:**
- Create: `samples/mini-jet.plan.json`, `README.md`

- [ ] **Step 1:** Write `samples/mini-jet.plan.json`, a ~40-piece grey mini fighter jet in the style of the reference clips. Use only palette parts, with an `engine` submodel placed twice, a trans-clear canopy, and wedge-plate wings, in 8–12 steps. Load it, and confirm 0 warnings.
- [ ] **Step 2:** Run the full suite with `npm test && npm run typecheck && npm run build`. Expected: everything passes and the build succeeds.
- [ ] **Step 3:** Run a browser walkthrough in the built-in browser with `npm run dev`:
  - Import the sample, edit one piece, then undo.
  - Preview it: the engines build at the side and then attach, and the hero orbit plays.
  - Export the MP4 and check it's 1080×1920 and about 15 s, using `mdls -name kMDItemPixelHeight -name kMDItemDurationSeconds <file>`.
  - Import one real OMR `.mpd` with 200 or more pieces and preview it. The mode is `step` or `batch`, and the duration is ≤ target + 0.05 s.
  - If an API key is configured, run Generate with "a tiny pirate submarine with a periscope" and confirm it loads. Otherwise, check that Copy AI prompt and Paste plan round-trip a plan.
- [ ] **Step 4:** Write `README.md` covering setup (`npm install`, `npm run setup`, `npm run dev`), the workflow, the plan format summary, and credits.
- [ ] **Step 5:** Commit as "docs: sample plan and README".
