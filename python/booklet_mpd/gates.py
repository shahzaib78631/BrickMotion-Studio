"""Per-stage gates for the booklet -> model pipeline (docs/booklet-pipeline-gates.md).

Each gate is measured on its own, with the inputs it needs taken from the answer key, so a failure is
pinned to one stage:

  1 parts      per-step exact (part, colour) multiset, from the parts reader's saved results
  2 steps      answer-key steps that have a picture, and how many of those draw a sub-build alone
  3 camera     the solver's best registration of the COMPLETED answer-key model ("oracle camera"): p90
               distance from its rendered part edges to the page's ink, in the page's own pixels, and
               silhouette IoU (rendered model vs the picture's foreground)
  4a coverage  is the true pose among the candidates, per joint type (base = model before the step plus
               the step's other parts in place: the ceiling on placement)
  4b selection the step solved with the oracle camera held and the true parts given: parts exact

    python -m booklet_mpd.gates [--sets 40271 ...] [--gates 1,2,4a]
"""
from __future__ import annotations

import argparse
import json
import math
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from brickheadz.connectors import _frame, build_graph, catalog

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".cache/booklet-mpd/gates"
TEST_SETS = ["40271", "40350", "41488", "41605", "41620", "40348"]
ORDER = ["hinge", "bar/clip", "technic", "snot", "rotation", "stud", "uncatalogued", "none"]
VERTICAL = 0.95      # |cos| of a stud axis with the model's y to count as an ordinary (vertical) stud joint
LINE = 1.0           # LDU: joint points this close to a common line
AXIS = 0.98          # |cos| between joint axes


def _labels(part: str) -> dict:
    cat = catalog()
    return cat.labels.get((cat.stem(part) or "") + ".dat", {})


def _axial(part: str, m: np.ndarray) -> list[tuple]:
    """World bar/clip and hinge joints of a placed part: (family, sub, world 4x4, length)."""
    d, out = _labels(part), []
    for sub in ("bar", "clip"):
        for r in d.get("axle", {}).get(sub, []):
            out.append(("bar/clip", sub, m @ _frame(r), float(r[5]) if len(r) > 5 else 0.0))
    for t, v in d.get("hinge", {}).items():
        for gender, rows in v.items():
            for r in rows:
                out.append(("hinge" + t, gender, m @ _frame(r), 0.0))
    return out


def _coaxial(wa, wb, reach: float) -> bool:
    a, b = -wa[:3, 1], -wb[:3, 1]
    if abs(float(a @ b)) < AXIS:
        return False
    d = wa[:3, 3] - wb[:3, 3]
    s = float(d @ b)
    return float(np.linalg.norm(d - s * b)) <= LINE and abs(s) <= reach


