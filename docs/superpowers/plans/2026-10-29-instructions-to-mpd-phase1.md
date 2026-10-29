# Instruction PDFs → MPD, Phase 1 (deterministic) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One terminal command turns a set's LEGO instruction booklets (+ the set number for its Rebrickable inventory) into an MPD with the right parts, colours and official step order — new parts of each step laid out beside the model, not yet placed — plus a report of everything uncertain.

**Architecture:** Python (PyMuPDF, numpy) does the PDF and image work: split booklets into steps, cut out callout parts and inventory parts, match each callout part to an inventory element. TypeScript does everything LDraw: the set inventory from the Rebrickable API (element ID → LDraw part + LDraw colour, both given by the API), Plan construction, MPD export through the existing `exportLDraw`, and the report. A Node script orchestrates and calls Python the way `scripts/assembly-corrector-bridge.ts` does. Phase 2 (agent placement) is a separate plan.

**Tech Stack:** TypeScript + tsx + vitest (existing); Python 3.14 project in `python/` (uv, pytest) + `pymupdf`.

**Spec:** `docs/superpowers/specs/2026-10-29-instructions-to-mpd-design.md`

## Global Constraints

- The Rebrickable API key comes only from env `REBRICKABLE_API_KEY`; never written to the repo, logs or the report.
- Never silently guess a part or colour: anything not matched exactly is listed in the report under **Flags** and, where a fallback is used, the fallback is named.
- Step order and step count must equal the booklets' (main step numbers 1..N, no gaps, no duplicates).
- Downloaded PDFs are untrusted data: read only, never execute; downloads go to `.cache/instructions/pdf/` (already gitignored via `.cache`).
- Work folder: `.cache/instructions/<name>/` — every intermediate file lives there so any stage can re-run.
- Reuse `src/ldraw/*`, `src/plan/*`, `src/io/ldrawExport.ts`; do not re-implement LDraw parsing or export.
- Booklet layout facts (from 40859 booklets 6668730/6668732, 383×289 pt pages): main step numbers are text spans of size **26.0**; section markers **31.6**; sub-build numbers **16.0–22.0**; page numbers **10.0** at y≈265; part counts are text `^\d+x$`; inventory text is pairs `^\d+x$` then `^\d{5,8}$` (element ID); callout boxes are filled vector rectangles with one embedded image per part; the step picture is the largest embedded image in the step's panel.

## Review Focus

1. **Regional duplicate booklets** (6668729 ≡ 6668730, 6668731 ≡ 6668732) passed together → deduped by text hash; steps not doubled. Test in Task 4.
2. **Booklets passed out of order** → ordered by first main step number. Test in Task 4.
3. **Callout image with no readable count text** → count 1, flagged, no crash. Test in Task 2.
4. **Element in a booklet but not in the API inventory, or part file missing from the LDraw library (printed parts like `87079pr0255`)** → flagged; unprinted fallback (strip `pr\d+`) when that file exists. Tests in Tasks 1 and 5.
5. **Callout counts exceed the inventory count** for an element, or a non-instruction PDF (e.g. 6668733, Marvel 76345) yields no steps → mismatch flagged / clear error "no instruction steps found in <id>". Tests in Tasks 3 and 4.

---

### Task 1: Set inventory from the Rebrickable API (TS)

**Files:**
- Create: `src/instructions/rebrickable.ts`
- Test: `tests/instructions/rebrickable.test.ts`

