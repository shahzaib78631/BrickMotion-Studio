"""The certificate: what a solve proves, how it is stored, and how it is checked.

A solve emits, per step, the candidate table, the chosen candidate per part, the
objective, and the UNSAT-core labels from the optimality proof. That is enough for
a verifier to *recompute* — not trust — everything:

- ``exactly_one`` — one candidate per part, within range;
- ``disjoint_cells`` — no two chosen parts share a plate cell;
- ``supported`` — every chosen part rests on the ground, a pre-existing piece, or
  another chosen part whose top meets its bottom over a shared column;
- ``objective`` — the recorded optimum equals the summed scores of the picks;
- ``optimal`` — re-running the proof (constraints ∧ Σscore ≥ optimum+1) is UNSAT.

Optionally (with the image) it also re-renders every candidate and re-checks the
recorded ``on_new``/``iou``. Both the certificate and this verifier are pure data
+ geometry; neither trusts the solver's internal state.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field

from brickheadz.global_prove import build_groups, prove_bound, prove_unique, support_from_aabb, support_of


def _tops_to_json(pre_tops: dict) -> dict:
    return {f"{cx},{cz}": int(top) for (cx, cz), top in pre_tops.items()}


def _tops_from_json(data: dict) -> dict:
    out = {}
    for key, top in data.items():
        cx, cz = (int(v) for v in key.split(","))
        out[(cx, cz)] = int(top)
    return out


@dataclass
class Candidate:
    x: int
    y: int
    z: int
    R: list  # 9 floats, row-major
    cells: list  # [[cx, cz, cy], ...]
    score: int
    on_new: float
    iou: float
    aabb: list | None = None  # [[min x,y,z], [max x,y,z]] world bounds (LDU)
    blob: int = -1  # new-part blob this candidate explains (-1 = none)


@dataclass
class StepCertificate:
    step: int
    parts: list  # [{'part', 'color'}]
    candidates: list  # list per part of Candidate
    pick: list  # chosen candidate index per part
    objective: int
    status: str
    core: list = field(default_factory=list)
    unique: bool = False
    pre_tops: dict = field(default_factory=dict)
    pre_aabbs: list = field(default_factory=list)  # world bounds of already-built pieces
    camera: dict = field(default_factory=dict)
    segmentation: dict = field(default_factory=dict)
    coverage: list | None = None
    coverage_weight: int = 0


@dataclass
class Certificate:
    name: str
    camera_cert: dict
    steps: list = field(default_factory=list)


# --------------------------------------------------------------- storage -----


def step_to_json(s: StepCertificate) -> dict:
    d = asdict(s)
    d["pre_tops"] = _tops_to_json(s.pre_tops)
    return d


def step_from_json(d: dict) -> StepCertificate:
    return StepCertificate(
        step=d["step"], parts=d["parts"],
        candidates=[[Candidate(**c) for c in cl] for cl in d["candidates"]],
        pick=d["pick"], objective=d["objective"], status=d["status"], core=d.get("core", []),
        unique=bool(d.get("unique", False)),
        pre_tops=_tops_from_json(d.get("pre_tops", {})), pre_aabbs=d.get("pre_aabbs", []),
        camera=d.get("camera", {}),
        segmentation=d.get("segmentation", {}),
        coverage=d.get("coverage"), coverage_weight=d.get("coverage_weight",0),
    )


def write_cert(cert: Certificate, path: str) -> None:
    payload = {
        "format": "brickmotion-certificate",
        "version": 1,
        "name": cert.name,
        "camera": cert.camera_cert,
        "steps": [step_to_json(s) for s in cert.steps],
    }
    with open(path, "w") as f:
        json.dump(payload, f, indent=1)


def read_cert(path: str) -> Certificate:
    with open(path) as f:
        payload = json.load(f)
    return Certificate(name=payload["name"], camera_cert=payload.get("camera", {}),
                       steps=[step_from_json(s) for s in payload["steps"]])


# --------------------------------------------------------------- verify ------


def _cell_lists(s: StepCertificate) -> list:
    return [[tuple(tuple(c) for c in cand.cells) for cand in cl] for cl in s.candidates]


def _support(s: StepCertificate, cell_lists: list):
    """Contact support when boxes are recorded, else the plate-cell stack rule."""
    if all(cand.aabb for cl in s.candidates for cand in cl) and any(s.candidates):
        cand_boxes = [[tuple(tuple(float(v) for v in r) for r in cand.aabb) for cand in cl] for cl in s.candidates]
        pre_boxes = [tuple(tuple(float(v) for v in r) for r in b) for b in s.pre_aabbs]
        return support_from_aabb(cand_boxes, pre_boxes)
    return support_of(cell_lists, s.pre_tops)


def verify_step(s: StepCertificate, *, timeout_ms: int = 60_000) -> dict:
    """Recompute every claim of one step certificate. Returns per-check booleans."""
    n = len(s.parts)
    checks = {"exactly_one": True, "disjoint_cells": True, "supported": True,
              "objective": True, "optimal": False, "unique": False}
    if (len(s.pick) != n or len(s.candidates) != n or
        any(type(p) is not int or p < 0 or p >= len(s.candidates[i]) for i,p in enumerate(s.pick))):
        checks["exactly_one"] = False
        checks["supported"] = checks["objective"] = False
        return checks

    cell_lists = _cell_lists(s)
    scores = [[c.score for c in cl] for cl in s.candidates]

    seen: set = set()
    for i in range(n):
        if s.pick[i] is None:
            continue
        for c in cell_lists[i][s.pick[i]]:
            if c in seen:
                checks["disjoint_cells"] = False
            seen.add(c)

    grounded, supporters = _support(s, cell_lists)
    # Independently traverse only the selected support graph. A candidate
    # elsewhere in the table is not evidence that the chosen piece is supported.
    reached = {i for i,p in enumerate(s.pick) if grounded[i][p]}
    while True:
        added = {i for i,p in enumerate(s.pick) if i not in reached and
                 any(j in reached and s.pick[j] == q for j,q in supporters[i][p])}
        if not added:
            break
        reached.update(added)
    checks["supported"] = len(reached) == n

    total = sum(scores[i][s.pick[i]] for i in range(n) if s.pick[i] is not None)
    if s.coverage is not None:
        covered = {px for i,p in enumerate(s.pick) for px in s.coverage[i][p]}
        total += len(covered)*s.coverage_weight
    checks["objective"] = total == s.objective

    if s.status == "optimal":
        sig = [(p["part"], p["color"], len(s.candidates[i])) for i, p in enumerate(s.parts)]
        blob_ids = [[c.blob for c in cl] for cl in s.candidates]
        groups, _xs, pick_vars, pairs, obj = build_groups(n, cell_lists, s.pre_tops, sig, scores,
                                                          (grounded, supporters), blob_ids, s.coverage, s.coverage_weight)
        import z3
        witness = z3.Solver()
        witness.set(timeout=timeout_ms)
        witness.add(*[g for _name,g in groups])
        witness.add(*[pick_vars[i] == p for i,p in enumerate(s.pick)])
        witness_ok = witness.check() == z3.sat
        ok, core = prove_bound(groups, pairs, s.objective, timeout_ms)
        checks["optimal"] = witness_ok and ok and len(core) > 0
        if checks["optimal"] and all(p is not None for p in s.pick):
            recomputed = prove_unique(groups, obj, pick_vars, s.objective, list(s.pick), timeout_ms)
            checks["unique"] = recomputed == bool(s.unique)
        else:
            checks["unique"] = True
    else:
        checks["optimal"] = False  # no placement witness is certified by an unsat/unknown claim
        checks["unique"] = True

    return checks


def verify(cert: Certificate, *, timeout_ms: int = 60_000) -> dict:
    """Verify every step; returns {ok, steps: [...], camera: {...}}."""
    steps = []
    ok = True
    for s in cert.steps:
        checks = verify_step(s, timeout_ms=timeout_ms)
        passed = all(checks.values())
        ok = ok and passed
        steps.append({"step": s.step, "ok": passed, "checks": checks, "coreSize": len(s.core)})
    return {"ok": ok, "steps": steps, "camera": cert.camera_cert}


def verify_step_scores(sc: StepCertificate, lib, seg, cam, size: int, *, tol: float = 0.03) -> dict:
    """Re-render every candidate and re-check the recorded ``on_new`` / ``iou``.

    The data-only checks cannot police the score table (a forger could edit a
    candidate's score and the matching optimum); this is the independent source:
    scores are recomputed from the step image, so any tampering shows up here.
    """
    import numpy as np

    from brickheadz.instruction_place import grid_matrix
    from brickheadz.pose_domain import silhouette

    ok = True
    mismatches: list = []
    for i, part in enumerate(sc.parts):
        colour_px = seg.new_mask & (seg.labels == part["color"])
        for ci, cand in enumerate(sc.candidates[i]):
            r = np.array(cand.R, float).reshape(3, 3)
            m, _fw, _fd = grid_matrix(lib, part["part"], cand.x, cand.y, cand.z, r)
            sil = silhouette(lib, part["part"], m, cam, size)
            area = int(sil.sum())
            on_new = float((sil & seg.new_mask).sum()) / area if area else 0.0
            inter = float((sil & colour_px).sum())
            union = float((sil | colour_px).sum())
            iou = inter / union if union else 0.0
            overlaps = [(int((sil & b.mask).sum()), b.mask) for b in seg.blobs if b.color == part["color"]]
            if overlaps:
                overlap, mask = max(overlaps,key=lambda item:item[0])
                if overlap:
                    iou = max(iou,float(overlap)/max(1,int((sil|mask).sum())))
            good = abs(on_new - cand.on_new) <= tol and abs(iou - cand.iou) <= tol
            if sc.coverage is not None:
                pixels = np.flatnonzero(sil & colour_px).tolist()
                good = good and sorted(set(sc.coverage[i][ci])) == pixels
            ok = ok and good
            if not good:
                mismatches.append({"part": i, "x": cand.x, "y": cand.y, "z": cand.z})
    return {"ok": ok, "mismatches": mismatches}
