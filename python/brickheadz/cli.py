"""CLI for the BrickHeadz dataset pipeline and generator.

    python -m brickheadz all    --corpus ../dist/ldraw_brickheadz --out ../.cache/brickheadz
    python -m brickheadz extract --model path/to/model.mpd        # one model, JSON to stdout
    python -m brickheadz report --records ../.cache/brickheadz/records.jsonl --out ../.cache/brickheadz
    python -m brickheadz generate --spec spec.json --out ../.cache/brickheadz/gen
    python -m brickheadz sample --count 20 --out ../.cache/brickheadz/gen
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys

from brickheadz.corpus import DEFAULT_CORPUS, discover
from brickheadz.dat import load_pieces
from brickheadz.dna import build_dna, load_catalog, load_color_names
from brickheadz.report import build_grammar, render_markdown, write_json
from brickheadz.schema import ModelRecord, write_jsonl
from brickheadz.semantics import analyze

DEFAULT_LIBRARY = os.path.join("..", "public", "ldraw")
DEFAULT_CATALOG = os.path.join("..", "public", "data", "catalog.json")
DEFAULT_GEN_OUT = os.path.join("..", ".cache", "brickheadz", "gen")
DEFAULT_RECORDS = os.path.join("..", ".cache", "brickheadz", "records.jsonl")
DEFAULT_PATTERNS = os.path.join("..", ".cache", "brickheadz", "patterns.json")
DEFAULT_LDCONFIG = os.path.join(DEFAULT_LIBRARY, "LDConfig.ldr")


def _record(lib, catalog, model, source: dict) -> ModelRecord:
    pieces = load_pieces(model)
    analysis = analyze(lib, pieces)
    dna = build_dna(analysis, pieces, catalog)
    return ModelRecord(
        id=source.get("set", ""),
        name=source.get("name", os.path.basename(model)),
        source=source,
        frame=analysis["frame"],
        bbox=analysis["bbox"],
        figures=analysis["figures"],
        pieces=analysis["pieces"],
        components=analysis["components"],
        connections=analysis["connections"],
        face=analysis["face"],
        dna=dna,
        warnings=analysis["warnings"],
    )


def _source(model, set_id="", name="", extra=None):
    h = hashlib.sha256(open(model, "rb").read()).hexdigest()
    src = {"file": model, "sha256": h, "set": set_id, "name": name}
    if extra:
        src.update(extra)
    return src


def cmd_extract(args) -> int:
    from assembly_model.ldraw import load_library

    lib = load_library(args.library)
    catalog = load_catalog(args.catalog)
    rec = _record(lib, catalog, args.model, _source(args.model, name=os.path.basename(args.model)))
    print(json.dumps(rec.to_json(), indent=1))
    return 0


def cmd_all(args) -> int:
    from assembly_model.ldraw import load_library

    lib = load_library(args.library)
    catalog = load_catalog(args.catalog)
    models = discover(args.corpus)
    os.makedirs(args.out, exist_ok=True)

    records: list[ModelRecord] = []
    failed: list[dict] = []
    for m in models:
        try:
            rec = _record(lib, catalog, m.path, {**m.source})
            records.append(rec)
        except Exception as exc:  # keep going; report the failure honestly
            failed.append({"id": m.id, "name": m.name, "error": f"{type(exc).__name__}: {exc}"})

    records_path = os.path.join(args.out, "records.jsonl")
    n = write_jsonl(records, records_path)

    grammar = build_grammar([r.to_json() for r in records], source=args.corpus)
    write_json(grammar, os.path.join(args.out, "grammar.json"))

    color_names = load_color_names(os.path.join(args.library, "LDConfig.ldr"))
    with open(os.path.join(args.out, "report.md"), "w") as f:
        f.write(render_markdown(grammar, color_names))

    summary = {
        "models": len(models),
        "records": n,
        "failed": failed,
        "coverage": grammar["coverage"],
        "records_path": records_path,
    }
    with open(os.path.join(args.out, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps(summary, indent=1))
    return 0


def cmd_report(args) -> int:
    from brickheadz.schema import read_jsonl

    records = read_jsonl(args.records)
    grammar = build_grammar(records, source=args.records)
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        write_json(grammar, os.path.join(args.out, "grammar.json"))
        with open(os.path.join(args.out, "report.md"), "w") as f:
            f.write(render_markdown(grammar))
        print(json.dumps(grammar["coverage"], indent=1))
    else:
        print(json.dumps(grammar, indent=1))
    return 0


def _load_spec(args):
    from brickheadz.spec import Spec, random_spec

    if args.spec:
        with open(args.spec) as f:
            spec = Spec(**json.load(f))
    else:
        spec = random_spec(random.Random(args.seed))
    if args.name:
        spec.name = args.name
    return spec


def _load_patterns(args):
    from brickheadz import patterns as patterns_mod

    path = getattr(args, "patterns", None) or DEFAULT_PATTERNS
    if not os.path.exists(path):
        raise SystemExit(f"pattern library not found: {path} (run `python -m brickheadz patterns`)")
    return patterns_mod.read(path)


def _load_inventory(args):
    if not getattr(args, "inventory", None):
        return None
    from brickheadz.inventory import load

    return load(args.inventory)


def _generate(lib, spec, pats=None, cast=False, face=False, rng=None, inv=None):
    from brickheadz.builder import build_figure
    from brickheadz.export import normalize
    from brickheadz.validate import validate

    if inv is not None:
        from brickheadz.constrained import build_constrained

        b, _ = build_constrained(lib, spec, inv, pats if cast else None, rng or random.Random(spec.seed))
    elif cast and pats:
        from brickheadz.recombine import build_recombined

        b = build_recombined(lib, spec, pats, rng or random.Random(spec.seed), use_hair=True, use_face=face)
    else:
        b = build_figure(lib, spec)
    model = normalize(b.model)
    return model, validate(model, b.cells, lib)


def cmd_patterns(args) -> int:
    from brickheadz import patterns as patterns_mod
    from brickheadz.schema import read_jsonl

    records = read_jsonl(args.records)
    pats = patterns_mod.extract(records)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    summary = patterns_mod.write(pats, args.out)
    print(json.dumps(summary, indent=1))
    return 0


def cmd_generate(args) -> int:
    from assembly_model.ldraw import load_library
    from brickheadz.export import to_mpd, write_plan

    lib = load_library(args.library)
    spec = _load_spec(args)
    pats = _load_patterns(args) if args.cast else None
    inv = _load_inventory(args)
    rng = random.Random(args.seed)
    model, report = _generate(lib, spec, pats, args.cast, args.face, rng, inv)
    if args.stdout:
        print(to_mpd(model, spec.name))
        return 0 if report["ok"] else 1
    os.makedirs(args.out, exist_ok=True)
    # The plan is the source of truth; the MPD is emitted from it by the studio
    # (validate-brickheadz --emit-mpd), so both use identical placement.
    write_plan(model, os.path.join(args.out, f"{spec.name}.plan.json"), spec.name)
    print(json.dumps({"name": spec.name, "pieces": report["pieces"], "ok": report["ok"], "problems": report["problems"], "spec": spec.to_dict()}, indent=1))
    return 0 if report["ok"] else 1


def cmd_sample(args) -> int:
    from assembly_model.ldraw import load_library
    from brickheadz.export import write_plan
    from brickheadz.spec import random_spec

    lib = load_library(args.library)
    pats = _load_patterns(args) if args.cast else None
    inv = _load_inventory(args)
    os.makedirs(args.out, exist_ok=True)
    rng = random.Random(args.seed)
    results = []
    ok = 0
    for i in range(args.count):
        spec = random_spec(rng, name=f"bh-{i:03d}")
        try:
            model, report = _generate(lib, spec, pats, args.cast, args.face, rng, inv)
        except Exception as exc:
            results.append({"name": spec.name, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
            continue
        if report["ok"]:
            ok += 1
            write_plan(model, os.path.join(args.out, f"{spec.name}.plan.json"), spec.name)
        results.append({"name": spec.name, "pieces": report["pieces"], "ok": report["ok"], "problems": report["problems"], "spec": spec.to_dict()})
    summary = {"count": args.count, "ok": ok, "rate": round(ok / args.count, 3) if args.count else 0.0, "cast": args.cast}
    with open(os.path.join(args.out, "sample.json"), "w") as f:
        json.dump({"summary": summary, "results": results}, f, indent=1)
    print(json.dumps(summary, indent=1))
    return 0


def cmd_repair(args) -> int:
    """Apply the mesh validator's findings: drop only the flagged pattern pieces."""
    with open(args.repairs) as f:
        repairs = json.load(f).get("repairs", {})
    changed = 0
    drop_total = 0
    for name, ids in repairs.items():
        path = os.path.join(args.dir, name)
        if not os.path.exists(path):
            continue
        with open(path) as f:
            plan = json.load(f)
        drop = set()
        for nid in ids:
            parts = nid.split(":")
            try:
                si, order = int(parts[-2]), int(parts[-1])
            except (ValueError, IndexError):
                continue
            steps = plan.get("steps", [])
            if si >= len(steps) or order >= len(steps[si]["pieces"]):
                continue
            role = (steps[si]["pieces"][order].get("assembly") or {}).get("role")
            if role in ("headwear", "generic"):  # only learned pattern pieces are expendable
                drop.add((si, order))
        if not drop:
            continue
        for si, step in enumerate(plan["steps"]):
            step["pieces"] = [it for o, it in enumerate(step["pieces"]) if (si, o) not in drop]
        plan["steps"] = [s for s in plan["steps"] if s["pieces"]]
        with open(path, "w") as f:
            json.dump(plan, f, indent=1)
        changed += 1
        drop_total += len(drop)
    print(json.dumps({"repaired": changed, "piecesDropped": drop_total, "models": len(repairs)}, indent=1))
    return 0


