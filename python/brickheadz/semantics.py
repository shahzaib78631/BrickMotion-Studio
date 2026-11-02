"""Connector-driven semantic decomposition of a BrickHeadz model.

Roles come from geometry and connectors, not hard-coded part ids.

The BrickHeadz head is built from *side-stud bricks*: bricks whose male studs
point sideways (the ``22885`` 1x2 brick with side studs and its family). This is
the universal head signature (100% of the corpus contains ``22885``), and unlike
generic SNOT it is not confused with the plate-based SNOT limbs. The head shell
is the connected cluster of side-stud bricks nearest the top; the head band runs
from its base to the figure top. Features (eyes/mouth) are small pieces
protruding beyond the head faces; the front is the face with the most (and
highest) such details. Hair sits above the head, the torso is the body mass
above the leg band, legs are the grounded bottom band, base is a wide grounded
plate, and detached props are accessories.

Best-effort by design: every result carries a consistency warning so the
heuristics can be tuned against the corpus. Raw part, colour and matrix are
always preserved.
"""
from __future__ import annotations

from dataclasses import replace

import numpy as np

from assembly_model.assembly import build_assembly
from assembly_model.geometry import BoxGrid
from assembly_model.ldraw import LDrawLibrary
from brickheadz.dat import Piece
from brickheadz.geometry import PLATE, STUD, geom_part, piece_aabb, to_figure, world_snaps
from brickheadz.schema import matrix_to_json

MIN_FIGURE = 18
ADJ_TOL = 6.0
SNOT_HORIZ = 0.35
LEG_BAND = 3.5  # plates above the ground that read as legs/feet
HEAD_BRICKS = {"22885", "11211", "87087", "4070"}  # bricks with stud(s) on one side (BrickHeadz head)
DIRS = {"+x": np.array([1.0, 0, 0]), "-x": np.array([-1.0, 0, 0]), "+z": np.array([0, 0, 1.0]), "-z": np.array([0, 0, -1.0])}


def analyze(lib: LDrawLibrary, pieces: list[Piece]) -> dict:
    asm_pieces = [replace(p, part=geom_part(lib, p)) for p in pieces]
    asm = build_assembly(lib, asm_pieces)

    boxes: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for key, (lo, hi) in asm.boxes.items():
        boxes[key] = to_figure((lo, hi))
    centers = {k: (lo + hi) / 2.0 for k, (lo, hi) in boxes.items()}

    snaps = {p.key: _snaps_figure(lib, p) for p in asm_pieces}
    snot = {k: _is_snot(v) for k, v in snaps.items()}
    head_brick = {k: _is_head_brick(k, asm_pieces) for k in snaps}

    keys = [p.key for p in asm_pieces if p.key in boxes]
    comp = _clusters(keys, boxes, asm.joints)
    groups: dict[int, list[str]] = {}
    for k in keys:
        groups.setdefault(comp[k], []).append(k)
    ordered = sorted(groups.values(), key=lambda g: (-len(g), g[0]))

    figures = [g for g in ordered if len(g) >= MIN_FIGURE]
    props = [g for g in ordered if len(g) < MIN_FIGURE]
    if not figures and ordered:
        figures = [ordered[0]]
        props = ordered[1:]

    warnings: list[str] = []
    piece_rows: list[dict] = []
    comp_rows: list[dict] = []
    figure_rows: list[dict] = []
    main_face: dict = {}
    ground = min(lo[1] for lo, _ in boxes.values()) if boxes else 0.0
    frame = {"up": [0, 1, 0], "front": [0, 0, -1], "ground": float(round(ground, 2))}

    by_key = {p.key: p for p in pieces}
    for fi, fig in enumerate(figures):
        res = _label_figure(fig, boxes, centers, snot, head_brick, ground)
        if fi == 0:
            main_face = res["face"]
            frame["front"] = res["frame_front"]
        for key in fig:
            piece_rows.append(_piece_row(by_key[key], key, fi, res["labels"].get(key, "unknown"), boxes[key], snot.get(key, False)))
        for c in res["components"]:
            c["figure"] = fi
            comp_rows.append(c)
        figure_rows.append({"index": fi, "pieces": len(fig), "bbox": _bbox(boxes, fig), "roles": _role_counts(res["labels"]), "face": res["face"], "headCube": res["head_cube"]})
        if res.get("warning"):
            warnings.append(f"figure {fi}: {res['warning']}")

    for grp in props:
        for key in grp:
            piece_rows.append(_piece_row(by_key[key], key, -1, "accessory", boxes[key], snot.get(key, False)))
        bb = _bbox(boxes, grp)
        comp_rows.append({"figure": -1, "label": "accessory", "pieces": len(grp), "bbox": bb, "dims": _dims(bb["ldu"])})

    conns = [{"a": j.parent, "b": j.child, "kind": j.kind, "confidence": j.confidence, "axis": [round(float(v), 3) for v in j.axis]} for j in asm.joints]

    return {
        "frame": frame,
        "bbox": _model_bbox(boxes),
        "figures": figure_rows,
        "pieces": piece_rows,
        "components": comp_rows,
        "connections": conns,
        "face": main_face,
        "warnings": warnings,
    }


