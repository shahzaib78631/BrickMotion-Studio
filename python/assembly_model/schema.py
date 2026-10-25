"""Assembly plan data contract shared with the BrickMotion studio app.

Units: LDraw LDU. Stud pitch = 20, plate = 8, brick = 24. Y axis is DOWN in
plain +y (LDraw 'up' is -y) so all vectors are written in LDraw native space.
Matrices are column-major 4x4 (THREE.Matrix4.toArray() compatible).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Any

FORMAT = "brickmotion-assembly-plan"
VERSION = 1

CERT_KIND_SWEPT_AABB = "swept-aabb"


@dataclass
class Joint:
    id: str
    kind: str
    parent: str
    child: str
    axis: list[float]
    confidence: str
    snap: dict[str, Any] | None = None


@dataclass
class StepCertificate:
    kind: str
    frames: int
    margin: float
    clear: bool
    blockers: list[str] = field(default_factory=list)


@dataclass
class Insertion:
    axis: list[float]
    distance: float
    origin: list[float]
    priority: str
    tier: str


@dataclass
class Step:
    id: str
    pieces: list[str]
    order: int
    insertion: Insertion | None
    certificate: StepCertificate | None
    depends_on: list[int] = field(default_factory=list)
    uncertified: bool = False
    reason: str | None = None
    prior: dict[str, Any] | None = None


@dataclass
class Piece:
    key: str
    part: str
    color: int
    matrix: list[float]
    submodel: str | None = None
    group: str | None = None


@dataclass
class Corridor:
    piece: str
    axis: list[float]
    start: list[float]
    end: list[float]


@dataclass
class AssemblyPlan:
    model: str
    pieces: list[Piece]
    joints: list[Joint]
    steps: list[Step]
    stats: dict[str, Any] = field(default_factory=dict)
    joints_certain: int = 0
    app_plan: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        pieces = []
        for p in self.pieces:
            d = asdict(p)
            pieces.append(d)
        joints = [asdict(j) for j in self.joints]
        steps = []
        for s in self.steps:
            steps.append(
                {
                    "id": s.id,
                    "pieces": s.pieces,
                    "order": s.order,
                    "dependsOn": s.depends_on,
                    "insertion": asdict(s.insertion) if s.insertion else None,
                    "certificate": asdict(s.certificate) if s.certificate else None,
                    "uncertified": s.uncertified,
                    "reason": s.reason,
                    **({"prior": s.prior} if s.prior else {}),
                }
            )
        out = {
            "format": FORMAT,
            "version": VERSION,
            "model": self.model,
            "units": "ldu",
            "jointsCertain": self.joints_certain,
            "pieces": pieces,
            "joints": joints,
            "steps": steps,
            "stats": self.stats,
        }
        if self.app_plan is not None:
            # Optional embedded studio plan so one file carries the whole model.
            # Consumers ignore what they do not know; loaders keep the artifact itself.
            out["appPlan"] = self.app_plan
        return out

    def write(self, path: str) -> None:
        with open(path, "w") as f:
            json.dump(self.to_json(), f)

    @staticmethod
    def load(path: str) -> "AssemblyPlan":
        with open(path) as f:
            raw = json.load(f)
        if raw.get("format") != FORMAT or raw.get("version") != VERSION:
            raise ValueError(f"unsupported assembly plan: {raw.get('format')} v{raw.get('version')}")
        steps = []
        for s in raw["steps"]:
            ins = s.get("insertion")
            cert = s.get("certificate")
            steps.append(
                Step(
                    id=s["id"],
                    pieces=list(s["pieces"]),
                    order=int(s["order"]),
                    insertion=Insertion(**ins) if ins else None,
                    certificate=StepCertificate(**cert) if cert else None,
                    depends_on=list(s.get("dependsOn", [])),
                    uncertified=bool(s.get("uncertified", False)),
                    reason=s.get("reason"),
                    prior=s.get("prior"),
                )
            )
        pieces = [
            Piece(
                key=p["key"],
                part=p["part"],
                color=int(p["color"]),
                matrix=list(p["matrix"]),
                submodel=p.get("submodel"),
                group=p.get("group"),
            )
            for p in raw["pieces"]
        ]
        joints = [Joint(**j) for j in raw["joints"]]
        return AssemblyPlan(
            model=raw["model"],
            pieces=pieces,
            joints=joints,
            steps=steps,
            stats=raw.get("stats", {}),
            joints_certain=int(raw.get("jointsCertain", 0)),
        )