def joint_types(lib, part: str, truth: np.ndarray, model: list) -> set[str]:
    """Kinds of joint between `part` at `truth` and `model` [(id, colour, 4x4)] in the answer key."""
    from .solver.technic import cylinder_snaps
    cat = catalog()
    truth = np.asarray(truth, float)
    out: set[str] = set()
    if cat.connectors(part) is None and not cylinder_snaps(lib, part):
        return {"uncatalogued"}
    names = [p for p, _c, _m in model] + [part]
    mats = [np.asarray(m, float) for *_x, m in model] + [truth]
    g = build_graph(names, [c for _p, c, _m in model] + [0], mats, cat)
    me = len(model)
    for e in g.edges:
        if me not in (e.a, e.b):
            continue
        if e.family == "clip":
            out.add("bar/clip")
            continue
        conn = cat.connectors(names[e.a])[e.a_conn]
        axis = (mats[e.a] @ conn.frame)[:3, 1]
        if abs(axis[1]) < VERTICAL:
            out.add("snot")
        elif abs(e.yaw % 90) > 0.5 and abs(e.yaw % 90 - 90) > 0.5:
            out.add("rotation")
        else:
            out.add("stud")
    mine = _axial(part, truth)
    if mine:
        for p, _c, m in model:
            for fa, sa, wa, la in mine:
                for fb, sb, wb, lb in _axial(p, np.asarray(m, float)):
                    if fa == fb and sa != sb and _coaxial(wa, wb, la + lb + 1.0 if fa == "bar/clip" else 1.0):
                        out.add("hinge" if fa.startswith("hinge") else "bar/clip")
    mine_t = cylinder_snaps(lib, part)
    if mine_t:
        R, t = truth[:3, :3], truth[:3, 3]
        for p, _c, m in model:
            m = np.asarray(m, float)
            for gb, pb, ab, _x in cylinder_snaps(lib, p):
                wb_p, wb_a = m[:3, :3] @ pb + m[:3, 3], m[:3, :3] @ ab
                for ga, pa, aa, _y in mine_t:
                    if ga == gb:
                        continue
                    wa_p, wa_a = R @ pa + t, R @ aa
                    if abs(float(wa_a @ wb_a)) < AXIS:
                        continue
                    d = wa_p - wb_p
                    if np.linalg.norm(d - float(d @ wb_a) * wb_a) <= LINE and abs(float(d @ wb_a)) <= 60:
                        out.add("technic")
    return out or {"none"}


def primary(types: set[str]) -> str:
    return min(types, key=ORDER.index)


# ---------------------------------------------------------------- gates


def gate_parts(sets: list[str]) -> dict:
    """Gate 1 from the parts reader's saved per-set results (bench.parts_set)."""
    from .solver.bench import OUT as BENCH
    rows = {}
    for s in sets:
        f = BENCH / "parts" / f"{s}.json"
        if not f.exists():
            rows[s] = None
            continue
        r = json.loads(f.read_text())["summary"]
        rows[s] = {"steps": r["steps"], "step_exact": r["step_accuracy"], "recall": r["recall"], "precision": r["precision"]}
    have = [r for r in rows.values() if r and r["steps"]]
    steps = sum(r["steps"] for r in have)
    exact = sum(r["step_exact"] * r["steps"] for r in have)
    return {"sets": rows, "steps": steps, "step_exact": exact / steps if steps else None, "pass": 0.98}


def gate_steps(sets: list[str]) -> dict:
    """Gate 2 (what can be measured now): answer-key steps with a picture, and sub-build pictures."""
    from .solver.dataset import cases
    rows = {}
    for s in sets:
        cs = list(cases(s))
        rows[s] = {"steps": len(cs), "with_picture": sum(c.rgb is not None for c in cs),
                   "sub_build_drawn_alone": sum(bool(c.context) and not c.visible for c in cs),
                   "sub_build_panels": sum(bool(c.subbuilds) for c in cs)}
    return {"sets": rows}


def gate_coverage(lib, sets: list[str]) -> dict:
    """Gate 4a: true pose among the candidates, by primary joint type (and by every type a part has)."""
    from .solver.coverage import covered
    from .solver.dataset import cases
    by_primary, by_any, misses = defaultdict(Counter), defaultdict(Counter), []
    per_set = {}
    for s in sets:
        n = hit = 0
        for case in cases(s, with_images=False):
            base = case.visible if case.visible else []
            for k, (p, c, m) in enumerate(case.added):
                model = base + [x for j, x in enumerate(case.added) if j != k]
                if not model:
                    continue
                types = joint_types(lib, p, m, model)
                ok = covered(lib, p, c, m, model)
                n += 1
                hit += ok
                by_primary[primary(types)][ok] += 1
                for t in types:
                    by_any[t][ok] += 1
                if not ok:
                    misses.append({"set": s, "step": case.step_number, "part": p, "types": sorted(types)})
        per_set[s] = {"parts": n, "covered": hit}
        print(s, f"covered {hit}/{n}", flush=True)

    def table(d):
        return {t: {"parts": d[t][True] + d[t][False], "covered": d[t][True],
                    "share": d[t][True] / max(1, d[t][True] + d[t][False])} for t in ORDER if t in d}
    return {"sets": per_set, "primary": table(by_primary), "any": table(by_any), "misses": misses, "pass": 0.99}


