"""Bar/clip and hinge connection candidates from BrickNet's axial/hinge connector labels.

`brickheadz.connectors.snap_candidates` only handles stud/anti-stud connections. This module generates
candidates for:
  - bar <-> clip (`axle.bar` / `axle.clip`): free roll about the connector axis and slide along it;
  - hinge (`hinge.<type>.on` <-> `hinge.<type>.in`): free roll about the hinge axis, zero slide.

Conventions match `brickheadz.connectors`: each BrickNet row `[x, y, z, pitch, roll, length]` defines
a local 4x4 frame (`_frame(row)`) whose mating axis is its +/-Y axis and whose half-length is `length`.
"""
from __future__ import annotations

import math

import numpy as np

from brickheadz.connectors import _frame, catalog, dedupe_poses, ry

ROLL_STEP = 15.0
# Multiples of 15 deg (24) plus the 8 odd multiples of 22.5 deg (32 angles total)
ROLL_ANGLES = tuple(sorted({(i * ROLL_STEP) % 360.0 for i in range(round(360.0 / ROLL_STEP))}
                           | {(22.5 + 45.0 * i) % 360.0 for i in range(8)}))
SLIDE_STEP = 4.0
MAX_PER_HOST_PAIR = 600

_RX180 = np.diag([1.0, -1.0, -1.0, 1.0])
_REL_ROTS = np.stack([ry(deg) for deg in ROLL_ANGLES] + [ry(deg) @ _RX180 for deg in ROLL_ANGLES])


def _axial_connectors(part: str, cat) -> list[tuple[str, str, np.ndarray, float]]:
    """[(family, sub, local 4x4 frame, half_length)] for bar/clip and hinge connectors of `part`."""
    stem = cat.stem(part)
    if stem is None:
        return []
    d = cat.labels.get(stem + ".dat", {})
    out: list[tuple[str, str, np.ndarray, float]] = []
    for sub in ("bar", "clip"):
        for r in d.get("axle", {}).get(sub, []):
            out.append(("clip", sub, _frame(r), float(r[5]) if len(r) > 5 else 0.0))
    for htype, genders in d.get("hinge", {}).items():
        for gender, rows in genders.items():
            for r in rows:
                out.append((f"hinge:{htype}", gender, _frame(r), 0.0))
    return out


def _slides(la: float, lb: float) -> list[float]:
    """Slide offsets along a bar/clip axis: 0 plus multiples of SLIDE_STEP within max(la, lb),
    and the endpoint +/-max(la, lb) when not on the grid."""
    reach = max(la, lb)
    if reach < SLIDE_STEP - 1e-6:
        return [0.0]
    n = int(math.floor((reach + 1e-6) / SLIDE_STEP))
    vals = [k * SLIDE_STEP for k in range(-n, n + 1)]
    return vals


def joint_candidates(part: str, base: list, cat=None) -> list[dict]:
    """Bar/clip and hinge poses connecting `part` to `base` [(id, colour, 4x4)]."""
    cat = cat or catalog()
    if not base:
        return []
    mine = _axial_connectors(part, cat)
    if not mine:
        return []
    out: list[dict] = []
    for hi, (hp, _hc, hm) in enumerate(base):
        hconns = _axial_connectors(hp, cat)
        if not hconns:
            continue
        hm = np.asarray(hm, float)
        host_out: list[dict] = []
        seen: set[tuple] = set()
        for fam_m, sub_m, fm, lm in mine:
            fm_inv = np.linalg.inv(fm)
            for fam_h, sub_h, fh, lh in hconns:
                if fam_m != fam_h or sub_m == sub_h:
                    continue
                kind = "clip" if fam_m == "clip" else "hinge"
                wh = hm @ fh
                axis = -wh[:3, 1]
                slides = _slides(lm, lh) if kind == "clip" else [0.0]
                # Batch transform: wh @ rel @ fm_inv for all rotations and slides
                # rel = T(0, s, 0) @ R_rel -> translation in wh frame is s * wh[:3, 1]
                base_mats = np.einsum("ij,rjk,kl->ril", wh, _REL_ROTS, fm_inv)
                for s in slides:
                    shift = s * wh[:3, 1]
                    for r_idx in range(len(_REL_ROTS)):
                        m = base_mats[r_idx].copy()
                        m[:3, 3] += shift
                        key = tuple(np.round(m[:3, 3] * 2).astype(int)) + tuple(np.round(m[:3, :3].ravel(), 2))
                        if key in seen:
                            continue
                        seen.add(key)
                        host_out.append({
                            "matrix": m,
                            "host": hi,
                            "kind": kind,
                            "axis": axis,
                            "bidirectional": True,
                        })
                        if len(host_out) >= MAX_PER_HOST_PAIR:
                            break
                    if len(host_out) >= MAX_PER_HOST_PAIR:
                        break
                if len(host_out) >= MAX_PER_HOST_PAIR:
                    break
            if len(host_out) >= MAX_PER_HOST_PAIR:
                break
        out.extend(host_out)
    return dedupe_poses(out)
