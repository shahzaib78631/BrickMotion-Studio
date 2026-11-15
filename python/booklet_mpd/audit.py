"""Audit a booklet/OMR pair: does extraction work and do the steps line up?

Alignment matches callout quantity totals to OMR piece counts and, given an LDraw library, also how the
parts-list pictures look against the OMR steps' parts (shape and colour of each part drawn in four turns):
counts alone pair any two runs of steps with the same totals.
"""
from __future__ import annotations

import json

import numpy as np
from pathlib import Path

from functools import partial

from .truth import build_scoped_steps, build_steps
from instructions_pdf.extract import extract_booklet

from .align import align_groups
from .pairing import Pair


def _extraction(pair: Pair, folder: Path) -> dict:
    cache = folder / "extract.json"
    if cache.is_file():
        return json.loads(cache.read_text())
    folder.mkdir(parents=True, exist_ok=True)
    booklet = extract_booklet(str(pair.pdf), str(folder))
    cache.write_text(json.dumps(booklet))
    return booklet


TRUTH_LOADERS = {"lump": partial(build_steps, expand_submodels=False), "expand": build_steps}


def omr_blocks(groups) -> int:
    """Number of contiguous runs of OMR steps the booklet's steps matched; a real match
    is a few long blocks (one per model), a chance match is scattered."""
    indices = sorted({o for _b, steps in groups for o in steps})
    return sum(1 for pos, o in enumerate(indices) if pos == 0 or o != indices[pos - 1] + 1)


_LOOKS: dict = {}
_CALLOUTS: dict = {}


def part_look(lib, folder: Path, steps: list, omr_steps: list):
    """part_sim for align_groups: per booklet step, the count-weighted mean over its callout pictures of
    the best similarity to any part the OMR steps add (each part drawn in four upright turns)."""
    import cv2
    from .solver.parts import describe, rendered_descriptors, similarity
    cached = _CALLOUTS.get(str(folder))
    if cached is None or cached[0] is not steps:
        callouts = []
        for st in steps:
            row = []
            for e in st.get("callout", []):
                img = cv2.imread(str(folder / e["crop"])) if e.get("crop") else None
                d = describe(cv2.cvtColor(img, cv2.COLOR_BGR2RGB)) if img is not None else None
                if d is not None:
                    row.append((d, e.get("count", 1) or 1))
            callouts.append(row)
        _CALLOUTS.clear()                   # one booklet at a time: its callouts and their best looks per part
        cached = _CALLOUTS[str(folder)] = (steps, callouts, {})
    _steps, callouts, best = cached
    keys = [sorted({(p, c) for p, c, *_ in step}) for step in omr_steps]

    def one(bi, ci, key):
        k = (bi, ci, key)
        if k not in best:
            if key not in _LOOKS:
                _LOOKS[key] = rendered_descriptors(lib, *key) or []
            best[k] = max((similarity(callouts[bi][ci][0], r) for r in _LOOKS[key]), default=0.0)
        return best[k]

    per_step: dict = {}

    def column(bi, j):
        """Per callout of booklet step bi, its best look over the parts OMR step j adds."""
        if (bi, j) not in per_step:
            per_step[(bi, j)] = np.array([max((one(bi, ci, key) for key in keys[j]), default=0.0)
                                          for ci in range(len(callouts[bi]))])
        return per_step[(bi, j)]

    def sim(brange, orange):
        tot = w = 0.0
        for bi in brange:
            if not callouts[bi]:
                continue
            counts = np.array([n for _d, n in callouts[bi]], float)
            looks = np.max([column(bi, j) for j in orange], axis=0) if len(orange) else np.zeros(len(counts))
            tot += float(counts @ looks)
            w += float(counts.sum())
        return tot / w if w else None
    return sim


SWITCH = 0.2  # the cost of starting another model when fitting the booklet as one stretch per model


def group_look(look, groups) -> float:
    """Mean picture agreement (part_look) over an alignment's groups; 0 without pictures."""
    values = [v for v in (look(b, o) for b, o in groups) if v is not None] if look is not None else []
    return round(float(np.mean(values)), 3) if values else 0.0


def mpd_children(omr: Path) -> tuple[str | None, dict[str, list[str]]]:
    """The model file's root and, per sub-file, the sub-files it places (names lower-cased, as LDraw matches them)."""
    root, current, children = None, None, {}
    for line in Path(omr).read_text(errors="replace").splitlines():
        bits = line.split()
        if len(bits) >= 3 and bits[0] == "0" and bits[1].upper() == "FILE":
            current = " ".join(bits[2:]).lower()
            children.setdefault(current, [])
            root = root or current
        elif current is not None and len(bits) >= 15 and bits[0] == "1":
            children[current].append(" ".join(bits[14:]).lower())
    return root, children