def _edges(label: np.ndarray) -> np.ndarray:
    e = np.zeros(label.shape, bool)
    e[:, 1:] |= label[:, 1:] != label[:, :-1]
    e[1:, :] |= label[1:, :] != label[:-1, :]
    return e


def camera_and_selection(set_number: str, select: bool = True) -> dict:
    """Gates 3 and 4b for one set (one process; slow: a registration and a solve per step)."""
    from assembly_model.ldraw import load_library
    from .score import exact_flags
    from .solver.collide import Collider
    from .solver.dataset import cases
    from .solver.edges import ink_distance
    from .solver.evaluate import canonical
    from .solver.picture import Picture
    from .solver.render import render
    from .solver.step import solve
    from .viewfit import BOOKLET_SCALE
    lib = load_library(str(ROOT / "public/ldraw"))
    collider = Collider(lib, use_oracle=True)
    rows = []
    all_cases = list(cases(set_number))
    for ci, case in enumerate(all_cases):
        base = case.visible if case.visible else []
        prev_c = all_cases[ci - 1] if ci > 0 and all_cases[ci - 1].file == case.file and all_cases[ci - 1].step_number == case.step_number - 1 else None
        next_c = all_cases[ci + 1] if ci + 1 < len(all_cases) and all_cases[ci + 1].file == case.file and all_cases[ci + 1].step_number == case.step_number + 1 else None
        row = {"step": case.step_number, "parts": len(case.added), "base": len(base)}
        if case.rgb is None or not base:
            row["skip"] = "no picture" if case.rgb is None else "no base (frame free)"
            rows.append(row)
            continue
        t0 = time.time()
        try:
            full = base + list(case.added)
            oracle = solve(lib, full, [], case.rgb, case.pts_per_px, collider=collider)
            pic = Picture.from_rgb(case.rgb, case.pts_per_px,
                                   BOOKLET_SCALE / case.pts_per_px if case.pts_per_px else None)
            _d, label = render(lib, full, oracle.view, pic.rgb.shape[:2])
            edge = _edges(label) & (label >= 0) | _edges(label >= 0)
            dist = ink_distance(pic.rgb)[edge] / pic.factor
            mask = label >= 0
            row.update(line_p90=float(np.percentile(dist, 90)) if dist.size else None,
                       line_median=float(np.median(dist)) if dist.size else None,
                       iou=float((mask & pic.foreground).sum() / max(1, (mask | pic.foreground).sum())),
                       camera_sec=round(time.time() - t0, 1))
            if select:
                t1 = time.time()
                r = solve(lib, base, [(p, c) for p, c, _m in case.added], case.rgb, case.pts_per_px,
                          collider=collider, subbuilds=case.subbuilds,
                          camera=(oracle.view, oracle.orientation_index, -1e9),
                          prev_rgb=prev_c.rgb if prev_c is not None else None,
                          prev_pts=prev_c.pts_per_px if prev_c is not None else None,
                          next_rgb=next_c.rgb if next_c is not None else None,
                          next_pts=next_c.pts_per_px if next_c is not None else None)
                placed = canonical(lib, r.placed, case.added)
                flags = exact_flags(lib, placed, case.added, atol=0.1) if placed else []
                row.update(exact=int(sum(flags)), all_exact=bool(len(flags) == len(case.added) and all(flags)),
                           status=r.status, select_sec=round(time.time() - t1, 1))
        except Exception as e:
            row["error"] = f"{type(e).__name__}: {e}"[:200]
        rows.append(row)
        print(set_number, json.dumps(row), flush=True)
    return {"set": set_number, "rows": rows}


