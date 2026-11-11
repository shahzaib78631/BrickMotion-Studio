"""Benchmark runners (answer key for scoring only): teacher-forced booklet steps, parts reading,
free-run booklets and the MEPNet datasets. Results are cached per set under
.cache/booklet-mpd/solver/<mode>/<set>.json so reports can be rebuilt without recomputation."""
from __future__ import annotations

import json
import time
import traceback
from pathlib import Path

import numpy as np

from .dataset import CACHE

OUT = CACHE / "solver"
_STATE: dict = {}


def init_worker(oracle: bool = True):
    from assembly_model.ldraw import load_library

    from .collide import Collider
    _STATE["lib"] = load_library(str(Path(__file__).resolve().parents[3] / "public/ldraw"))
    _STATE["collider"] = Collider(_STATE["lib"], use_oracle=oracle)


def part_features(sc, result) -> dict:
    if sc is None:
        return {}
    return {"score": float(sc.score), "colour": float(sc.colour), "edge": float(sc.edge), "delta": float(sc.delta),
            "margin": float(sc.margin), "changed": int(sc.changed), "seated": float(sc.seated),
            "registration": float(result.registration), "fit_iou": float(result.fit_iou)}


def teacher_set(set_number: str, force: bool = False) -> dict:
    """Teacher-forced: true model before each step and true new-part identities are given."""
    from .dataset import cases
    from .evaluate import step_scores
    from .step import solve

    path = OUT / "teacher" / f"{set_number}.json"
    if path.exists() and not force:
        return json.loads(path.read_text())
    lib, collider = _STATE["lib"], _STATE["collider"]
    rows = []
    t0 = time.time()
    for case in cases(set_number):
        base = case.visible if case.visible else case.context
        frame_free = not base
        row = {"step": case.step_number, "index": case.booklet_step, "parts": len(case.added), "base": len(base),
               "frame_free": frame_free}
        if case.rgb is None:
            row.update(status="no picture", exact=0, all_exact=False, features=[])
            rows.append(row)
            continue
        try:
            result = solve(lib, base, [(p, c) for p, c, _m in case.added], case.rgb, case.pts_per_px, collider=collider)
            scores = step_scores(lib, result.placed, case.added, frame_free=frame_free)
            from ..score import exact_flags
            from .evaluate import canonical, aligned
            placed = aligned(lib, result.placed, case.added)[0] if frame_free else canonical(lib, result.placed, case.added)
            flags = exact_flags(lib, placed, case.added) if placed else []
            row.update(status=result.status, **scores,
                       features=[{**part_features(sc, result), "part": p, "exact": bool(f)} for (p, _c, _m), sc, f in zip(result.placed, result.scores, flags)])
        except Exception as error:
            row.update(status=f"error: {type(error).__name__}: {error}"[:200], exact=0, all_exact=False, features=[],
                       trace=traceback.format_exc()[-800:])
        rows.append(row)
    out = {"set": set_number, "rows": rows, "seconds": time.time() - t0}
    out["summary"] = summarise([out])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1))
    return out


def summarise(results: list[dict]) -> dict:
    parts = sum(r["parts"] for res in results for r in res["rows"] if not r["frame_free"])
    exact = sum(r.get("exact", 0) for res in results for r in res["rows"] if not r["frame_free"])
    steps = [r for res in results for r in res["rows"] if not r["frame_free"]]
    return {"sets": len(results), "steps": len(steps), "parts": parts, "exact": exact,
            "part_accuracy": exact / parts if parts else None,
            "step_accuracy": (sum(r.get("all_exact", False) for r in steps) / len(steps)) if steps else None}


def family(set_number: str) -> str:
    """Technic sets are the 42xxx line; everything else here is studded (System / BrickHeadz)."""
    return "technic" if str(set_number).startswith("42") else "studded"


