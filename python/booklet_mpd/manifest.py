"""Merge booklet source manifests into the single list the pipeline reads."""
from __future__ import annotations

import json
from pathlib import Path


def merge_manifests(paths) -> dict:
    """One entry per set (first manifest wins); manifests that do not exist yet are skipped."""
    booklets, seen = [], set()
    for path in map(Path, paths):
        if not path.exists():
            continue
        for row in json.loads(path.read_text())["booklets"]:
            if row["set"] not in seen:
                seen.add(row["set"])
                booklets.append(row)
    return {"version": 1, "booklets": booklets}