def summarise_camera_selection(results: list[dict]) -> dict:
    rows = [r for res in results for r in res["rows"] if "skip" not in r and "error" not in r]
    p90 = [r["line_p90"] for r in rows if r.get("line_p90") is not None]
    sel = [r for r in rows if "exact" in r]
    parts = sum(r["parts"] for r in sel)
    return {"steps": len(rows), "errors": sum("error" in r for res in results for r in res["rows"]),
            "skipped": sum("skip" in r for res in results for r in res["rows"]),
            "camera_pass_share": sum(x <= 1.5 for x in p90) / max(1, len(p90)),
            "line_p90_median": float(np.median(p90)) if p90 else None,
            "iou_median": float(np.median([r["iou"] for r in rows])) if rows else None,
            "parts": parts, "parts_exact": sum(r["exact"] for r in sel) / max(1, parts),
            "steps_all_exact": sum(r["all_exact"] for r in sel) / max(1, len(sel)),
            "pass": {"camera": "p90 <= 1.5 px on >= 95% of steps", "selection": ">= 95% parts exact"}}


def one_move_check(score, base: list, truth: list, alternatives: dict) -> dict:
    """Gate 4s for one step. `score(model)`: the whole-model score; `truth`: the new parts at their true poses;
    `alternatives[i]`: other poses for new part i. Per part: how many single moves (part i to one alternative,
    the rest kept true) score higher than the true layout, and the best such margin."""
    s0 = score(base + truth)
    beaten, margin = [], []
    for i, (part, colour, m_true) in enumerate(truth):
        best, count = -np.inf, 0
        for m in alternatives.get(i, []):
            if np.allclose(m, m_true, atol=0.1):
                continue
            moved = list(truth)
            moved[i] = (part, colour, m)
            gap = score(base + moved) - s0
            best = max(best, gap)
            count += gap > 1e-9
        beaten.append(count)
        margin.append(float(best) if np.isfinite(best) else None)
    return {"truth": float(s0), "beaten": beaten, "margin": margin, "truth_best": not any(beaten)}


SCORE_K = 16       # alternatives per part (the per-part ranking's best), gate 4s