def parts_set(set_number: str, force: bool = False) -> dict:
    """Parts reading against the answer key: per step, does the read (part, colour) multiset match?"""
    from ..inventory_check import _plain, base_number
    from .dataset import cases, extract_of
    from .evaluate import same_part
    from .parts import element_index, read_parts

    path = OUT / "parts" / f"{set_number}.json"
    if path.exists() and not force:
        return json.loads(path.read_text())
    lib = _STATE["lib"]
    t0 = time.time()
    extract, folder = extract_of(set_number)
    steps, report = read_parts(lib, extract, folder, element_index())
    rows = []
    for case in cases(set_number, with_images=False):
        read = steps[case.booklet_step] if case.booklet_step < len(steps) else None
        pred = list(read.parts) if read else []
        truth = [(p, c) for p, c, _m in case.added]
        used, hit = [False] * len(pred), 0
        for tp, tc in truth:
            for i, (pp, pc) in enumerate(pred):
                if not used[i] and pc == tc and same_part(lib, pp, tp):
                    used[i] = True
                    hit += 1
                    break
        rows.append({"step": case.step_number, "truth": len(truth), "predicted": len(pred), "hit": hit,
                     "ok": hit == len(truth) == len(pred), "confidence": float(read.confidence) if read else 0.0})
    out = {"set": set_number, "rows": rows, "report": report, "seconds": time.time() - t0}
    out["summary"] = summarise_parts([out])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1, default=str))
    return out


def summarise_parts(results: list[dict]) -> dict:
    rows = [r for res in results for r in res["rows"]]
    truth, pred, hit = (sum(r[k] for r in rows) for k in ("truth", "predicted", "hit"))
    return {"sets": len(results), "steps": len(rows), "recall": hit / truth if truth else None,
            "precision": hit / pred if pred else None,
            "step_accuracy": sum(r["ok"] for r in rows) / len(rows) if rows else None}


def aggregate(mode: str, results: list[dict]) -> dict:
    by = {"all": results}
    for fam in ("studded", "technic"):
        by[fam] = [r for r in results if family(r["set"]) == fam]
    fn = {"teacher": summarise, "parts": summarise_parts, "freerun": summarise_freerun}[mode]
    return {k: fn(v) for k, v in by.items() if v}


def summarise_freerun(results: list[dict]) -> dict:
    ok = [r for r in results if "model" in r]
    if not ok:
        return {"sets": len(results)}
    parts = sum(r["model"]["parts"] for r in ok)
    exact = sum(r["model"]["exact"] for r in ok)
    return {"sets": len(results), "parts": parts, "exact": exact,
            "component_accuracy": exact / parts if parts else None,
            "model_accuracy": float(np.mean([r["model"]["model_accuracy"] for r in ok])),
            "mean_chamfer": float(np.mean([r["model"]["chamfer"] for r in ok if np.isfinite(r["model"]["chamfer"])] or [np.nan])),
            "step_accuracy_free": float(np.mean([r.get("step_accuracy", 0.0) for r in ok]))}


def mepnet_sets(dataset: str) -> list[str]:
    from .mepnet import sets
    return [f"{dataset}/{s}" for s in sets(dataset)]


