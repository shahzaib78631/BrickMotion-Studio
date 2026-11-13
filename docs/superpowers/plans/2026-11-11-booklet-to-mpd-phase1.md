# Booklet → MPD, Phase 1: pairing, benchmark, confidence, flagged output

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the measurement and flagging layer for booklet→MPD reconstruction: pair booklets with OMR answer keys, align steps, score placements exactly, record an honest baseline of the current solver, and emit MPDs whose uncertain parts are flagged.

**Architecture:** A new Python package `python/booklet_mpd/` that wraps the existing pipeline (`instructions_pdf.extract`, `brickheadz.booklet_vision.reconstruct_sequence`, `brickheadz.reconstruct.steps_from_omr`) without changing it. Pure functions, JSON artifacts under `.cache/booklet-mpd/`, no network.

**Tech Stack:** Python ≥3.11, numpy, pymupdf, pytest (all already in `python/pyproject.toml`).

**Spec:** `docs/superpowers/specs/2026-11-11-booklet-to-mpd-design.md`

**Scope note:** This is Phase 1 only. The spec says the bottleneck to fix is chosen *after* the baseline, so solver generalisation, booklet fetching, learned perception and arrow constraints get their own plans, written from the Task 5 report.

## Global Constraints

- Held-out sets are whole sets; the split is a deterministic function of the set number (Task 1). Reported scores use held-out splits only.
- Exact-pose criterion = part id, colour, translation within 0.001 LDU and identical rotated-vertex signature (rounded 3 dp), the same as `evaluate` in `scripts/reconstruct_real_sequence.py`.
- Reference MPDs are read only after inference has finished; never passed to the solver (except where a task says "oracle parts list", which gives part ids and colours only, no poses).
- Do not modify the frozen stud detector or its weights, and do not edit existing modules in `python/brickheadz/` or `python/instructions_pdf/`.
- No downloads. Booklet fetching is out of scope and needs separate approval.
- Python run from `python/` with `.venv/bin/python`; tests with `.venv/bin/python -m pytest tests/<file> -q`.

## Review Focus

- A booklet whose OMR has a different step count or order (OMR does not follow the booklet): must be excluded with a recorded reason, never scored as if aligned.
- A set whose OMR file is missing or multi-file: skipped with reason, no crash.
- A step the solver cannot attempt (non-plate part, more than two additions): counted as "unsupported", not as a failure and not silently dropped.
- A solver exception mid-booklet: the set keeps the steps solved so far and records the first failing step and message.
- Empty or all-flagged runs: calibration metrics return `None` fields, never divide by zero.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `python/booklet_mpd/__init__.py` | package marker |
| `python/booklet_mpd/pairing.py` | booklet ↔ OMR pairing, deterministic split |
| `python/booklet_mpd/align.py` | global alignment of booklet steps to OMR steps |
| `python/booklet_mpd/score.py` | exact-pose scoring and calibration metrics |
| `python/booklet_mpd/audit.py` | per-pair corpus audit (extraction + alignment) |
| `python/booklet_mpd/baseline.py` | run existing solver with oracle parts list, score, report |
| `python/booklet_mpd/confidence.py` | per-part cues, logistic combiner, flag threshold |
| `python/booklet_mpd/flagged_mpd.py` | MPD writer with flag/confidence comments |
| `scripts/audit_booklet_corpus.py`, `scripts/baseline_booklets.py` | thin CLIs |
| `python/tests/test_booklet_mpd_*.py` | one test file per module |

---

### Task 1: Pairing and deterministic split