def model_blocks(files: list[str], children: dict[str, list[str]], root: str | None) -> list[int]:
    """Per OMR step, which of the root's models it belongs to (that model or one of its sub-models); steps of
    the root itself, or of a file the root does not reach, form a block of their own."""
    def below(name: str, seen: set[str]) -> set[str]:
        if name in seen:
            return seen
        seen.add(name)
        for child in children.get(name, []):
            if child in children:
                below(child, seen)
        return seen
    tops = [c for c in dict.fromkeys(children.get(root, [])) if c in children]
    owner: dict[str, int] = {}
    for b, top in enumerate(tops):
        for name in below(top, set()):
            owner.setdefault(name, b)
    return [owner.get(f.lower(), len(tops)) for f in files]


def segment_blocks(looks: np.ndarray, switch: float = SWITCH) -> list[int]:
    """The order a booklet builds the models in: its steps (rows) fitted as one contiguous stretch per model
    (columns), each model at most once, maximising how much each step looks like its model, less `switch` per
    model started. Returns the models in the order their stretches come."""
    n, nb = looks.shape
    if n == 0 or nb == 0:
        return []
    if nb > EXACT_MODELS:
        return _segment_relaxed(looks, switch)
    layer = {(1 << b, b): float(looks[0, b]) for b in range(nb)}
    back: list[dict] = [{k: None for k in layer}]
    for i in range(1, n):
        nxt, came = {}, {}
        for (mask, b), v in layer.items():
            for b2 in [b] + [x for x in range(nb) if not mask >> x & 1]:
                key = (mask | 1 << b2, b2)
                value = v + float(looks[i, b2]) - (0.0 if b2 == b else switch)
                if value > nxt.get(key, float("-inf")):
                    nxt[key], came[key] = value, (mask, b)
        layer = nxt
        back.append(came)
    key = max(layer, key=layer.get)
    labels = []
    for i in range(n - 1, -1, -1):
        labels.append(key[1])
        key = back[i][key]
    return list(dict.fromkeys(reversed(labels)))


EXACT_MODELS = 8  # above this many models the exact search (every subset of models used) is too slow


def _segment_relaxed(looks: np.ndarray, switch: float) -> list[int]:
    """segment_blocks without "each model once": a model may come back. Models are ordered by where their
    longest stretch starts."""
    n, nb = looks.shape
    score = looks[0].astype(float).copy()
    back = np.zeros((n, nb), int)
    for i in range(1, n):
        best = int(np.argmax(score))
        stay, move = score, score[best] - switch
        back[i] = np.where(stay >= move, np.arange(nb), best)
        score = np.maximum(stay, move) + looks[i]
    labels = [int(np.argmax(score))]
    for i in range(n - 1, 0, -1):
        labels.append(int(back[i][labels[-1]]))
    labels.reverse()
    runs: dict[int, tuple[int, int]] = {}                   # model -> (length, start) of its longest stretch
    start = 0
    for i in range(1, n + 1):
        if i == n or labels[i] != labels[start]:
            length, model = i - start, labels[start]
            if length > runs.get(model, (0, 0))[0]:
                runs[model] = (length, start)
            start = i
    return sorted(runs, key=lambda m: runs[m][1])


def block_order(order: list[int], blocks: list[int], sequence: list[int]) -> list[int]:
    """`order` (OMR step numbers) regrouped by model block: the blocks in `sequence` first, in that order, then
    the rest in the order they come; within a block the steps keep their order."""
    rest = [b for b in dict.fromkeys(blocks[step] for step in order) if b not in sequence]
    return [step for blk in list(sequence) + rest for step in order if blocks[step] == blk]


def booklet_model_order(look, blocks: list[int], n_steps: int) -> list[int]:
    """`segment_blocks` on how each booklet step's callout pictures look like each model's parts (part_look),
    centred per step and per model: a model with many parts looks a little like every step."""
    models = sorted(set(blocks))
    where = {b: [j for j, x in enumerate(blocks) if x == b] for b in models}
    raw = [[look([i], where[b]) for b in models] for i in range(n_steps)]
    seen = np.array([row[0] is not None for row in raw])
    if not seen.any():
        return []
    m = np.array([[v or 0.0 for v in row] for row in raw])
    m -= m.mean(1, keepdims=True)
    m -= m[seen].mean(0, keepdims=True)
    m[~seen] = 0.0
    return [models[k] for k in segment_blocks(m)]


def step_orders(files: list[str], max_runs: int = 12) -> list[list[int]]:
    """Orders of the OMR steps to try aligning: the file's own, and each sub-model's run of steps moved to the
    front (a booklet often builds a sub-model before the model that uses it: 31088's little fish), and every
    sub-model run moved to the front. Indices are the file's step numbers."""
    runs: list[list[int]] = []
    for i, f in enumerate(files):
        if runs and files[runs[-1][0]] == f:
            runs[-1].append(i)
        else:
            runs.append([i])
    flat = lambda rs: [i for r in rs for i in r]
    orders = [list(range(len(files)))]
    root = files[0] if files else None
    subs = [r for r in runs if files[r[0]] != root]
    if subs and len(runs) <= max_runs:
        for r in subs:
            orders.append(r + flat(x for x in runs if x is not r))
    if len(subs) > 1:
        orders.append(flat(subs) + flat(x for x in runs if files[x[0]] == root))
    return orders