**Interfaces:**
- Produces:
  - `type SetPart = { element: string | null; part: string; ldrawPart: string; color: number | null; colorName: string; quantity: number; spare: boolean; image: string | null }`
  - `fetchSetParts(setNum: string, apiKey: string, fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown>): Promise<SetPart[]>` — GETs `https://rebrickable.com/api/v3/lego/sets/<setNum>/parts/?page_size=1000&inc_color_details=1` with header `Authorization: key <apiKey>`, follows `next` until null.
  - `fetchSubSets(setNum: string, apiKey: string, fetchJson?): Promise<{ setNum: string; quantity: number }[]>` — GETs `https://rebrickable.com/api/v3/lego/sets/<setNum>/sets/?page_size=1000` (same header, same pagination); rows give `set_num` and `quantity`.
  - `fetchSetInventory(setNum: string, apiKey: string, fetchJson?): Promise<SetPart[]>` — `fetchSetParts` for the set plus, recursively, every sub-set's parts with `quantity` multiplied by the sub-set quantity; rows with the same `element` and `spare` merge by summing `quantity`.
  - `toSetPart(row: unknown): SetPart` — from one API result: `element_id`, `quantity`, `is_spare`, `part.part_num`, `part.part_img_url`, `part.external_ids.LDraw[0]` (fallback `part.part_num`) → `ldrawPart`, `color.external_ids.LDraw.ext_ids[0]` → `color` (missing → `null`), `color.name`.
  - `type Resolved = { part: string; color: number | null; flags: string[] }`
  - `resolveSetPart(p: SetPart, hasPart: (id: string) => boolean): Resolved` — `ldrawPart` if the file exists; else unprinted fallback (strip `pr\d+`) if that exists; flags for either fallback and for `color === null`.
  - `loadSetParts(setNum: string, cacheFile: string): Promise<SetPart[]>` — reads the key from env `REBRICKABLE_API_KEY` (error `"Set REBRICKABLE_API_KEY (free key from rebrickable.com/users/<you>/settings/#api)"` if absent), uses `fetchSetInventory`, caches the JSON at `cacheFile`, reuses the cache when present.

- [ ] **Step 1: Write the failing tests** — `tests/instructions/rebrickable.test.ts` with a recorded-shape fixture (no network):

```ts
const row = { element_id: '6572522', quantity: 29, is_spare: false,
  part: { part_num: '22885', part_img_url: 'https://cdn.rebrickable.com/media/parts/elements/6572522.jpg', external_ids: { LDraw: ['22885'] } },
  color: { id: 72, name: 'Dark Bluish Gray', external_ids: { LDraw: { ext_ids: [72] } } } };
test('maps an API row to LDraw part and colour', () => {
  expect(toSetPart(row)).toEqual({ element: '6572522', part: '22885', ldrawPart: '22885', color: 72, colorName: 'Dark Bluish Gray', quantity: 29, spare: false, image: row.part.part_img_url });
});
test('follows pagination and sends the key header', async () => {
  const calls: [string, Record<string, string>][] = [];
  const pages = [{ results: [row], next: 'https://rebrickable.com/api/v3/x?page=2' }, { results: [row], next: null }];
  const parts = await fetchSetParts('40859-1', 'k', async (u, h) => { calls.push([u, h]); return pages[calls.length - 1]; });
  expect(parts).toHaveLength(2);
  expect(calls[0][0]).toBe('https://rebrickable.com/api/v3/lego/sets/40859-1/parts/?page_size=1000&inc_color_details=1');
  expect(calls[0][1]).toEqual({ Authorization: 'key k' });
});
test('printed part missing from LDraw falls back to unprinted, flagged', () => {
  const p = { ...toSetPart(row), part: '87079pr0255', ldrawPart: '87079pr0255' };
  expect(resolveSetPart(p, (id) => id === '87079')).toEqual({ part: '87079', color: 72, flags: ['87079pr0255 not in LDraw library; using unprinted 87079'] });
});
test('colour without an LDraw id is flagged, never guessed', () => {
  const p = { ...toSetPart(row), color: null, colorName: 'Mystery' };
  expect(resolveSetPart(p, () => true).flags).toEqual(['colour Mystery has no LDraw id']);
});
```

Also add `test('includes sub-set parts multiplied by quantity')`: parent `/parts/` returns one row (`3003`, qty 2); `/sets/` returns `[{ set_num: '40859-2', quantity: 2 }]` whose `/parts/` returns the `6572522` row (qty 29) → result has `6572522` with quantity `58` and `3003` with quantity `2`.

- [ ] **Step 2: Run** `npx vitest run tests/instructions/rebrickable.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `src/instructions/rebrickable.ts` (default `fetchJson` uses global `fetch`, throws on non-2xx with the status and set number).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(instructions): read set inventory from the Rebrickable API`.

---

### Task 2: Booklet extraction (Python)

**Files:**
- Modify: `python/pyproject.toml` (add `pymupdf>=1.26` to dependencies; add `instructions_pdf` to `packages`)
- Create: `python/instructions_pdf/__init__.py`, `python/instructions_pdf/__main__.py`, `python/instructions_pdf/extract.py`
- Test: `python/tests/test_extract.py`

