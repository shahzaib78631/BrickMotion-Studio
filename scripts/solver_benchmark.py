"""Solver benchmark: teacher-forced and free-run accuracy on booklets and on the MEPNet datasets.

cd python && .venv/bin/python ../scripts/solver_benchmark.py teacher --split tuning     # train sets only
cd python && .venv/bin/python ../scripts/solver_benchmark.py parts --split tuning
cd python && .venv/bin/python ../scripts/solver_benchmark.py freerun --split tuning
cd python && .venv/bin/python ../scripts/solver_benchmark.py mepnet --dataset classics --mode teacher
cd python && .venv/bin/python ../scripts/solver_benchmark.py report                    # print everything cached

Splits follow booklet_mpd.protocol: `tuning` = train sets eligible for tuning (assert_tuning_allowed is
called for each), `validation` / `test` = held-out sets (reported once, never tuned on). Results are
cached per set under .cache/booklet-mpd/solver/<mode>/ (pass --force to recompute). The solver is
deterministic (no random sampling), so reruns give identical numbers.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from booklet_mpd.protocol import assert_tuning_allowed, heldout_sets, tuning_sets  # noqa: E402
from booklet_mpd.solver import bench  # noqa: E402
from booklet_mpd.solver.dataset import grades  # noqa: E402


def sets_for(split: str, family: str | None) -> list[str]:
    g = grades()
    if split == "tuning":
        out = tuning_sets(g)
        for s in out:
            assert_tuning_allowed(s, g)
    else:
        out = heldout_sets(g, split)
    grade = {r["set"]: r["grade"] for r in g}
    out = [s for s in out if family is None or bench.family(s) == family]
    return sorted(out, key=lambda s: (grade[s], s))


def run_pool(fn, items, workers: int, force: bool):
    results = []
    with concurrent.futures.ProcessPoolExecutor(max_workers=workers, initializer=bench.init_worker) as pool:
        futures = {pool.submit(fn, item, force): item for item in items}
        for done in concurrent.futures.as_completed(futures):
            r = done.result()
            results.append(r)
            print(f"  {r.get('set')}: {json.dumps(r.get('summary', {}))}", flush=True)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["teacher", "parts", "freerun", "mepnet", "report"])
    ap.add_argument("--split", default="tuning", choices=["tuning", "validation", "test"])
    ap.add_argument("--family", default=None, choices=[None, "studded", "technic"])
    ap.add_argument("--sets", nargs="*")
    ap.add_argument("--dataset", default="classics")
    ap.add_argument("--mepnet-mode", default="teacher", choices=["teacher", "freerun"])
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    if args.mode == "report":
        print(bench.report_text())
        return
    if args.mode == "mepnet":
        items = bench.mepnet_sets(args.dataset)
        fn = bench.mepnet_teacher if args.mepnet_mode == "teacher" else bench.mepnet_freerun
        results = run_pool(fn, items, args.workers, args.force)
        print(json.dumps(bench.mepnet_summary(results), indent=1))
        return
    sets = args.sets or sets_for(args.split, args.family)
    if args.sets and args.split == "tuning":
        for s in sets:
            assert_tuning_allowed(s, grades())
    fn = getattr(bench, {"teacher": "teacher_set", "parts": "parts_set", "freerun": "freerun_set"}[args.mode])
    print(f"{args.mode} on {len(sets)} {args.split} sets: {' '.join(sets)}", flush=True)
    results = run_pool(fn, sets, args.workers, args.force)
    print(json.dumps(bench.aggregate(args.mode, results), indent=1))


if __name__ == "__main__":
    main()