def model_files(omr: Path) -> list[Path]:
    """The set's main model first, then its alternate models (3-in-1 sets: '<set>-1_Angler-Fish.mpd')."""
    omr = Path(omr)
    return [omr] + sorted(p for p in omr.parent.glob("*.mpd") if p != omr)


def audit_pair(pair: Pair, work_dir: Path, lib=None) -> dict:
    """Pick, per set, the OMR step granularity (root-file steps with submodels lumped, or
    submodel steps expanded) that best aligns with the booklet's callout totals."""
    result = {"set": pair.set_number, "split": pair.split, "booklet_steps": 0, "omr_steps": 0,
              "alignment_ok": False, "alignment_reason": "", "mean_similarity": 0.0, "truth_mode": None,
              "booklet_coverage": 0.0, "omr_coverage": 0.0, "omr_blocks": 0, "steps_with_picture": 0,
              "extraction_error": None, "aligned": [], "groups": [], "omr_warnings": [], "evidence": None,
              "omr_file": str(pair.omr)}
    try:
        booklet = _extraction(pair, Path(work_dir) / f"{pair.set_number}-{pair.booklet}")
    except Exception as error:  # audit must survive one bad pair
        result["extraction_error"] = f"{type(error).__name__}: {error}"
        result["alignment_reason"] = "extraction failed"
        return result
    steps = booklet["steps"]
    result["booklet_steps"] = len(steps)
    result["steps_with_picture"] = sum(1 for s in steps if s.get("picture"))
    totals = [sum(c["count"] for c in s["callout"]) for s in steps]
    best, errors = None, []
    for omr, mode, loader in ((omr, mode, loader) for omr in model_files(pair.omr) for mode, loader in TRUTH_LOADERS.items()):
        try:
            found: list[str] = []
            omr_steps = loader(str(omr), warnings=found)
            files = ([s["file"] for s in build_scoped_steps(str(omr), expand_submodels=True, warnings=[])]
                     if mode == "expand" else [""] * len(omr_steps))
            if len(files) != len(omr_steps):
                files = [""] * len(omr_steps)
        except Exception as error:
            errors.append(f"{mode}: {type(error).__name__}: {error}")
            continue
        root, children = mpd_children(omr) if mode == "expand" else (None, {})
        blocks = model_blocks(files, children, root)
        orders, seen = step_orders(files), set()
        if lib is not None and len(set(blocks)) > 1:
            # the booklet may build the root's models in another order: try them in the order their pictures say
            look = part_look(lib, Path(work_dir) / f"{pair.set_number}-{pair.booklet}", steps, omr_steps)
            sequence = booklet_model_order(look, blocks, len(steps))
            orders += [block_order(o, blocks, sequence) for o in list(orders)]
        for order in orders:
            if tuple(order) in seen:
                continue
            seen.add(tuple(order))
            ordered = [omr_steps[i] for i in order]
            look = part_look(lib, Path(work_dir) / f"{pair.set_number}-{pair.booklet}", steps, ordered) if lib is not None else None
            alignment = align_groups(totals, [len(s) for s in ordered], part_sim=look)
            one_to_one = sum(1 for b, o in alignment.groups if len(b) == 1 and len(o) == 1)
            covered = min(alignment.booklet_coverage, alignment.omr_coverage)
            # counts let many orders cover nearly everything (a booklet step can merge with its neighbours); among
            # those, the one whose callout pictures look most like the paired parts is the booklet's (42076)
            key = (alignment.ok, round(covered, 1), group_look(look, alignment.groups), round(covered, 2), one_to_one,
                   alignment.mean_similarity)
            if best is None or key > best[0]:
                best = (key, mode, [len(s) for s in omr_steps], alignment, found, omr, order)
    if best is None:
        result["extraction_error"] = "; ".join(errors)
        result["alignment_reason"] = "OMR unreadable"
        return result
    _key, mode, sizes, alignment, warnings, omr, order = best
    blocks = omr_blocks(alignment.groups)               # contiguous in the order the booklet builds
    alignment.groups = [(b, [order[o] for o in os]) for b, os in alignment.groups]
    result.update(omr_file=str(omr), omr_steps=len(sizes), truth_mode=mode, alignment_ok=alignment.ok, alignment_reason=alignment.reason,
                  mean_similarity=alignment.mean_similarity, booklet_coverage=alignment.booklet_coverage,
                  omr_coverage=alignment.omr_coverage, omr_blocks=blocks, omr_warnings=warnings,
                  evidence="strong" if blocks <= 4 else "weak", groups=[[b, o] for b, o in alignment.groups],
                  aligned=[[b[0], o[0]] for b, o in alignment.groups if len(b) == 1 and len(o) == 1])
    return result
