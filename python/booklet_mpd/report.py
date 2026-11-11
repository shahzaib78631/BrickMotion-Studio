"""Foundation report: one deterministic summary of every stage, and a regression check."""
from __future__ import annotations

import json
import statistics
from collections import Counter
from pathlib import Path

from .protocol import HELD_OUT_SPLITS, heldout_sets, protocol_hash, tuning_sets


def _load(path: Path):
    return json.loads(Path(path).read_text())


def _median(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def build_report(out_dir: Path) -> dict:
    out = Path(out_dir)
    audit = _load(out / "audit.json")["pairs"]
    grades = _load(out / "grades.json")
    identity = _load(out / "part-identity-api.json")
    gate = _load(out / "mask-gate.json")
    iou = {r["set"]: r["median_iou"] for r in grades}
    total = sum(r["booklet_vs_omr"]["total_a"] for r in identity)
    matched = sum(r["booklet_vs_omr"]["exact"] + r["reconcile"]["reconciled"] for r in identity)
    counts = Counter(r["grade"] for r in grades)
    mask = {}
    for split in ("train", "validation", "test"):
        rows = [g for g in gate if g["split"] == split]
        if rows:
            mask[split] = sum(g["passed"] for g in rows) / len(rows)
    held = {}
    for split in HELD_OUT_SPLITS:
        value = _median(iou[s] for s in heldout_sets(grades, split))
        if value is not None:
            held[split] = value
    return {
        "protocol_hash": protocol_hash(),
        "audit_usable": sum(1 for r in audit if r["alignment_ok"]),
        "grade_counts": {g: counts.get(g, 0) for g in "ABC"},
        "identity_matched_fraction": matched / total if total else None,
        "mask_pass": mask,
        "tuning_median_iou": _median(iou[s] for s in tuning_sets(grades)),
        "heldout_median_iou": held,
    }


def _flatten(value, prefix=""):
    if isinstance(value, dict):
        for key, inner in value.items():
            yield from _flatten(inner, f"{prefix}{key}.")
    else:
        yield prefix.rstrip("."), value


def regressions(baseline: dict, current: dict, tolerance: float = 0.005) -> list[str]:
    """Human-readable findings where `current` is worse than `baseline` (empty list = none)."""
    now = dict(_flatten(current))
    found = []
    for key, was in _flatten(baseline):
        if key not in now:
            found.append(f"{key}: missing (was {was})")
            continue
        is_now = now[key]
        if isinstance(was, str):
            if is_now != was:
                found.append(f"{key}: changed ({was[:12]} -> {str(is_now)[:12]})")
        elif was is not None and is_now is None:
            found.append(f"{key}: lost (was {was})")
        elif was is not None:
            slack = 0 if isinstance(was, int) and isinstance(is_now, int) else tolerance
            if is_now < was - slack:
                found.append(f"{key}: {was} -> {is_now}")
    return found
