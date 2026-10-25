"""Minimal recursive LDraw loader + LDCad snap metadata resolution."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from .geometry import transform_points


@dataclass(frozen=True)
class Snap:
    gender: str
    pos: tuple[float, float, float]
    axis: tuple[float, float, float]
    kind: str
    group: str | None
    grid: bool


class LDrawLibrary:
    def __init__(self, root: str):
        self.root = root
        self.dirs = [os.path.join(root, d) for d in ("parts", "p")] + [root]
        shadow_path = os.path.join(os.path.dirname(root), "data", "ldcad-shadow.json")
        self.shadow: dict[str, list[dict]] = {}
        if os.path.exists(shadow_path):
            raw = json.load(open(shadow_path))["files"]
            self.shadow = {k.lower(): _parse_ldcad_meta(v) for k, v in raw.items()}

    @lru_cache(maxsize=None)
    def find(self, name: str) -> str | None:
        rel = name.replace("\\", "/")
        base = rel.split("/")[-1]
        candidates = [rel] if rel.lower().startswith("s/") else [rel, f"s/{base}"]
        for d in self.dirs:
            for c in candidates:
                p = os.path.join(d, c)
                if os.path.isfile(p):
                    return p
        return None

    @lru_cache(maxsize=None)
    def triangles(self, name: str) -> np.ndarray:
        chunks = self._tri_walk(name.lower(), np.eye(4))
        if not chunks:
            return np.zeros((0, 3))
        return np.concatenate(chunks, axis=0)

    def _tri_walk(self, name: str, mat: np.ndarray) -> list[np.ndarray]:
        path = self.find(name)
        if path is None:
            return []
        tris, refs = _parse_file(path)
        chunks = [transform_points(pts, mat) for pts in tris]
        for ref, sub in refs:
            chunks.extend(self._tri_walk(ref, mat @ sub))
        return chunks

    @lru_cache(maxsize=None)
    def snaps(self, name: str) -> tuple[Snap, ...]:
        out: dict[tuple, Snap] = {}
        visited: set[tuple[str, bytes]] = set()
        stack = [(name.lower(), np.eye(4))]
        while stack:
            cur, mat = stack.pop()
            key = (cur, mat.round(4).tobytes())
            if key in visited:
                continue
            visited.add(key)
            for rec in self.shadow.get(cur, ()):
                if rec.get("type") == "SNAP_INCL" and rec.get("ref"):
                    stack.append((rec["ref"].lower(), mat))
                    continue
                self._add_snap(out, rec, mat)
            path = self.find(cur)
            if path is None:
                continue
            for ref, sub in _parse_file(path)[1]:
                stack.append((ref, mat @ sub))
        return tuple(out.values())

    def _add_snap(self, out: dict, rec: dict, mat: np.ndarray) -> None:
        raw = rec.get("pos", "").split()
        pos = np.array([float(v) for v in (raw or ["0", "0", "0"])[:3]], dtype=np.float64)
        cols, rows, dx, dz = _grid(rec.get("grid", ""))
        axis = _snap_axis(rec, mat)
        gender = rec.get("gender", rec.get("genderOfs", "")).strip()
        group = rec.get("group")
        kind = (rec.get("type", "SNAP").replace("SNAP_", "").lower()) or "snap"
        for gx in range(max(1, cols)):
            for gz in range(max(1, rows)):
                off = np.array([gx * dx, 0.0, gz * dz])
                p = transform_points((pos + off)[None, :], mat)[0]
                sn = Snap(
                    gender=gender,
                    pos=(round(float(p[0]), 2), round(float(p[1]), 2), round(float(p[2]), 2)),
                    axis=(round(float(axis[0]), 3), round(float(axis[1]), 3), round(float(axis[2]), 3)),
                    kind=kind,
                    group=group,
                    grid=bool(cols * rows > 1),
                )
                out.setdefault((sn.pos, sn.gender, sn.kind, sn.group), sn)


def _grid(spec: str) -> tuple[int, int, float, float]:
    parts = spec.split()
    if parts and parts[0] == "C" and len(parts) >= 4:
        dz = float(parts[4]) if len(parts) > 4 else 0.0
        return int(parts[1]), int(parts[2]), float(parts[3]), dz
    return 1, 1, 0.0, 0.0


def _snap_axis(rec: dict, mat: np.ndarray) -> np.ndarray:
    if "ori" in rec:
        vals = [float(v) for v in rec["ori"].split()]
        if len(vals) == 9:
            ori = np.array(vals, dtype=np.float64).reshape(3, 3)
            return (mat[:3, :3] @ ori[:, 0]).reshape(1, 3)[0]
    return (mat[:3, :3] @ np.array([0.0, -1.0, 0.0])).reshape(1, 3)[0]


def _parse_ldcad_meta(text: str) -> list[dict]:
    out = []
    for line in text.split("\n"):
        toks = line.split()
        if len(toks) < 3 or toks[0] != "0" or not toks[1].startswith("!LDCAD"):
            continue
        if not toks[2].startswith("SNAP"):
            continue
        rec: dict = {"type": toks[2]}
        for tok in toks[3:]:
            if tok.startswith("[") and tok.endswith("]") and "=" in tok[1:-1]:
                k, v = tok[1:-1].split("=", 1)
                rec[k] = v
        out.append(rec)
    return out


@lru_cache(maxsize=None)
def _parse_file(path: str):
    tris: list[np.ndarray] = []
    refs: list[tuple[str, np.ndarray]] = []
    for line in open(path, errors="ignore").read().splitlines():
        if not line or line[0] == "0":
            continue
        toks = line.split()
        if toks[0] == "1":
            mat, ref = _type1(toks)
            if ref is not None:
                refs.append((ref.lower(), mat))
        elif toks[0] in ("3", "4"):
            vals = [float(v) for v in toks[2:] if _is_float(v)]
            n = 3 if toks[0] == "3" else 4
            if len(vals) >= 3 * n:
                tris.append(np.array(vals[: 3 * n], dtype=np.float64).reshape(n, 3))
    return (tuple(tris), tuple(refs))


def _type1(toks: list[str]):
    """1 colour x y z a b c d e f g h i file (row-major 3x3, LDU)."""
    if len(toks) < 15:
        return None, None
    try:
        x, y, z, a, b, c, d, e, f, g, h, i = (float(v) for v in toks[2:14])
    except ValueError:
        return None, None
    mat = np.array([[a, b, c, x], [d, e, f, y], [g, h, i, z], [0.0, 0.0, 0.0, 1.0]])
    ref = toks[14] if len(toks) == 15 else " ".join(toks[14:])
    return mat, ref


def _is_float(v: str) -> bool:
    try:
        float(v)
        return True
    except ValueError:
        return False


def matrix_from_type1(toks: list[str]) -> np.ndarray:
    mat, _ = _type1(toks)
    return mat if mat is not None else np.eye(4)


def load_library(ldraw_root: str) -> LDrawLibrary:
    return LDrawLibrary(ldraw_root)
