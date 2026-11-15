#!/usr/bin/env python3
"""Compares the native engine's audit rows with the web engine's baseline rows.

  python3 native/tools/compare_scoreboards.py .cache/native-baseline .cache/native-audit/full/rows.jsonl

Prints, for models both engines loaded: how many piece counts differ, and how the lists of
unknown parts differ.
"""
import glob
import json
import os
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    web_dir, native_rows = sys.argv[1], sys.argv[2]
    web = {}
    for path in glob.glob(os.path.join(web_dir, "**", "*.json"), recursive=True):
        try:
            row = json.load(open(path))
        except (OSError, ValueError):
            continue
        if isinstance(row, dict) and "id" in row:
            web[row["id"]] = row
    native = {}
    for line in open(native_rows):
        line = line.strip()
        if line:
            row = json.loads(line)
            native[row["id"]] = row

    both = [i for i in native if i in web and native[i]["ok"] and web[i].get("ok") and web[i].get("pieces") is not None]
    differ = [i for i in both if native[i]["pieces"] != web[i]["pieces"]]
    unknown_differ = [i for i in both if sorted(native[i]["unknownParts"]) != sorted(web[i].get("unknownParts") or [])]
    print(f"native rows {len(native)}, web rows {len(web)}, loaded by both {len(both)}")
    print(f"native failed {sum(1 for r in native.values() if not r['ok'])}, web failed {sum(1 for r in web.values() if not r.get('ok'))}")
    same = len(both) - len(differ)
    print(f"piece counts equal on {same}/{len(both)} ({100.0 * same / max(1, len(both)):.2f}%)")
    for i in sorted(differ)[:40]:
        print(f"  pieces differ  {i}: native {native[i]['pieces']}, web {web[i]['pieces']}")
    print(f"unknown-part lists differ on {len(unknown_differ)}")
    only_native, only_web = {}, {}
    for i in unknown_differ:
        n, w = set(native[i]["unknownParts"]), set(web[i].get("unknownParts") or [])
        for p in n - w:
            only_native[p] = only_native.get(p, 0) + 1
        for p in w - n:
            only_web[p] = only_web.get(p, 0) + 1
    for label, table in (("unknown only to native", only_native), ("unknown only to web", only_web)):
        top = sorted(table.items(), key=lambda kv: -kv[1])[:25]
        print(f"  {label}: {len(table)} parts" + ("" if not top else " — " + ", ".join(f"{p} ({n})" for p, n in top)))
    # Joints: largest connected group and fully joined models, per source, on shared models.
    joint = [i for i in both if "joined" in native[i] and web[i].get("joined") is not None]
    if joint:
        print("joints, on models both engines measured (largest group as a share of pieces):")
        sources = sorted({i.split("/")[0] for i in joint})
        for src in sources:
            ids = [i for i in joint if i.split("/")[0] == src]
            pieces = sum(native[i]["pieces"] for i in ids) or 1
            nj, wj = sum(native[i]["joined"] for i in ids), sum(web[i]["joined"] for i in ids)
            nf, wf = sum(native[i]["groups"] == 1 for i in ids), sum(web[i]["groups"] == 1 for i in ids)
            ng, wg = sum(native[i]["groups"] for i in ids), sum(web[i]["groups"] for i in ids)
            print(f"  {src:10} {len(ids):5} models  native {100.0 * nj / pieces:5.1f}%  web {100.0 * wj / pieces:5.1f}%"
                  f"   fully joined: native {nf}, web {wf}   groups: native {ng}, web {wg}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
