"""Export a search Result as an AssemblyPlan JSON artifact (v1 contract)."""
from __future__ import annotations

import json

import numpy as np

from .assembly import Assembly
from .search import Result
from .schema import AssemblyPlan, Joint, Piece


def build_plan(asm: Assembly, result: Result, model: str | None = None) -> AssemblyPlan:
    pieces = [
        Piece(
            key=p.key,
            part=p.part,
            color=p.color,
            matrix=[float(v) for v in np.round(np.asarray(p.matrix).T, 2).ravel()],
            submodel=p.submodel,
        )
        for p in asm.pieces
    ]
    joints = [
        Joint(
            id=f"j{i}",
            kind=j.kind,
            parent=j.parent,
            child=j.child,
            axis=list(j.axis),
            confidence=j.confidence,
            **({"snap": {"pos": list(j.point)}} if any(j.point) else {}),
        )
        for i, j in enumerate(asm.joints)
    ]
    plan = AssemblyPlan(
        model=model or asm.lib.root,
        pieces=pieces,
        joints=joints,
        steps=result.steps,
        stats=result.stats,
        joints_certain=sum(1 for j in asm.joints if j.confidence == "snap"),
    )
    return plan


def write_plan(plan: AssemblyPlan, path: str) -> None:
    with open(path, "w") as f:
        json.dump(plan.to_json(), f, indent=1)
