"""Resolve booklet/OMR part mismatches exactly against Rebrickable's official inventory.

cd python && REBRICKABLE_API_KEY=... .venv/bin/python ../scripts/verify_part_identity_api.py [--all]
By default only sets whose offline count signature differed are looked up. Only set and
element numbers are sent; the key travels only in the Authorization header.
"""
import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from assembly_model.ldraw import load_library
from booklet_mpd.audit import TRUTH_LOADERS
from booklet_mpd.inventory_check import (Rebrickable, alias_map, booklet_counter, compare, official_counter,
                                         omr_counter, reconcile, remap, colour_aliases,
                                         geometry_equivalent, remap_colours)
from booklet_mpd.pairing import find_pairs

OMR = Path("/Users/mac/Projects/BrickMotion-Data/omr/models")
SOURCES = ROOT / "benchmarks/instructions/arrow-catalog-100-sources.json"
OUT = ROOT / ".cache/booklet-mpd"


def label(parts, key):
    for p in parts:
        if (p["ldrawPart"].lower(), p["color"]) == key:
            return f"{p['part']} {p['colorName']}"
    return f"{key[0]} colour {key[1]}"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    sig = {r["set"]: r for r in json.loads((OUT / "part-identity-signature.json").read_text())}
    wanted = {s for s, r in sig.items() if r["status"] == "checked" and (args.all or not r["same_signature"])}
    rb = Rebrickable(os.environ.get("REBRICKABLE_API_KEY", ""), OUT / "rebrickable")
    pairs, _ = find_pairs(SOURCES, OMR, ROOT)
    lib = load_library(str(ROOT / "public/ldraw"))
    shades = colour_aliases(ROOT / "public/ldraw/LDConfig.ldr")
    results = []
    for pair in pairs:
        if pair.set_number not in wanted:
            continue
        parts = rb.set_parts(f"{pair.set_number}-1")
        official = official_counter(parts)
        aliases = alias_map(parts)
        truth = TRUTH_LOADERS["expand"](str(pair.omr), warnings=[])
        omr, remapped = remap(omr_counter(truth), aliases)
        inventory = json.loads((OUT / "extract" / f"{pair.set_number}-{pair.booklet}" / "extract.json").read_text())["inventory"]
        booklet, unresolved = booklet_counter(inventory, parts, rb.element)
        omr, booklet = remap_colours(omr, shades), remap_colours(booklet, shades)
        direct = compare(booklet, omr)
        def related(a, b):
            if geometry_equivalent(lib, a, b):
                return "geometry"
            return "alternate" if b in rb.related_parts(a) or a in rb.related_parts(b) else None
        rec = reconcile(direct["only_a"], direct["only_b"], related)
        row = {"set": pair.set_number, "reconcile": {"pairs": rec["pairs"], "reconciled": rec["reconciled"],
                                                      "residual_booklet": [[f"{k[0]} c{k[1]}", n] for k, n in rec["residual_a"].items()],
                                                      "residual_omr": [[f"{k[0]} c{k[1]}", n] for k, n in rec["residual_b"].items()]}, "official_total": sum(official.values()), "remapped_omr_parts": remapped,
               "unresolved_elements": unresolved}
        for name, (a, b) in {"omr_vs_official": (omr, official), "booklet_vs_official": (booklet, official),
                             "booklet_vs_omr": (booklet, omr)}.items():
            c = compare(a, b)
            row[name] = {k: c[k] for k in ("exact", "total_a", "total_b", "a_covered", "b_covered")}
            row[name]["only_a"] = [[label(parts, k), n] for k, n in sorted(c["only_a"].items(), key=lambda kv: -kv[1])[:6]]
            row[name]["only_b"] = [[label(parts, k), n] for k, n in sorted(c["only_b"].items(), key=lambda kv: -kv[1])[:6]]
        results.append(row)
        pct = lambda v: "n/a" if v is None else f"{v:.1%}"
        b = row["booklet_vs_omr"]
        matched = b["exact"] + rec["reconciled"]
        print(f"{pair.set_number}: booklet {b['total_a']} vs OMR {b['total_b']} | exact {b['exact']} + same-part-other-id {rec['reconciled']} "
              f"= {matched} ({pct(matched / b['total_a'] if b['total_a'] else None)} of booklet) | residual booklet {sum(rec['residual_a'].values())} "
              f"OMR {sum(rec['residual_b'].values())} | unresolved elements {len(unresolved)}", flush=True)
    lines = ["# Part identity: booklet parts list vs OMR (Rebrickable resolves element ids)", "",
             "| set | booklet | OMR | exact | same part, other id | residual booklet / OMR | unresolved |", "|---|---|---|---|---|---|---|"]
    for r in results:
        b = r["booklet_vs_omr"]
        rc = r["reconcile"]
        lines.append(f"| {r['set']} | {b['total_a']} | {b['total_b']} | {b['exact']} | {rc['reconciled']} | "
                     f"{sum(n for _k, n in rc['residual_booklet'])} / {sum(n for _k, n in rc['residual_omr'])} | {len(r['unresolved_elements'])} |")
    (OUT / "part-identity-report.md").write_text("\n".join(lines) + "\n")
    (OUT / "part-identity-api.json").write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    main()
