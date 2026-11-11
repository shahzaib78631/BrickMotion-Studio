"""Reconstruct an LDraw MPD from a LEGO instruction booklet PDF (no answer key).

    python -m booklet_mpd.solve BOOKLET.pdf --out OUT.mpd [--report OUT.json] [--max-steps N]

Parts are identified through the cached Rebrickable inventories (.cache/booklet-mpd/rebrickable);
with REBRICKABLE_API_KEY set, unknown element ids are looked up read-only (1 request/s, cached).
Uncertain parts are flagged in the MPD (`0 // BRICKMOTION FLAG`), and the MPD is marked
INCOMPLETE from the first step the solver gave up on.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m booklet_mpd.solve")
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--report", type=Path)
    ap.add_argument("--max-steps", type=int)
    ap.add_argument("--no-oracle", action="store_true", help="bounding-box collisions instead of the exact mesh oracle")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    from assembly_model.ldraw import load_library

    from .solver import confidence, pipeline
    from .solver.collide import Collider
    from .solver.parts import element_index

    lib = load_library(str(ROOT / "public/ldraw"))
    digest = hashlib.sha256(args.pdf.read_bytes()).hexdigest()[:16]
    data, folder = pipeline.extract(args.pdf, ROOT / ".cache/booklet-mpd/solver/extract" / digest)
    client = None
    try:
        from .solver.parts import rebrickable_client
        client = rebrickable_client()
    except Exception:
        client = None
    collider = Collider(lib, use_oracle=not args.no_oracle)
    log = None if args.quiet else (lambda row: print(json.dumps(row), file=sys.stderr, flush=True))
    try:
        result = pipeline.run(lib, args.pdf, data, folder, element_index(), collider=collider, client=client,
                              max_steps=args.max_steps, log=log)
    finally:
        collider.close()
    written = pipeline.write(result, args.out, args.out.stem, confidence.threshold())
    report = {"pdf": str(args.pdf), "steps": len(result.groups), "written": written,
              "incomplete_from_step": result.failed_from, "parts_reading": result.parts_report,
              "threshold": confidence.threshold(), "exact_collisions": collider.exact, "rows": result.rows}
    if args.report:
        args.report.write_text(json.dumps(report, indent=1, default=str))
    print(f"{args.out}: {written['parts']} parts in {len(result.groups)} steps, {written['flagged']} flagged"
          + (f", INCOMPLETE from step {result.failed_from}" if result.failed_from else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