**Files:**
- Create: `python/booklet_mpd/__init__.py`, `python/booklet_mpd/pairing.py`
- Test: `python/tests/test_booklet_mpd_pairing.py`

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class Pair: set_number: str; booklet: str; pdf: Path; omr: Path; split: str`
  - `split_of(set_number: str) -> str` returns `"train" | "validation" | "test"`
  - `find_pairs(sources_json: Path, omr_dir: Path, root: Path) -> tuple[list[Pair], list[dict]]` returns pairs and `[{"set": str, "reason": str}]` skips.

- [ ] **Step 1: Write failing tests**
  - `test_split_of_is_deterministic_and_covers_all_three`: `split_of("42093")` equals itself across calls; over `str(n)` for n in 10000..10999 all three values appear, with train fraction in 0.6–0.8.
  - `test_find_pairs_matches_by_set_number`: tmp `sources.json` (`{"version":1,"booklets":[{"set":"42093","booklet":"1","path":"pdf/a.pdf"},{"set":"99999","booklet":"2","path":"pdf/b.pdf"}]}`), tmp OMR dir with `42093-1/42093-1.mpd`; expect one `Pair` for 42093 and skips `[{"set":"99999","reason":"no OMR model"}]`.
  - `test_find_pairs_skips_missing_pdf`: OMR exists but the PDF path does not; reason `"PDF missing"`.
  - `test_find_pairs_picks_set_1_file_when_several_mpds`: dir has `42093-1.mpd` and `42093-1-extra.mpd`; `omr` is the first.
- [ ] **Step 2: Run, expect FAIL** (`ModuleNotFoundError: booklet_mpd`).
- [ ] **Step 3: Implement.** `split_of`: `int(sha256(set_number).hexdigest(),16) % 10` → 0–6 train, 7–8 validation, 9 test. OMR file: `{omr_dir}/{set}-1/{set}-1.mpd`, else the lexicographically first `*.mpd` in `{set}-1/`. PDF = `root / entry["path"]`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(booklet-mpd): pair booklets with OMR answer keys`.

---

### Task 2: Step alignment

**Files:**
- Create: `python/booklet_mpd/align.py`
- Test: `python/tests/test_booklet_mpd_align.py`

**Interfaces:**
- Produces:
  - `PartKey = tuple[str, int]` (LDraw id, colour)
  - `count_similarity(a: int, b: int) -> float` = `min/max`, 0.0 if either is 0
  - `multiset_similarity(a: Counter, b: Counter) -> float` weighted Jaccard `sum(min)/sum(max)`, 0.0 if both empty
  - `@dataclass class Alignment: pairs: list[tuple[int | None, int | None]]; mean_similarity: float; ok: bool; reason: str` (pairs are `(booklet_index, truth_index)`, `None` = gap)
  - `align_steps(a: list, b: list, sim: Callable[[Any, Any], float], *, gap: float = 0.3, min_similarity: float = 0.8, min_matched: float = 0.9) -> Alignment`

- [ ] **Step 1: Write failing tests**
  - identical sequences → `ok` and pairs `[(0,0),(1,1),(2,2)]`.
  - booklet missing the middle step → pairs contain `(None,1)`, still `ok=False` with reason containing `"unmatched"` when matched fraction < 0.9, but pairs for steps 0 and 2 are correct.
  - extra booklet step at the end → `(2,None)`.
  - totally different sequences → `ok=False`, `mean_similarity < 0.8`.
  - `multiset_similarity(Counter({("3001",4):2}), Counter({("3001",4):1}))==0.5`; both empty → `0.0`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** Needleman–Wunsch global alignment maximising total similarity; a pair with similarity below `min_similarity` scores `-1` (treated as mismatch, not a match), a gap costs `gap`. `ok` = matched fraction (pairs with both indices and similarity ≥ `min_similarity`, over `max(len(a), len(b))`) ≥ `min_matched`. `reason` is `""` when ok, else `"N unmatched of M"`. The 0.3 / 0.8 / 0.9 values are my calls from the spec's "exclude on alignment failure".
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(booklet-mpd): global alignment of booklet and OMR steps`.

---

### Task 3: Exact-pose scoring and calibration metrics

**Files:**
- Create: `python/booklet_mpd/score.py`
- Test: `python/tests/test_booklet_mpd_score.py`

**Interfaces:**
- Consumes: `lib` from `assembly_model.ldraw.load_library(str(ROOT/'public/ldraw'))` with `lib.triangles(name+'.dat') -> ndarray (n,3)`.
- Produces:
  - `Part = tuple[str, int, np.ndarray]` (id, colour, 4×4 matrix)
  - `exact_flags(lib, predicted: list[Part], expected: list[Part]) -> list[bool]` one entry per predicted part; each expected part can be claimed once.
  - `calibration(rows: list[tuple[float, bool]], threshold: float) -> dict` with keys `n, flagged, unflagged, unflagged_exact, flagged_exact, flag_recall`; fractions are `None` when their denominator is 0. A row is `(confidence, is_exact)`; flagged means `confidence < threshold`.
  - `reliability_bins(rows, bins: int = 10) -> list[dict]` with `lo, hi, n, exact_fraction`.

- [ ] **Step 1: Write failing tests**
  - using a fake `lib` object whose `triangles` returns a unit-cube vertex array: identical part → `[True]`; translated by 20 LDU → `[False]`; same translation but a 90° rotation of an asymmetric vertex set → `[False]`; a 90° rotation of a symmetric cube → `[True]` (rotation-equivalent geometry counts).
  - duplicates: two predicted identical parts, one expected → `[True, False]`.
  - `calibration([(0.9,True),(0.8,False),(0.2,False),(0.1,True)], 0.5)` → `n=4, flagged=2, unflagged=2, unflagged_exact=0.5, flagged_exact=0.5, flag_recall=0.5` (one of the two wrong parts is flagged).
  - `calibration([], 0.5)` and all-flagged input give `None` fractions, no exception.
  - `reliability_bins` bin edges cover 0–1 and `n` sums to the row count.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** by porting the signature logic of `evaluate` in `scripts/reconstruct_real_sequence.py` (copy the logic; do not import the script). `flag_recall` = wrong-and-flagged / wrong.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(booklet-mpd): exact-pose scoring and calibration metrics`.