def _snaps_figure(lib: LDrawLibrary, piece: Piece):
    out = []
    for s, pos, axis in world_snaps(lib, piece):
        out.append((s, np.array([pos[0], -pos[1], pos[2]]), np.array([axis[0], -axis[1], axis[2]])))
    return out


def _is_snot(rows) -> bool:
    return any(s.gender == "M" and abs(float(axis[1])) < SNOT_HORIZ for s, _, axis in rows)


def _is_head_brick(key: str, asm_pieces) -> bool:
    """A 22885-family side-stud brick (the universal BrickHeadz head brick)."""
    return next((p.base_part for p in asm_pieces if p.key == key), "") in HEAD_BRICKS


def _clusters(keys, boxes, joints) -> dict[str, int]:
    parent = {k: k for k in keys}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for j in joints:
        if j.parent in parent and j.child in parent:
            union(j.parent, j.child)
    grid = BoxGrid(cell=STUD)
    index = {k: i for i, k in enumerate(keys)}
    for i, k in enumerate(keys):
        lo, hi = boxes[k]
        grid.add(lo - ADJ_TOL, hi + ADJ_TOL, (1, i))
    for k in keys:
        lo, hi = boxes[k]
        for payload, _lo, _hi in grid.hits(lo, hi, exclude=(1, index[k])):
            other = keys[payload[1]]
            if other != k:
                union(k, other)
    return {k: find(k) for k in keys}


def _label_figure(keys, boxes, centers, snot, head_brick, ground) -> dict:
    labels: dict[str, str] = {}
    ys = np.array([centers[k][1] for k in keys])
    y_hi = float(ys.max())

    anchors = [k for k in keys if head_brick.get(k)]
    shell = _shell(anchors, boxes, keys)
    warning = None
    if len(shell) < 3:
        shell = [k for k in keys if centers[k][1] > y_hi - 6 * PLATE]
        warning = "head detected by fallback (no side-stud brick shell)"

    head_lo = min(boxes[k][0][1] for k in shell)
    head_hi = max(boxes[k][1][1] for k in shell)
    hx_lo, hx_hi, hz_lo, hz_hi = _robust_box(shell, centers)

    for k in keys:
        c, cy = centers[k], centers[k][1]
        in_xz = hx_lo - STUD <= c[0] <= hx_hi + STUD and hz_lo - STUD <= c[2] <= hz_hi + STUD
        if cy > head_hi + 0.25 * PLATE:
            labels[k] = "hair"
        elif (cy >= head_lo - 0.25 * PLATE and cy <= head_hi + 0.5 * PLATE) and in_xz:
            labels[k] = "head"

    front, face_keys = _front(keys, boxes, centers, head_lo, head_hi, hx_lo, hx_hi, hz_lo, hz_hi)
    for k in face_keys:
        labels[k] = "face"
    side_axes = ("+x", "-x") if front in ("+z", "-z") else ("+z", "-z")

    rest = [k for k in keys if k not in labels]
    band = [k for k in rest if centers[k][1] >= ground + LEG_BAND * PLATE]
    cx_all = float(np.median([centers[k][0] for k in band])) if band else 0.0
    core = [k for k in band if abs(centers[k][0] - cx_all) <= 2.0 * STUD]
    torso_half = (max([centers[k][0] for k in core]) - min([centers[k][0] for k in core])) / 2.0 if core else 0.0

    for k in rest:
        cy = centers[k][1]
        if cy < ground + 1.6 * PLATE and _wide(boxes[k], STUD * 2.5):
            labels[k] = "base"
        elif cy < ground + LEG_BAND * PLATE:
            labels[k] = "legs"
        elif abs(centers[k][0] - cx_all) > torso_half + 0.5 * STUD:
            labels[k] = "arms"
        else:
            labels[k] = "torso"

    # pieces protruding sideways from the torso band in the non-front axes are arms
    for d in side_axes:
        for k in _protruding(keys, boxes, centers, band, d, 2.5 * STUD):
            if labels.get(k) in ("torso",):
                labels[k] = "arms"

    comp_rows = _component_rows(keys, labels, boxes)
    return {
        "labels": labels,
        "components": comp_rows,
        "face": {"front": _vec(front), "side": front, "tiles": len(face_keys)},
        "frame_front": _vec(front),
        "head_cube": _dims(_bbox(boxes, shell)["ldu"]),
        "warning": warning,
    }


def _shell(anchors, boxes, keys) -> list[str]:
    if not anchors:
        return []
    seed = max(anchors, key=lambda k: boxes[k][1][1])
    grid = BoxGrid(cell=STUD)
    for i, k in enumerate(keys):
        lo, hi = boxes[k]
        grid.add(lo - ADJ_TOL, hi + ADJ_TOL, (1, i))
    idx = {k: i for i, k in enumerate(keys)}
    aset = set(anchors)
    seen, stack = {seed}, [seed]
    while stack:
        k = stack.pop()
        lo, hi = boxes[k]
        for payload, _lo, _hi in grid.hits(lo, hi, exclude=(1, idx[k])):
            other = keys[payload[1]]
            if other in aset and other not in seen:
                seen.add(other)
                stack.append(other)
    return _top_cluster(list(seen), boxes)