def _resolve_hints(args, inv, image):
    """Merge a hints file and, with --vision, a vision model's inference."""
    hints: dict = {}
    if getattr(args, "hints", None):
        with open(args.hints) as f:
            hints.update(json.load(f))
    if getattr(args, "vision", False):
        from brickheadz.dna import load_color_names
        from brickheadz.vision_hints import VisionError, infer_hints

        names = load_color_names(args.ldconfig)
        palette = [(c, names.get(c, str(c))) for c in sorted(inv.colors)]
        try:
            hints.update(infer_hints(image, palette, model=getattr(args, "vision_model", None)))
        except VisionError as exc:
            raise SystemExit(str(exc))
    return hints or None


def cmd_spec(args) -> int:
    """Derive a spec (colours + proportions) from a single front photo + inventory."""
    from brickheadz.image_spec import spec_from_image, write_spec
    from brickheadz.inventory import load

    inv = load(args.inventory)
    hints = _resolve_hints(args, inv, args.image)
    spec = spec_from_image(args.image, inv, args.ldconfig, hints)
    if args.name:
        spec.name = args.name
    data = write_spec(spec, args.out) if args.out else spec.to_dict()
    print(json.dumps(data, indent=1))
    return 0


def cmd_fit(args) -> int:
    """Photo + inventory -> best-matching certified model (render-and-match)."""
    from assembly_model.ldraw import load_library
    from brickheadz import patterns as patterns_mod
    from brickheadz.dna import load_catalog
    from brickheadz.export import normalize, write_plan
    from brickheadz.image_spec import spec_from_image
    from brickheadz.inventory import load
    from brickheadz.render_match import fit

    lib = load_library(args.library)
    inv = load(args.inventory)
    catalog = load_catalog(args.catalog)
    hints = _resolve_hints(args, inv, args.image)
    spec = spec_from_image(args.image, inv, args.ldconfig, hints)
    pats = patterns_mod.read(args.patterns) if (args.patterns and os.path.exists(args.patterns)) else None
    best, info = fit(lib, spec, inv, pats, args.image, args.ldconfig, catalog, random.Random(args.seed))
    if best is None:
        print(json.dumps({"ok": False, "error": "no candidate could be built"}))
        return 1
    cost, pattern, b, report = best
    model = normalize(b.model)
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        # The plan is the studio-consistent artifact; the MPD is emitted from it by
        # the mesh-certify step (exportLDraw), so both use the same placement.
        write_plan(model, os.path.join(args.out, f"{spec.name}.plan.json"), spec.name)
    print(json.dumps({"cost": round(cost, 4), "pattern": (pattern or {}).get("source"), "pieces": report["pieces"], "withinInventory": report["withinInventory"], "candidates": info["candidates"]}, indent=1))
    return 0