---

### Task 4: Corpus audit

**Files:**
- Create: `python/booklet_mpd/audit.py`, `scripts/audit_booklet_corpus.py`
- Test: `python/tests/test_booklet_mpd_audit.py`

**Interfaces:**
- Consumes: `Pair` (Task 1); `align_steps`, `count_similarity` (Task 2); `steps_from_omr(path: str, *, preserve_empty: bool = False) -> list[list[Part]]` from `brickheadz.reconstruct`; `extract_booklet(pdf_path: str, out_dir: str) -> dict` from `instructions_pdf.extract` (result has `steps`, each with `number`, `page`, `picture`, `callout: [{count, countFound, crop, box}]`).
- Produces: `audit_pair(pair: Pair, work_dir: Path) -> dict` with keys `set, split, booklet_steps, omr_steps, alignment_ok, alignment_reason, mean_similarity, steps_with_picture, extraction_error` and `aligned: list[[booklet_index, omr_index]]`; the extraction result is cached at `work_dir/<set>-<booklet>/extract.json`. CLI writes `.cache/booklet-mpd/audit.json` and prints a table.

- [ ] **Step 1: Write failing tests**
  - build a synthetic booklet PDF using the helpers pattern in `python/tests/test_extract.py` (pymupdf pages with step numbers, callout boxes with counts) and a 2-step tmp MPD (step 1: 2 parts, step 2: 1 part); `audit_pair` reports `booklet_steps == 2`, `omr_steps == 2`, `alignment_ok` true. Alignment compares, per step, the callout count total against the OMR step's part count (`count_similarity`).
  - extraction raising (corrupt PDF bytes) → `extraction_error` set, `alignment_ok` false, no exception.
  - second call with the cache present does not call `extract_booklet` again (monkeypatch it to raise).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Part-identity alignment is not used yet because callout crops are not resolved to LDraw ids at this stage; the count-only alignment is the first, weaker filter and the report says so. `scripts/audit_booklet_corpus.py` takes `--split` (default `validation,test`) and `--limit`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Run the audit on the real 31 matched sets** with `.venv/bin/python ../scripts/audit_booklet_corpus.py --split train,validation,test`; expected output: a table with one row per pair and a final line `usable: N of 31`. Record N in the Task 5 report; do not tune thresholds to raise N.
- [ ] **Step 6: Commit** `feat(booklet-mpd): corpus audit of booklet/OMR step alignment`.

---

### Task 5: Baseline of the current solver (oracle parts list)

**Files:**
- Create: `python/booklet_mpd/baseline.py`, `scripts/baseline_booklets.py`
- Test: `python/tests/test_booklet_mpd_baseline.py`