def score_oracle(set_number: str, scorer=None) -> dict:
    """Gate 4s for one set: steps drawn in place, oracle camera, the completed-model score of the solver.
    `scorer(lib, model, classes, codes, on_ink, view) -> float` replaces that score (to try another)."""
    from assembly_model.ldraw import load_library
    from .solver.candidates import candidates
    from .solver.collide import Collider
    from .solver.dataset import cases
    from .solver.edges import NEAR_INK, ink_distance
    from .solver.exact_place import score_candidates_calibrated
    from .solver.picture import Picture
    from .solver.place import distinct
    from .solver.scorer import ModelScorer
    from .solver.step import MIN_ARROW_PIXELS, solve
    from .viewfit import BOOKLET_SCALE
    lib = load_library(str(ROOT / "public/ldraw"))
    collider = Collider(lib, use_oracle=True)
    rows = []
    all_cases = list(cases(set_number))
    for ci, case in enumerate(all_cases):
        base = case.visible if case.visible else []
        prev_c = all_cases[ci - 1] if ci > 0 and all_cases[ci - 1].file == case.file else None
        row = {"step": case.step_number, "parts": len(case.added)}
        if case.rgb is None or not base or not case.added:
            continue
        try:
            full = base + list(case.added)
            pic = Picture.from_rgb(case.rgb, case.pts_per_px, BOOKLET_SCALE / case.pts_per_px if case.pts_per_px else None)
            if int(pic.arrows.sum()) >= MIN_ARROW_PIXELS or case.subbuilds:
                continue                                    # drawn apart: the true layout is not what is drawn
            oracle = solve(lib, full, [], case.rgb, case.pts_per_px, collider=collider)
            codes = sorted({c for _p, c, _m in full})
            classes = pic.classes(codes)
            ink = ink_distance(pic.rgb)
            on_ink = ink <= NEAR_INK
            view = oracle.view
            ms = ModelScorer(lib, list(base), pic, view, codes,
                             prev_rgb=prev_c.rgb if prev_c is not None else None,
                             prev_pts=prev_c.pts_per_px if prev_c is not None else None)
            if scorer is None:
                score = lambda model: float(ms.score(model[len(base):]))
            else:
                score = lambda model: float(scorer(lib, model, classes, codes, on_ink, view))
            collider.set_model(list(base))
            alternatives = {}
            for i, (part, colour, _m) in enumerate(case.added):
                extra_o = [x for k, x in enumerate(case.added) if k != i]
                others = list(base) + extra_o
                cands = distinct(lib, part, candidates(lib, part, others))
                cands = [q for q in cands if not collider.hits_extra(part, q["matrix"], extra_o)]
                scored = sorted(score_candidates_calibrated(lib, ms, extra_o, part, colour, cands, deltas=(0.0,)) if cands else [],
                                key=lambda sc: -sc.score)
                alternatives[i] = [np.asarray(sc.candidate["matrix"], float) for sc in scored[:SCORE_K]]
            row.update(one_move_check(score, base, list(case.added), alternatives))
        except Exception as e:
            row["error"] = f"{type(e).__name__}: {e}"[:200]
        rows.append(row)
        print(set_number, json.dumps(row, default=float), flush=True)
    return {"set": set_number, "rows": rows}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sets", nargs="*", default=TEST_SETS)
    ap.add_argument("--gates", default="1,2,4a")
    a = ap.parse_args(argv)
    want = a.gates.split(",")
    out = {"sets": a.sets, "when": time.strftime("%Y-%m-%d %H:%M")}
    if "1" in want:
        out["1"] = gate_parts(a.sets)
    if "2" in want:
        out["2"] = gate_steps(a.sets)
    if "3" in want or "4b" in want:
        from concurrent.futures import ProcessPoolExecutor
        with ProcessPoolExecutor(max_workers=min(6, len(a.sets))) as ex:
            res = list(ex.map(camera_and_selection, a.sets, [("4b" in want)] * len(a.sets)))
        out["3+4b"] = {"summary": summarise_camera_selection(res), "sets": res}
    if "4a" in want:
        from assembly_model.ldraw import load_library
        out["4a"] = gate_coverage(load_library(str(ROOT / "public/ldraw")), a.sets)
    if "4s" in want:
        from concurrent.futures import ProcessPoolExecutor
        with ProcessPoolExecutor(max_workers=min(6, len(a.sets))) as ex:
            res = list(ex.map(score_oracle, a.sets))
        rows_4s = [r for s in res for r in s["rows"] if "error" not in r and "truth_best" in r]
        p_tot = sum(r["parts"] for r in rows_4s)
        p_ok = sum(sum(b == 0 for b in r["beaten"]) for r in rows_4s)
        out["4s"] = {
            "summary": {
                "steps": len(rows_4s),
                "steps_truth_best": sum(r["truth_best"] for r in rows_4s),
                "step_share": sum(r["truth_best"] for r in rows_4s) / max(1, len(rows_4s)),
                "parts": p_tot,
                "parts_truth_best": p_ok,
                "part_share": p_ok / max(1, p_tot),
            },
            "sets": res,
        }
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"gates-{'-'.join(want)}.json"
    path.write_text(json.dumps(out, indent=1, default=float))
    short = {k: v for k, v in out.items() if k not in ("4a", "3+4b", "4s")}
    if "4a" in out:
        short["4a"] = {k: out["4a"][k] for k in ("sets", "primary", "any")}
    if "3+4b" in out:
        short["3+4b"] = out["3+4b"]["summary"]
    if "4s" in out:
        short["4s"] = out["4s"]["summary"]
    print(json.dumps(short, indent=1, default=float))
    print("saved", path)


if __name__ == "__main__":
    main()
