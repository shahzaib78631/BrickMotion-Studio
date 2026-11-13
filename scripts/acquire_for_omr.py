"""Acquire official booklets for sets that already have an OMR model (so every download is a usable pair).

cd python && .venv/bin/python ../scripts/acquire_for_omr.py --target 70
Reuses acquire() from acquire_instruction_catalog.py: the PDF link is read from the set's official LEGO
instructions page (never guessed), one PDF per set, size/page limits, hashes recorded.
Candidates: OMR sets released 2017-2023 with a numeric set number, not already in a manifest, in a fixed
pseudo-random (hash) order so the selection does not depend on theme or number range.
"""
import argparse
import concurrent.futures
import csv
import hashlib
import importlib.util
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from booklet_mpd.pairing import split_of

spec = importlib.util.spec_from_file_location("acq", ROOT / "scripts/acquire_instruction_catalog.py")
acq = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acq)

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr")
MANIFESTS = [ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json", ROOT / "benchmarks/booklet-mpd/catalog-omr-sources.json"]


def candidates():
    known = set()
    for m in MANIFESTS:
        if m.exists():
            known |= {r["set"] for r in json.loads(m.read_text())["booklets"]}
    rows = []
    for r in csv.DictReader(open(OMR / "sets.csv")):
        num = r["set_num"]
        if not num.endswith("-1") or not num[:-2].isdigit() or not (2017 <= int(r["year"] or 0) <= 2023):
            continue
        number = num[:-2]
        if number in known or number in map(str, acq.EXCLUDE) or not (OMR / "models" / num).is_dir():
            continue
        rows.append(number)
    return sorted(rows, key=lambda n: hashlib.sha256(n.encode()).hexdigest())


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--target", type=int, default=70)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--max-candidates", type=int, default=400)
    ap.add_argument("--max-mb", type=int, default=40)
    args = ap.parse_args()
    out = ROOT / ".cache/instructions/omr-catalog"
    out.mkdir(parents=True, exist_ok=True)
    manifest = ROOT / "benchmarks/booklet-mpd/catalog-omr-sources.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(manifest.read_text()) if manifest.exists() else {"version": 1, "booklets": [], "errors": []}
    rows, errors = data["booklets"], data["errors"]
    seen = {r["sha256"] for r in rows}
    items = [("OMR", int(n)) for n in candidates()[: args.max_candidates]]
    started, cursor = time.time(), 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        while len(rows) < args.target and cursor < len(items):
            batch = items[cursor: cursor + args.workers]
            cursor += len(batch)
            for r in pool.map(lambda item: acq.acquire(item, out, args.max_mb, 180), batch):
                if "error" in r:
                    errors.append(r)
                    print(json.dumps({"skip": r["set"], "why": r["error"][:60]}), flush=True)
                    continue
                if r["sha256"] in seen:
                    errors.append({"set": r["set"], "error": "duplicate PDF hash"})
                    continue
                r["split"] = split_of(r["set"])
                rows.append(r)
                seen.add(r["sha256"])
                print(json.dumps({"downloaded": len(rows), "set": r["set"], "pages": r["pages"], "mb": round(r["bytes"] / 1e6, 1),
                                  "seconds": round(time.time() - started)}), flush=True)
            manifest.write_text(json.dumps({"version": 1, "policy": "Official PDF per set that already has an OMR model; split by set-number hash.",
                                            "booklets": rows, "errors": errors}, indent=1))
            time.sleep(1.0)
    print(json.dumps({"pairs": len(rows), "errors": len(errors), "candidatesTried": cursor}), flush=True)


if __name__ == "__main__":
    main()