**Interfaces:**
- Consumes: audit result `aligned` and extraction `steps[].picture` (Task 4); `reconstruct_sequence(lib, palette, steps, foundation, *, observer=None, candidate_ranker=None) -> (built, groups, reports)` where `steps` is `[{"number": int, "rgb": ndarray HxWx3 uint8, "parts": [(id, colour), ...]}]` and `reports[i]` has `step, camera{rmsPixels}, fit{score, geometricScore, nextDifferentBoundsScore, arrowErrorPixels}`; `exact_flags` (Task 3).
- Produces:
  - `classify_step(lib, parts: list[tuple[str,int]]) -> str` returns `"supported"` or `"unsupported:<reason>"`; supported = 1 part, or 2 identical parts, every part with `info(lib, id).h == 1` and no `side_studs` (the limits of `solve_additions`).
  - `run_set(lib, palette, truth_steps, pictures: list[np.ndarray], aligned) -> dict` with `{steps_total, steps_supported, steps_attempted, first_failure: {step, message} | None, parts_predicted, parts_exact, per_part: [{step, id, colour, exact, cues}]}`; truth parts supply the **oracle** `(id, colour)` list only.
  - Markdown report `.cache/booklet-mpd/baseline.md` and JSON `baseline.json` with per-split totals and an error budget: share of steps *unsupported*, *camera/solver failed*, *placed wrong*, *placed exact*.

- [ ] **Step 1: Write failing tests**
  - `classify_step`: a 2×4 plate → `"supported"`; a 2×4 brick (h=3) → `"unsupported:not a plate/tile"`; three identical plates → `"unsupported:more than two additions"`.
  - `run_set` with a monkeypatched `reconstruct_sequence` that raises `ValueError("camera")` on its second call → `first_failure == {"step": 2, "message": "camera"}`, `steps_attempted == 2`, parts from step 1 still counted.
  - error-budget fractions sum to 1.0.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The foundation is chosen as in `scripts/reconstruct_real_sequence.py` (largest unique studded plate in step 1); if ambiguous, record `first_failure` with that message and skip the set. Steps are fed one at a time so a failure keeps earlier results. Truth is opened only after `reconstruct_sequence` returns. Report only held-out splits (`validation`, `test`) in the headline and list training sets separately.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Run on the usable real sets**: `.venv/bin/python ../scripts/baseline_booklets.py --split validation,test`; expected: `baseline.md` exists with the error budget. Read it and write the headline numbers into the Task 7 handoff message. If `steps_supported` is under 20% of steps, say so plainly: the solver, not the data, is the limit.
- [ ] **Step 6: Commit** `feat(booklet-mpd): baseline of current solver on real booklets`.

---

### Task 6: Confidence cues and combiner

**Files:**
- Create: `python/booklet_mpd/confidence.py`
- Test: `python/tests/test_booklet_mpd_confidence.py`

**Interfaces:**
- Consumes: `reports[i]` dicts from `reconstruct_sequence`; `per_part` rows from Task 5; `calibration` (Task 3).
- Produces:
  - `FEATURES = ("geometric_score", "margin", "camera_rms_ratio", "arrow_error_ratio")`
  - `cues_from_report(report: dict, scale: float) -> dict[str, float]`: `geometric_score = fit["geometricScore"]`; `margin = geometricScore − nextDifferentBoundsScore` (1.0 when no alternative); `camera_rms_ratio = camera["rmsPixels"]/scale`; `arrow_error_ratio = fit.get("arrowErrorPixels",0)/scale`.
  - `fit_combiner(rows: list[tuple[dict[str,float], bool]], l2: float = 1.0) -> dict` returns `{"weights": [..], "bias": float}` by L2-regularised logistic regression (numpy Newton/IRLS, 50 iterations max).
  - `confidence(cues: dict[str, float], model: dict) -> float` in (0,1).
  - `choose_threshold(rows: list[tuple[float, bool]], target_unflagged_exact: float = 0.9) -> float` the lowest threshold whose unflagged exactness meets the target on the given rows; `1.0 + 1e-9` (flag everything) if none does.