def mepnet_teacher(item: str, force: bool = False) -> dict:
    """MEPNet component-wise / stepwise protocol: true model before each op and the new parts given."""
    from ..score import exact_flags
    from ..viewfit import BOOKLET_SCALE
    from . import mepnet
    from .evaluate import canonical
    from .register import rank_views
    from .step import solve

    dataset, name = item.split("/")
    path = OUT / "mepnet_teacher" / dataset / f"{name}.json"
    if path.exists() and not force:
        return json.loads(path.read_text())
    lib, collider = _STATE["lib"], _STATE["collider"]
    ops = mepnet.operations(dataset, name)
    t0 = time.time()
    rows = []
    px_per_ldu = mepnet.pixel_scale(lib, ops[0].parts, mepnet.load_rgb(ops[0].image)) if ops and ops[0].parts else None
    pts = BOOKLET_SCALE / px_per_ldu if px_per_ldu else None
    base = list(ops[0].parts) if ops else []
    for op in ops[1:]:
        singles = [p for p in op.parts] if not op.submodules else []
        row = {"step": op.index, "components": len(op.parts) + op.submodules if not op.submodules else None,
               "submodules": op.submodules, "frame_free": False}
        if op.submodules:
            # submodule ops are not attempted: each submodel reference and each loose part is a miss
            files = mepnet.parse_mpd((mepnet.DATA / f"{dataset}_lpub3d" / name / "model.ldr").read_text())
            root = next(iter(files))
            loose = sum(1 for r, _c, _m in files[root][op.index] if r not in files)
            row.update(parts=loose + op.submodules, exact=0, all_exact=False, status="submodule op", features=[])
        else:
            row["parts"] = len(singles)
            try:
                # MEPNet's camera is fixed within a set: read its orientation off the previous render,
                # which shows exactly the given model so far
                prev = rank_views(lib, base, mepnet.load_rgb(ops[op.index - 1].image), None, None, top=1)
                result = solve(lib, base, [(p, c) for p, c, _m in singles], mepnet.load_rgb(op.image), pts, collider=collider,
                               orientations=[prev[0][1]] if prev else None)
                placed = canonical(lib, result.placed, singles)
                flags = exact_flags(lib, placed, singles) if placed else []
                row.update(status=result.status, exact=int(sum(flags)), all_exact=bool(len(flags) == len(singles) and all(flags)),
                           features=[{**part_features(sc, result), "part": p, "exact": bool(f)} for (p, _c, _m), sc, f in zip(result.placed, result.scores, flags)])
            except Exception as error:
                row.update(status=f"error: {type(error).__name__}: {error}"[:200], exact=0, all_exact=False, features=[],
                           trace=traceback.format_exc()[-800:])
        rows.append(row)
        base = base + list(op.parts)
    out = {"set": item, "rows": rows, "px_per_ldu": px_per_ldu, "seconds": time.time() - t0}
    out["summary"] = summarise([out])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1))
    return out


def mepnet_summary(results: list[dict]) -> dict:
    return summarise(results)


def truth_model(set_number: str) -> list:
    """The answer key's whole model, every submodel expanded into the main model's frame."""
    from .dataset import pairs
    from .mepnet import flatten, parse_mpd
    files = parse_mpd(Path(pairs()[set_number].omr).read_text(errors="replace"))
    return flatten(files, next(iter(files)), np.eye(4))


def freerun_set(set_number: str, force: bool = False) -> dict:
    """Free-run from the PDF (extract, parts reading, step-by-step placement); answer key only scores."""
    from . import pipeline
    from .confidence import threshold
    from .dataset import extract_of, pairs
    from .evaluate import model_scores
    from .parts import element_index

    path = OUT / "freerun" / f"{set_number}.json"
    if path.exists() and not force:
        return json.loads(path.read_text())
    lib, collider = _STATE["lib"], _STATE["collider"]
    t0 = time.time()
    data, folder = extract_of(set_number)
    run = pipeline.run(lib, Path(pairs()[set_number].pdf), data, folder, element_index(), collider=collider)
    (OUT / "freerun").mkdir(parents=True, exist_ok=True)
    written = pipeline.write(run, OUT / "freerun" / f"{set_number}.mpd", set_number, threshold())
    truth = [(p, c, m) for p, c, m in truth_model(set_number)]
    model = run.model
    scores = model_scores(lib, model, truth)
    flags = scores.pop("flags")
    k, steps_ok, conf_rows = 0, [], []
    for group, confs in zip(run.groups, run.confidences):
        f = flags[k:k + len(group)]
        k += len(group)
        if group:
            steps_ok.append(all(f))
        conf_rows += [(float(c), bool(e)) for c, e in zip(confs, f)]
    out = {"set": set_number, "model": scores, "written": written, "incomplete_from": run.failed_from,
           "step_accuracy": float(np.mean(steps_ok)) if steps_ok else 0.0, "confidence": conf_rows,
           "parts_reading": run.parts_report, "rows": run.rows, "seconds": time.time() - t0}
    out["summary"] = {k2: scores[k2] for k2 in ("parts", "predicted", "exact", "component_accuracy")}
    path.write_text(json.dumps(out, indent=1, default=str))
    return out
