"""Local Studio instruction model builder: build CLI or browser upload/review UI."""
import argparse
import json
from pathlib import Path


def main(argv=None):
    parser=argparse.ArgumentParser(prog="studio_builder")
    sub=parser.add_subparsers(dest="command",required=True)
    build=sub.add_parser("build",help="Build an MPD from Studio PDFs or ordered page images")
    build.add_argument("inputs",nargs="*",type=Path)
    build.add_argument("--out",type=Path,required=True)
    build.add_argument("--observations",type=Path,help="Rebuild corrected observations.json in the same output folder")
    build.add_argument("--parts",help="Optional comma-separated candidate part IDs (no placement data)")
    build.add_argument("--catalog-limit",type=int,default=256,help="Common local parts to search; 0 scans the whole catalogue")
    build.add_argument("--max-steps",type=int)
    build.add_argument("--ldraw",type=Path)
    build.add_argument("--mesh-collision",action="store_true")
    serve=sub.add_parser("serve",help="Open the local upload, build and correction interface")
    serve.add_argument("--port",type=int,default=8791)
    args=parser.parse_args(argv)
    if args.command=="serve":
        from .server import serve
        serve(args.port)
        return 0
    if not args.inputs and not args.observations:
        parser.error("Supply a PDF, page images, or --observations")
    if args.catalog_limit<0 or (args.max_steps is not None and args.max_steps<1):
        parser.error("Catalogue limit must be nonnegative and max steps positive")
    from .build import run
    report=run(args.inputs,args.out,observations=args.observations,limit=args.catalog_limit,
               selected=args.parts.split(",") if args.parts else None,max_steps=args.max_steps,
               ldraw=args.ldraw,exact_collision=args.mesh_collision,
               log=lambda event:print(json.dumps(event),flush=True))
    # Distinguish stopped/incomplete output from a completed, review-required build.
    return 2 if report["status"]=="incomplete" else 0


if __name__=="__main__":
    raise SystemExit(main())