**Interfaces:**
- Produces (JSON written by `python -m instructions_pdf extract <pdf> <out_dir>` to `<out_dir>/booklet.json`, crops as PNG in `<out_dir>/crops/`; all coordinates PDF points, `Box = [x0, y0, x1, y1]`):

```ts
type CalloutPart = { crop: string; count: number; countFound: boolean; box: Box };
type ExtractedStep = { page: number; number: number; section?: number; picture: string | null; callout: CalloutPart[]; substeps: number[] };
type InventoryEntry = { element: string; count: number; crop: string | null };
type Booklet = { id: string; textHash: string; pages: number; steps: ExtractedStep[]; inventory: InventoryEntry[] };
```

- `extract_booklet(pdf_path: str, out_dir: str) -> dict` (the `Booklet` above).

Rules (the decisions; the body is the implementer's):
- Main step = text span size 26.0±0.6 matching `^\d+$`. Section = 31.6±0.6 → `section` on the next main step on or after that page. Sub-build numbers 15.5–22.5 → `substeps` of the nearest main step on the same page.
- Callout box = filled drawing rectangle (from `page.get_drawings()`) containing ≥1 image and ≥1 `Nx` text; its images are callout parts. Each part's `count` = the `Nx` span whose centre is nearest below the image's centre within the box; none → `count: 1, countFound: false`.
- Each callout box belongs to the main step number below it with the smallest distance from the box's bottom-left to the number's top-left.
- Step picture = largest image on the page not inside any callout box whose centre is nearest the step number; crop rendered at 150 dpi.
- Inventory = pages where text has ≥10 `Nx` + `\d{5,8}` pairs; crop = image directly above each count.
- `textHash` = sha256 of all page text concatenated.

- [ ] **Step 1: Write failing tests** — build a synthetic 2-page PDF in the test with PyMuPDF (`insert_text` with fontsize 26 / 31.6 / 16, `draw_rect` filled `(0.7,0.85,0.95)`, `insert_image` small solid-colour PNGs) and assert:
  - `test_steps_in_order`: numbers `[1, 2, 3]`, step 1 `section == 1`.
  - `test_callout_counts`: step 2 callout has 2 parts with counts `[2, 1]`, all `countFound`.
  - `test_missing_count_defaults_to_one`: a callout image with no `Nx` → `count == 1`, `countFound is False`.
  - `test_substeps`: step 3 `substeps == [1, 2]`.
  - `test_inventory`: an inventory page with 10 pairs → 10 entries, first `{element: '6572522', count: 29}`.
- [ ] **Step 2: Run** `cd python && uv add pymupdf && uv run pytest tests/test_extract.py -v` → FAIL.
- [ ] **Step 3: Implement** `extract.py` + `__main__.py` (argparse subcommands `extract`, `match`).
- [ ] **Step 4: Run** the tests → PASS. Then on the real booklet: `uv run python -m instructions_pdf extract ../.cache/instructions/pdf/6668730.pdf /tmp/b1` → `booklet.json` has steps 1..45 in order with sections 1, 2, 3; crops look right when opened.
- [ ] **Step 5: Commit** `feat(instructions): extract steps, callouts and inventory from instruction PDFs`.

---

### Task 3: Callout ↔ inventory matching (Python)

**Files:**
- Create: `python/instructions_pdf/match.py`
- Test: `python/tests/test_match.py`

**Interfaces:**
- Consumes: `Booklet` JSON files from Task 2.
- Produces: `python -m instructions_pdf match <work_dir>` reads every `<work_dir>/*/booklet.json`, writes `<work_dir>/matches.json`:

```ts
type Match = { booklet: string; step: number; index: number; element: string | null; score: number; alternatives: { element: string; score: number }[] };
type Matches = { matches: Match[]; overUse: { element: string; used: number; inventory: number }[]; unused: { element: string; left: number }[] };
```

- `match_callouts(booklets: list[dict], work_dir: str, min_score: float = 0.7) -> dict`
- Candidates: the booklets' own inventory crops; when **no** booklet has an inventory page, every `<work_dir>/rb-images/<element>.jpg` (written by the CLI from the Rebrickable API, Task 6) is a candidate with `element` = file stem. Add `test_uses_rb_images_without_inventory`.

Decisions: crops are the same booklet art at different scales, so compare normalised images: trim the uniform background, resize to 48×48 on a neutral background, score = 0.5·(grayscale correlation) + 0.5·(1 − mean-colour distance in Lab / 100), clamped to [0, 1]. Assign best element per callout part; `element = null` when best score < `min_score`. Keep the top 3 as `alternatives`. Totals per element compare callout counts against inventory counts → `overUse` / `unused`.

- [ ] **Step 1: Write failing tests** with synthetic PNGs (PIL-free: numpy arrays saved via PyMuPDF `Pixmap`): a red L-shape, blue square, green bar as "inventory"; callouts are the same shapes rescaled ×0.6 on the callout background.
  - `test_matches_rescaled_art`: each callout matches its shape's element with `score >= 0.9`.
  - `test_low_score_is_unmatched`: a yellow circle callout → `element is None`, alternatives non-empty.
  - `test_over_use_reported`: callout counts totalling 3 for an element with inventory 2 → `overUse == [{element, used: 3, inventory: 2}]`.
- [ ] **Step 2: Run** `uv run pytest tests/test_match.py -v` → FAIL.
- [ ] **Step 3: Implement** `match.py`.
- [ ] **Step 4: Run** → PASS. On real data (after Task 2 output for 6668730 and 6668732 in one work dir) spot-check 5 matches by opening the crops.
- [ ] **Step 5: Commit** `feat(instructions): match callout parts to inventory elements`.

---

### Task 4: Fetch, dedupe and order booklets + Python bridge (TS)

**Files:**
- Create: `src/instructions/types.ts` (the JSON types from Tasks 2–3, verbatim), `src/instructions/booklets.ts`, `scripts/instructions/pythonBridge.ts`
- Test: `tests/instructions/booklets.test.ts`

**Interfaces:**
- Produces:
  - `bookletUrl(idOrPath: string): string | null` — bare digits → `https://www.lego.com/cdn/product-assets/product.bi.core.pdf/<id>.pdf`; an `http(s)` URL → itself; otherwise `null` (local path).
  - `orderBooklets(list: Booklet[]): { booklets: Booklet[]; flags: string[] }` — drops later booklets whose `textHash` equals an earlier one (flag `"<id> is a duplicate of <id>; skipped"`), sorts by first step number, throws `Error("no instruction steps found in <id>")` for a booklet with no steps, flags gaps/duplicates in the combined step numbers (`"step 12 missing"`).
  - `runPython(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>` in `pythonBridge.ts`, using `python/.venv/bin/python` (or `CORRECTOR_PYTHON`) with `cwd: python/` — same pattern as `scripts/assembly-corrector-bridge.ts`.

- [ ] **Step 1: Write failing tests**: `bookletUrl('6668730')` → the CDN URL; `orderBooklets` with `[b2(steps 46..60), b1(1..45), b1copy(same hash)]` → ids `[b1, b2]` + duplicate flag; with b1 missing step 12 → flag `step 12 missing`; booklet with `steps: []` → throws `no instruction steps found in 6668733`.
- [ ] **Step 2: Run** `npx vitest run tests/instructions/booklets.test.ts` → FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(instructions): fetch, dedupe and order booklets`.

---

### Task 5: Plan, layout, MPD and report (TS)

**Files:**
- Create: `src/instructions/buildPlan.ts`, `src/instructions/report.ts`
- Test: `tests/instructions/buildPlan.test.ts`

**Interfaces:**
- Consumes: `Booklet`, `Matches` (Task 4 types), `SetPart`, `Resolved`, `resolveSetPart` (Task 1).
- Produces:
  - `planFromBooklets(name: string, booklets: Booklet[], matches: Matches, resolve: (element: string) => Resolved): { plan: Plan; flags: Flag[] }`
  - `type Flag = { step?: number; message: string }`
  - `instructionsReport(name: string, plan: Plan, flags: Flag[], matches: Matches): string` (Markdown).

Decisions:
- One Plan per figure; `plan.name = name`. Each booklet main step → one `Step` in order; `step.title = "Section N"` on the step that starts section N; `step.notes = "booklet <id> page <p>"`.
- Each matched callout part → `count` pieces `{ part, color, x, y: 0, z, rot: 0 }`. Layout beside the model: step k (0-based) row `z = -(8 + 4k)`, pieces along x from 0 with pitch 8 studs. Unmatched part (`element === null`) or `color === null` → part `3001`, colour `16`, and a flag naming the step and alternatives. Never drop a piece.
- Sub-builds stay inline in Phase 1: each step with `substeps.length` gets flag `"step N has a sub-build (sub-steps …) kept inline"`.
- `resolve(element)` finds the `SetPart` with that `element` (none → flag `element <id> not in Rebrickable inventory for <set>`, placeholder piece) and calls `resolveSetPart`.
- Booklets without an inventory page (e.g. other figures' booklets): Task 3 matches callouts against the `SetPart.image` pictures instead (downloaded to `<work>/rb-images/<element>.jpg`), scored the same way.
- Report sections: Summary (steps, pieces, flags count), Flags (by step), Inventory check (`overUse`, `unused`, plus API-vs-booklet count differences ignoring spares), Per-step table (step, page, parts, lowest match score).

- [ ] **Step 1: Write failing tests** with a 3-step in-memory booklet + matches:
  - `test steps follow booklet order and titles`: `plan.steps.length === 3`, `plan.steps[0].title === 'Section 1'`.
  - `test count expands to pieces at the step row`: a callout with count 2 → two pieces at `z === -8` (step 0), x `0` and `8`.
  - `test unmatched part becomes flagged placeholder`: piece `{ part: '3001', color: 16 }` and a flag with `step: 2`.
  - `test exports through exportLDraw`: `exportLDraw(plan, fakeMetrics, colors)` contains three `0 STEP` lines (use the fake metrics helper from existing tests, e.g. `tests/io/*export*`).
  - `test report lists over-use`: report contains `| 302328 | 3 | 2 |`.
- [ ] **Step 2: Run** `npx vitest run tests/instructions/buildPlan.test.ts` → FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(instructions): build plan, MPD and report from booklets`.

---

### Task 6: CLI and end-to-end run on 40859 Superman

**Files:**
- Create: `scripts/instructions-to-mpd.ts`
- Modify: `package.json` (script `"instructions": "tsx scripts/instructions-to-mpd.ts"`), `README.md` (short usage section)

**Interfaces:**
- Consumes: everything above.
- CLI: `npm run instructions -- --name <name> --set <rebrickable set_num, e.g. 40859-1> --pdf <id|url|path> [--pdf …] [--out <file.mpd>]`
  Pipeline: download PDFs to `.cache/instructions/pdf/` (skip if cached) → `runPython(['-m','instructions_pdf','extract', pdf, work/<id>])` per booklet → `orderBooklets` → `loadSetParts(set, work/rebrickable-parts.json)` → if no booklet has an inventory, download each non-spare `SetPart.image` to `work/rb-images/<element>.jpg` → `runPython(['-m','instructions_pdf','match', work])` → `planFromBooklets` → metrics built the way `scripts/diagnose-construction-mpd.ts` does (lines ~98–111, from `public/ldraw`) → `exportLDraw` → write `<out>` (default `<work>/<name>.mpd`) and `<work>/report.md`; print summary + paths. Exit code 1 with the message on any thrown error.

- [ ] **Step 0: Prerequisite** — `export REBRICKABLE_API_KEY=…` (user's own key, set in their shell; never committed).
- [ ] **Step 1: Run** `npm run instructions -- --name superman --set 40859-1 --pdf 6668730 --pdf 6668729 --pdf 6668732` (6668729 deliberately included as the duplicate).
  Expected: report says 6668729 skipped as duplicate; steps 1..N contiguous; MPD written.
- [ ] **Step 2: Acceptance** (spec Phase 1 success): every callout part either matched with a resolved colour or listed under Flags; step count equals the booklets'; `npm run instructions -- --name doom --set 76345-1 --pdf 6668733` exits 1 with `no instruction steps found in 6668733`.
- [ ] **Step 3: Open** the MPD in BrickMotion (dev server, Models → import) → loads with N steps, each step's parts in their row.
- [ ] **Step 4: Run** full checks: `npm run typecheck && npx vitest run tests/instructions && (cd python && uv run pytest tests/test_extract.py tests/test_match.py)` → all pass.
- [ ] **Step 5: Commit** `feat(instructions): instructions-to-mpd CLI`.
