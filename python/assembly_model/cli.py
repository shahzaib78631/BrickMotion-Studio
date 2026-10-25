"""CLI: plan a model, train the ordering prior from traces.

    python -m assembly_model plan  --model ../tests/fixtures/models/10156-1.mpd --out plan.json
    python -m assembly_model plan  --model model.mpd --app-plan saved.plan.json --out artifact.json
    python -m assembly_model train --traces trace.jsonl --prior prior.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from .export import build_plan, write_plan
from .ldraw import load_library
from .model import load_model
from .prior import train_from_traces

DEFAULT_LIBRARY = os.path.join("..", "public", "ldraw")


def cmd_plan(args: argparse.Namespace) -> int:
    lib = load_library(args.library)
    model = load_model(args.model)
    from .assembly import build_assembly
    from .search import Options, plan

    asm = build_assembly(lib, model.pieces)
    result = plan(asm, Options(max_ms=args.max_ms, prior_path=args.prior, trace_path=args.trace))
    plan_json = build_plan(asm, result, model=args.model)
    if not args.no_timeline:
        from .choreo import build_animation

        plan_json.animation = build_animation(asm, result)
    if args.app_plan:
        with open(args.app_plan) as f:
            plan_json.app_plan = json.load(f)
    if args.out:
        write_plan(plan_json, args.out)
    print(json.dumps({"stats": result.stats, "out": args.out}))
    return 0


def cmd_train(args: argparse.Namespace) -> int:
    info = train_from_traces(args.traces, args.prior)
    print(json.dumps(info))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="assembly_model")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("plan")
    p.add_argument("--model", required=True)
    p.add_argument("--library", default=DEFAULT_LIBRARY)
    p.add_argument("--out", default=None)
    p.add_argument("--trace", default=None)
    p.add_argument("--prior", default=None)
    p.add_argument("--app-plan", default=None, dest="app_plan",
                   help="studio plan JSON (.plan.json) embedded into the artifact for the app")
    p.add_argument("--no-timeline", action="store_true", dest="no_timeline",
                   help="omit the authored animation block (certified corridors only)")
    p.add_argument("--max-ms", type=int, default=30_000)
    p.set_defaults(func=cmd_plan)

    t = sub.add_parser("train")
    t.add_argument("--traces", nargs="+", required=True)
    t.add_argument("--prior", required=True)
    t.set_defaults(func=cmd_train)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