- [ ] **Step 1: Write failing tests**
  - `fit_combiner` on separable synthetic rows (high `geometric_score` ⇒ exact) gives `confidence` > 0.8 for a high-score cue vector and < 0.2 for a low one.
  - `margin` is `1.0` when `nextDifferentBoundsScore` is `None`.
  - `choose_threshold` on rows `[(0.9,True),(0.8,True),(0.3,False)]` with target 1.0 returns a value in (0.3, 0.8]; with all-wrong rows returns a value above 1.0.
  - empty rows → `fit_combiner` raises `ValueError`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Fit on the training split only; select the threshold on validation; report on test (the 0.9 target is my call). More cues (collision, support, parts-list consumption) are added in the Phase 2 plan once the baseline shows which matter.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(booklet-mpd): confidence combiner and flag threshold`.

---

### Task 7: Flagged MPD writer and handoff report

**Files:**
- Create: `python/booklet_mpd/flagged_mpd.py`
- Test: `python/tests/test_booklet_mpd_flagged_mpd.py`
- Modify: `python/booklet_mpd/baseline.py` (append calibration section to the report)

**Interfaces:**
- Consumes: groups `list[list[Part]]` from `reconstruct_sequence`, per-part confidences (Task 6).
- Produces: `write_flagged_mpd(path: Path, name: str, groups, confidences: list[list[float]], threshold: float, failed_from_step: int | None = None) -> dict` returning `{"parts": n, "flagged": n, "steps_flagged": [ints]}`.
  Output format: first line `0 FILE <name>.ldr`; each part line is standard LDraw type 1; a part below threshold is preceded by `0 // BRICKMOTION FLAG confidence=<0.00>`; each step ends with `0 STEP`; a step with any flag is preceded by `0 // BRICKMOTION STEP_FLAGGED <n>`; if `failed_from_step` is set, a final comment `0 // BRICKMOTION INCOMPLETE from step <n>`; ends with `0 NOFILE`.

- [ ] **Step 1: Write failing tests**
  - two steps, one part below the threshold: output contains exactly one `FLAG` line, positioned directly before that part's `1 ...` line, and a `STEP_FLAGGED` comment for that step only.
  - `failed_from_step=3` adds the `INCOMPLETE from step 3` comment; none otherwise.
  - the written file round-trips through `brickheadz.reconstruct.steps_from_omr`, returning the same parts and matrices (comments ignored).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** using the matrix serialisation of `write_mpd` in `scripts/reconstruct_real_sequence.py` (`'%.6g'` values: translation then row-major rotation).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Add calibration to the baseline report**: after Task 6's combiner is fitted on training sets, `baseline.md` gets a section with `calibration(...)` for validation and test and the reliability bins. If there are fewer than 30 scored parts in a split, print "too few parts to calibrate" instead of numbers.
- [ ] **Step 6: Run the full new test set**: `.venv/bin/python -m pytest tests/test_booklet_mpd_*.py -q` — expected all pass; and the existing suites still pass: `tests/test_extract.py tests/test_brickheadz_instruction_place.py tests/test_brickheadz_reconstruct.py`.
- [ ] **Step 7: Commit** `feat(booklet-mpd): flagged MPD output and calibration report`.

---

## Self-review against the spec

- **Goals 1–3** (MPD with confidence, hard score, calibrated flags): Tasks 5–7. Goal 4 (learning where it beats geometry): deliberately deferred; the baseline's error budget decides it.
- **Anti-goal "no tuning on report sets":** deterministic split (Task 1), combiner fit on train, threshold on validation, reporting on test (Task 6).
- **Spec "Order of work" items 1 and 6** are covered; items 2–5 and 7 are separate plans, which this plan's scope note states.
- **Spec open item (OMR/booklet alignment unverified):** Task 4 measures it and records exclusions with reasons.
- Names are consistent: `Pair`, `Alignment`, `Part`, `exact_flags`, `calibration`, `cues_from_report`, `write_flagged_mpd` are used with the same signatures where consumed.

## Known risks to carry into the next plan

- `solve_additions` only supports studs-up plates, with one addition (or two identical) per step, so most real steps will be "unsupported". The baseline reports that share; widening the solver is the likely first Phase 2 task.
- Part-identity resolution from callout crops is not measured here (the baseline uses an oracle parts list). It needs its own measure before any end-to-end claim.
