"""Reproducible foundation harness: run every stage, summarise, and check for regressions.

cd python && .venv/bin/python ../scripts/foundation_report.py            # run stages, report, compare with baseline
cd python && .venv/bin/python ../scripts/foundation_report.py --no-run   # report from cached stage outputs
cd python && .venv/bin/python ../scripts/foundation_report.py --update-baseline
cd python && .venv/bin/python ../scripts/foundation_report.py --verify-determinism
Exit status 1 when a metric regressed against benchmarks/booklet-mpd/foundation-baseline.json.
Stages: audit -> grade (A/B/C + visible IoU) -> mask gate. Part identity comes from cached Rebrickable results.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from booklet_mpd.report import build_report, regressions

OUT = ROOT / ".cache/booklet-mpd"
BASELINE = ROOT / "benchmarks/booklet-mpd/foundation-baseline.json"
STAGES = [["audit_booklet_corpus.py", "--split", "train,validation,test"], ["grade_sets.py"], ["mask_gate.py"]]


def run_stages():
    for stage in STAGES:
        print("running", stage[0], flush=True)
        subprocess.run([sys.executable, "-W", "ignore", str(ROOT / "scripts" / stage[0]), *stage[1:]], check=True,
                       stdout=subprocess.DEVNULL, cwd=ROOT / "python")


def write_markdown(report):
    lines = ["# Foundation report", "", f"Protocol hash: `{report['protocol_hash'][:16]}`", "",
             f"- usable sets (alignment ok): {report['audit_usable']}",
             f"- answer-key grades: {report['grade_counts']}",
             f"- booklet parts matching the OMR (exact or same part): {report['identity_matched_fraction']:.1%}",
             f"- mask gate pass rate: {{{', '.join(f'{k}: {v:.1%}' for k, v in report['mask_pass'].items())}}}",
             f"- median visible IoU, tuning sets: {report['tuning_median_iou']}",
             f"- median visible IoU, held-out sets: {report['heldout_median_iou']}"]
    (OUT / "foundation-report.md").write_text("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-run", action="store_true")
    ap.add_argument("--update-baseline", action="store_true")
    ap.add_argument("--verify-determinism", action="store_true")
    ap.add_argument("--baseline", type=Path, default=BASELINE)
    args = ap.parse_args()
    if not args.no_run:
        run_stages()
    report = build_report(OUT)
    text = json.dumps(report, indent=1, sort_keys=True)
    (OUT / "foundation-report.json").write_text(text)
    write_markdown(report)
    print(text)
    if args.verify_determinism:
        run_stages()
        again = json.dumps(build_report(OUT), indent=1, sort_keys=True)
        print("determinism:", "IDENTICAL" if again == text else "DIFFERENT")
        sys.exit(0 if again == text else 1)
    if args.update_baseline:
        args.baseline.write_text(text + "\n")
        print("baseline written to", args.baseline)
        return
    if not args.baseline.exists():
        print("no baseline yet; run with --update-baseline")
        return
    found = regressions(json.loads(args.baseline.read_text()), report)
    print("REGRESSIONS:" if found else "no regressions against the baseline")
    for item in found:
        print("  -", item)
    sys.exit(1 if found else 0)


if __name__ == "__main__":
    main()