def cmd_video(args) -> int:
    """Video -> BrickHeadz: pick the best front frame, then build + certify downstream."""
    from assembly_model.ldraw import load_library
    from brickheadz import patterns as patterns_mod
    from brickheadz.dna import load_catalog, load_color_names
    from brickheadz.inventory import load
    from brickheadz.video import build_from_video
    from brickheadz.vision_hints import VisionError, infer_hints

    lib = load_library(args.library)
    inv = load(args.inventory)
    catalog = load_catalog(args.catalog)
    pats = patterns_mod.read(args.patterns) if (args.patterns and os.path.exists(args.patterns)) else None
    hints = None
    if args.hints:
        with open(args.hints) as f:
            hints = json.load(f)
    vision_fn = None
    if args.vision:
        names = load_color_names(args.ldconfig)
        palette = [(c, names.get(c, str(c))) for c in sorted(inv.colors)]

        def vision_fn(path):  # noqa: F811
            try:
                return infer_hints(path, palette, model=args.vision_model)
            except VisionError as exc:
                raise SystemExit(str(exc))

    report = build_from_video(
        lib, args.video, inv, args.ldconfig, pats, catalog, args.out,
        args.name or "FromVideo", args.frames, None, hints, vision_fn, args.seed,
    )
    report.pop("framesScored", None)
    print(json.dumps(report, indent=1))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="brickheadz")
    sub = parser.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("all", help="run the full pipeline over a corpus")
    a.add_argument("--corpus", default=DEFAULT_CORPUS)
    a.add_argument("--out", default=os.path.join("..", ".cache", "brickheadz"))
    a.add_argument("--library", default=DEFAULT_LIBRARY)
    a.add_argument("--catalog", default=DEFAULT_CATALOG)
    a.set_defaults(func=cmd_all)

    e = sub.add_parser("extract", help="analyse a single MPD to stdout")
    e.add_argument("--model", required=True)
    e.add_argument("--library", default=DEFAULT_LIBRARY)
    e.add_argument("--catalog", default=DEFAULT_CATALOG)
    e.set_defaults(func=cmd_extract)

    r = sub.add_parser("report", help="regenerate the grammar from records.jsonl")
    r.add_argument("--records", required=True)
    r.add_argument("--out", default=None)
    r.set_defaults(func=cmd_report)

    g = sub.add_parser("generate", help="generate one BrickHeadz (spec or random)")
    g.add_argument("--spec", default=None, help="JSON spec file; omit for a random character")
    g.add_argument("--seed", type=int, default=0)
    g.add_argument("--name", default=None)
    g.add_argument("--out", default=DEFAULT_GEN_OUT)
    g.add_argument("--library", default=DEFAULT_LIBRARY)
    g.add_argument("--stdout", action="store_true", help="print the MPD instead of writing files")
    g.add_argument("--cast", action="store_true", help="compose a learned headwear/hair pattern onto the figure")
    g.add_argument("--face", action="store_true", help="with --cast, also use a learned face pattern")
    g.add_argument("--patterns", default=None, help="pattern library JSON (default .cache/brickheadz/patterns.json)")
    g.add_argument("--inventory", default=None, help="parts list (Rebrickable JSON / part,color,qty) to build from")
    g.set_defaults(func=cmd_generate)

    s = sub.add_parser("sample", help="generate and validate a batch of random characters")
    s.add_argument("--count", type=int, default=20)
    s.add_argument("--seed", type=int, default=1)
    s.add_argument("--out", default=DEFAULT_GEN_OUT)
    s.add_argument("--library", default=DEFAULT_LIBRARY)
    s.add_argument("--cast", action="store_true", help="compose learned headwear/hair patterns")
    s.add_argument("--face", action="store_true", help="with --cast, also use learned face patterns")
    s.add_argument("--patterns", default=None)
    s.add_argument("--inventory", default=None, help="parts list to build from")
    s.set_defaults(func=cmd_sample)

    p = sub.add_parser("patterns", help="extract the headwear/hair pattern library from records.jsonl")
    p.add_argument("--records", default=DEFAULT_RECORDS)
    p.add_argument("--out", default=DEFAULT_PATTERNS)
    p.set_defaults(func=cmd_patterns)

    pv = sub.add_parser("repair", help="apply the mesh validator's findings (drop flagged pattern pieces)")
    pv.add_argument("--repairs", required=True, help="repairs JSON written by validate-brickheadz.ts --repairs")
    pv.add_argument("--dir", required=True, help="directory of .plan.json files to repair")
    pv.set_defaults(func=cmd_repair)

    sp = sub.add_parser("spec", help="derive a spec from one photo + inventory")
    sp.add_argument("--image", required=True)
    sp.add_argument("--inventory", required=True)
    sp.add_argument("--ldconfig", default=DEFAULT_LDCONFIG)
    sp.add_argument("--hints", default=None, help="JSON overrides (hair/eyes/head/…) from a vision pass")
    sp.add_argument("--vision", action="store_true", help="infer hair/face/prop/colours with a vision model (needs ANTHROPIC_API_KEY)")
    sp.add_argument("--vision-model", default=None, dest="vision_model")
    sp.add_argument("--name", default=None)
    sp.add_argument("--out", default=None)
    sp.set_defaults(func=cmd_spec)

    ft = sub.add_parser("fit", help="photo + inventory -> best-matching certified model")
    ft.add_argument("--image", required=True)
    ft.add_argument("--inventory", required=True)
    ft.add_argument("--ldconfig", default=DEFAULT_LDCONFIG)
    ft.add_argument("--patterns", default=DEFAULT_PATTERNS)
    ft.add_argument("--catalog", default=DEFAULT_CATALOG)
    ft.add_argument("--library", default=DEFAULT_LIBRARY)
    ft.add_argument("--hints", default=None)
    ft.add_argument("--vision", action="store_true", help="infer hints with a vision model")
    ft.add_argument("--vision-model", default=None, dest="vision_model")
    ft.add_argument("--out", default=None)
    ft.add_argument("--seed", type=int, default=0)
    ft.set_defaults(func=cmd_fit)

    vd = sub.add_parser("video", help="video -> best front frame -> certified model")
    vd.add_argument("--video", required=True)
    vd.add_argument("--inventory", required=True)
    vd.add_argument("--ldconfig", default=DEFAULT_LDCONFIG)
    vd.add_argument("--patterns", default=DEFAULT_PATTERNS)
    vd.add_argument("--catalog", default=DEFAULT_CATALOG)
    vd.add_argument("--library", default=DEFAULT_LIBRARY)
    vd.add_argument("--hints", default=None)
    vd.add_argument("--vision", action="store_true", help="infer hints from the chosen frame with a vision model")
    vd.add_argument("--vision-model", default=None, dest="vision_model")
    vd.add_argument("--frames", type=int, default=9, help="how many frames to sample")
    vd.add_argument("--name", default=None)
    vd.add_argument("--out", default=None)
    vd.add_argument("--seed", type=int, default=0)
    vd.set_defaults(func=cmd_video)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