def _top_cluster(shell, boxes) -> list[str]:
    """Keep only the members within the contiguous top span of the shell."""
    if not shell:
        return []
    order = sorted(shell, key=lambda k: boxes[k][1][1], reverse=True)
    top = boxes[order[0]][1][1]
    keep = []
    for k in order:
        if top - boxes[k][1][1] > 24 * PLATE:  # > 8 bricks below the top: not the head
            break
        keep.append(k)
    return keep


def _robust_box(keys, centers):
    xs = np.array([centers[k][0] for k in keys])
    zs = np.array([centers[k][2] for k in keys])
    if len(xs) >= 4:
        return float(np.percentile(xs, 5)), float(np.percentile(xs, 95)), float(np.percentile(zs, 5)), float(np.percentile(zs, 95))
    return float(xs.min()), float(xs.max()), float(zs.min()), float(zs.max())


def _front(keys, boxes, centers, head_lo, head_hi, hx_lo, hx_hi, hz_lo, hz_hi):
    planes = {"+x": (hx_hi, 0, 1), "-x": (hx_lo, 0, -1), "+z": (hz_hi, 2, 1), "-z": (hz_lo, 2, -1)}
    scores, face_keys = {}, {}
    for d, (plane, axis_i, sign) in planes.items():
        sel = []
        for k in keys:
            c = centers[k]
            if not (head_lo - PLATE <= c[1] <= head_hi + 0.5 * PLATE):
                continue
            off = (c[axis_i] - plane) * sign
            if not (0.5 * PLATE < off < 2.2 * STUD):
                continue
            other = 1 - (axis_i // 2)  # 0 -> 2, 2 -> 0
            lo_o, hi_o = (hx_lo, hx_hi) if other == 0 else (hz_lo, hz_hi)
            if lo_o - STUD <= c[other] <= hi_o + STUD:
                sel.append(k)
        face_keys[d] = sel
        scores[d] = len(sel)
    front = max(DIRS, key=lambda d: (scores[d], d)) if any(scores.values()) else "-z"
    return front, face_keys[front]


def _protruding(keys, boxes, centers, band, d, reach):
    axis_i = 0 if "x" in d else 2
    sign = 1 if d[0] == "+" else -1
    vals = [centers[k][axis_i] for k in band]
    if not vals:
        return []
    edge = max(vals) if sign > 0 else min(vals)
    return [k for k in band if (centers[k][axis_i] - edge) * sign > reach]


def _wide(box, min_extent: float) -> bool:
    lo, hi = box
    return (hi[0] - lo[0]) >= min_extent and (hi[2] - lo[2]) >= min_extent


def _component_rows(keys, labels, boxes) -> list[dict]:
    by_label: dict[str, list[str]] = {}
    for k in keys:
        by_label.setdefault(labels[k], []).append(k)
    out = []
    for label, members in sorted(by_label.items()):
        bb = _bbox(boxes, members)
        out.append({"label": label, "pieces": len(members), "bbox": bb, "dims": _dims(bb["ldu"])})
    return out


def _role_counts(labels) -> dict:
    out: dict[str, int] = {}
    for v in labels.values():
        out[v] = out.get(v, 0) + 1
    return out


def _piece_row(piece: Piece, key: str, figure: int, label: str, box, is_snot: bool) -> dict:
    lo, hi = box
    return {
        "key": key,
        "part": piece.part,
        "basePart": piece.base_part,
        "color": piece.color,
        "decorated": piece.decorated,
        "submodel": piece.submodel,
        "figure": figure,
        "component": label,
        "snot": bool(is_snot),
        "matrix": matrix_to_json(piece.matrix),
        "aabb": [[round(float(v), 2) for v in lo], [round(float(v), 2) for v in hi]],
    }


def _bbox(boxes, keys) -> dict:
    lo = np.min([boxes[k][0] for k in keys], axis=0)
    hi = np.max([boxes[k][1] for k in keys], axis=0)
    return {"ldu": [[round(float(v), 2) for v in lo], [round(float(v), 2) for v in hi]]}


def _dims(ldu) -> dict:
    (x0, y0, z0), (x1, y1, z1) = ldu
    return {"wStuds": round((x1 - x0) / STUD, 2), "dStuds": round((z1 - z0) / STUD, 2), "hPlates": round((y1 - y0) / PLATE, 2)}


def _model_bbox(boxes) -> dict:
    if not boxes:
        return {"ldu": [[0, 0, 0], [0, 0, 0]], "dims": {"wStuds": 0, "dStuds": 0, "hPlates": 0}}
    bb = _bbox(boxes, list(boxes))
    bb["dims"] = _dims(bb["ldu"])
    return bb


def _vec(d: str) -> list[int]:
    return {"+x": [1, 0, 0], "-x": [-1, 0, 0], "+z": [0, 0, 1], "-z": [0, 0, -1]}[d]
