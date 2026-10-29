"""CLI: python -m instructions_pdf extract <pdf> <out_dir> | match <work_dir>"""
import argparse
import json
import sys


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="instructions_pdf")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("extract", help="split a booklet PDF into steps, callout parts and inventory")
    ex.add_argument("pdf")
    ex.add_argument("out_dir")
    ma = sub.add_parser("match", help="match callout parts to inventory elements")
    ma.add_argument("work_dir")
    args = ap.parse_args(argv)
    if args.cmd == "extract":
        from .extract import extract_booklet
        b = extract_booklet(args.pdf, args.out_dir)
        print(json.dumps({"id": b["id"], "steps": len(b["steps"]), "inventory": len(b["inventory"])}))
        return 0
    from .match import match_work_dir
    m = match_work_dir(args.work_dir)
    print(json.dumps({"matches": len(m["matches"]), "unmatched": sum(1 for x in m["matches"] if x["element"] is None)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
