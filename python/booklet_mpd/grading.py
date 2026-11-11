"""Grade each set's answer key so benchmarks only use truth we can vouch for.

Rules (written before any set was graded; see docs/superpowers/specs/2026-11-11-foundation-hardening.md):
  A  alignment ok with strong evidence; booklet and OMR identity residuals <= 1% of parts;
     OMR total within 2% of the official inventory; median visible-IoU >= 0.8 over >= 3 steps; at least 75% of >= 3 sampled steps are scale-feasible (the fit reproduces the booklet's render scale).
  B  alignment ok, no identity residual above 5%, but an A condition is missing or unverified.
  C  alignment failed, or an identity residual above 5%.
"""
from __future__ import annotations

RULES_VERSION = 4   # 4: scale-constrained per-step fit; 3: per-step camera + exact refinement; 2: 24 orientations; 1: vertical turns
A_MAX_RESIDUAL = 0.01
C_MIN_RESIDUAL = 0.05
MAX_OFFICIAL_GAP = 0.02
MIN_IOU = 0.80
MIN_IOU_STEPS = 3
MIN_SCALE_FEASIBLE = 0.75   # share of sampled steps whose fit reproduces the booklet's render scale (replaces the CV rule)
MIN_SCALE_STEPS = 3


def grade_set(*, alignment_ok: bool, evidence: str | None, identity: dict | None,
              median_iou: float | None, iou_steps: int, scale_feasible: float | None, scale_steps: int) -> dict:
    if not alignment_ok:
        return {"grade": "C", "reasons": ["alignment failed"]}
    reasons: list[str] = []
    if evidence != "strong":
        reasons.append("alignment evidence is weak")
    worst = 0.0
    if identity is None:
        reasons.append("no printed parts list to verify identity")
    else:
        bt, ot = identity["booklet_total"], identity["omr_total"]
        br = identity["booklet_residual"] / bt if bt else 1.0
        orr = identity["omr_residual"] / ot if ot else 1.0
        worst = max(br, orr)
        if br > A_MAX_RESIDUAL:
            reasons.append(f"booklet residual {br:.1%} of parts")
        if orr > A_MAX_RESIDUAL:
            reasons.append(f"OMR residual {orr:.1%} of parts")
        official = identity.get("official_total")
        if official and abs(ot - official) / official > MAX_OFFICIAL_GAP:
            reasons.append(f"OMR total {ot} differs from official {official}")
    if median_iou is None or iou_steps < MIN_IOU_STEPS:
        reasons.append(f"geometric consistency not established ({iou_steps} steps)")
    elif median_iou < MIN_IOU:
        reasons.append(f"median visible IoU {median_iou:.2f} < {MIN_IOU}")
    if scale_feasible is None or scale_steps < MIN_SCALE_STEPS:
        reasons.append(f"render scale not established ({scale_steps} steps)")
    elif scale_feasible < MIN_SCALE_FEASIBLE:
        reasons.append(f"only {scale_feasible:.0%} of steps are scale-feasible (< {MIN_SCALE_FEASIBLE:.0%})")
    if worst > C_MIN_RESIDUAL:
        return {"grade": "C", "reasons": reasons}
    return {"grade": "A" if not reasons else "B", "reasons": reasons}
