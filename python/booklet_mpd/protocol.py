"""The frozen evaluation protocol.

* Tune only on `train` sets whose answer key is eligible (grade A or B, strong alignment).
* Report `validation` / `test` sets that are eligible and not contaminated, once, after tuning.
* A set whose failures were inspected while tuning a threshold is contaminated and never held out.
"""
from __future__ import annotations

import hashlib
import json

from . import grading

PROTOCOL_VERSION = 5   # 5: per-step before/after hypothesis (see grading.RULES_VERSION)
ELIGIBLE_GRADES = ("A", "B")
CONTAMINATED = {"40351": "step-mask thresholds were tuned while inspecting its failures"}
HELD_OUT_SPLITS = ("validation", "test")


class ProtocolError(RuntimeError):
    pass


def eligible(row: dict) -> bool:
    return row["grade"] in ELIGIBLE_GRADES and "alignment evidence is weak" not in row.get("reasons", [])


def tuning_sets(grades: list[dict]) -> list[str]:
    return [r["set"] for r in grades if r["split"] == "train" and eligible(r)]


def heldout_sets(grades: list[dict], split: str) -> list[str]:
    if split not in HELD_OUT_SPLITS:
        raise ProtocolError(f"{split!r} is not a held-out split")
    return [r["set"] for r in grades if r["split"] == split and eligible(r) and r["set"] not in CONTAMINATED]


def assert_tuning_allowed(set_number: str, grades: list[dict]) -> None:
    """Call before looking at a set's failures to choose a threshold or an algorithm."""
    for row in grades:
        if row["set"] == set_number:
            if row["split"] != "train":
                raise ProtocolError(f"{set_number} is in {row['split']}: it may not be used for tuning")
            return
    raise ProtocolError(f"{set_number} is not a graded set")


def protocol_hash() -> str:
    """Identity of the rules; stored with every report so a changed protocol is visible."""
    rules = {"version": PROTOCOL_VERSION, "eligible": ELIGIBLE_GRADES, "contaminated": CONTAMINATED,
             "heldout": HELD_OUT_SPLITS,
             "grading": {k: getattr(grading, k) for k in ("RULES_VERSION", "A_MAX_RESIDUAL", "C_MIN_RESIDUAL", "MAX_OFFICIAL_GAP", "MIN_IOU", "MIN_IOU_STEPS", "MIN_SCALE_FEASIBLE", "MIN_SCALE_STEPS")}}
    return hashlib.sha256(json.dumps(rules, sort_keys=True).encode()).hexdigest()
