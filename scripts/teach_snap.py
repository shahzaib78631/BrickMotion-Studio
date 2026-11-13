"""Snap parts placed where an exploded booklet picture draws them to the real connection they move to.

A part drawn away from its place sits on its connection pose moved along the arrow (LDraw up by default)
and, in an orthographic picture, anywhere along the line of sight. So among the connection candidates
(booklet_mpd.solver.candidates) with the same orientation, the one whose offset from the drawn pose lies
in span{arrow, view direction} is where it goes; the exact collider checks it does not overlap the model.

.venv/bin/python ../scripts/teach_snap.py SNAP.json   # {"yaw","pitch","base":[[part,colour,4x4 row-major]],
                                                      #  "drawn":[{"part","color","matrix": column-major 16}]}
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))


def snap(lib, base, drawn, yaw, pitch, arrow=(0.0, -1.0, 0.0), collider=None):
    from booklet_mpd.solver.candidates import candidates
    from booklet_mpd.solver.place import _shape, distinct
    y, p = np.radians(yaw), np.radians(pitch)
    view = np.array([np.cos(p) * np.sin(y), -np.sin(p), np.cos(p) * np.cos(y)])
    A = np.stack([np.asarray(arrow, float), view], 1)            # 3x2: the unobservable / arrow directions
    out, model = [], list(base)
    for d in drawn:
        part = d["part"]
        M = np.asarray(d["matrix"], float).reshape(4, 4).T          # column-major -> row-major
        best = None
        for c in distinct(lib, part, candidates(lib, part, model)):
            C = np.asarray(c["matrix"], float)
            # same orientation up to the part's own symmetry (a 3x3 plate turned 90 degrees is the same pose):
            # compare the shape key, and positions by the lowest corner
            hc, loc = _shape(lib, part, C[:3, :3])
            hm, lom = _shape(lib, part, M[:3, :3])
            if hc != hm:
                continue
            r = (M[:3, 3] + lom) - (C[:3, 3] + loc)
            coef, *_ = np.linalg.lstsq(A, r, rcond=None)
            resid = float(np.linalg.norm(r - A @ coef))
            lift = float(coef[0])                                   # how far back along the arrow it was drawn
            hit = collider.hits(part, C) if collider is not None else False
            # the arrow is the move: from where it is drawn the part slides along the arrow into C, so the path
            # must be clear (it cannot pass through the model). Studs engage over the last 4 LDU.
            blocked = False
            if collider is not None and lift > 4:
                for t in np.arange(4.0, lift + 1e-6, 2.0):
                    P = C.copy()
                    P[:3, 3] += t * np.asarray(arrow, float)
                    if collider.hits(part, P):
                        blocked = True
                        break
            key = (hit or blocked or lift < -4, resid)
            if best is None or key < best[0]:
                best = (key, C, resid, lift, hit, blocked)
        if best is None:
            out.append({"part": part, "error": "no candidate with that orientation"})
            continue
        _k, C, resid, lift, hit, blocked = best
        out.append({"part": part, "color": d["color"], "matrix": C.round(4).tolist(), "residual_ldu": round(resid, 2),
                    "moved_along_arrow_ldu": round(lift, 1), "collides": bool(hit),
                    "path_blocked": bool(blocked)})
        model.append((part, d["color"], C))
        if collider is not None:
            collider.set_model(model)
    return out


def main():
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver.collide import Collider
    job = json.loads(Path(sys.argv[1]).read_text())
    lib = load_library(str(ROOT / "public/ldraw"))
    base = [(p, c, np.asarray(m, float)) for p, c, m in job["base"]]
    col = Collider(lib, use_oracle=True)
    col.set_model(base)
    try:
        print(json.dumps(snap(lib, base, job["drawn"], job["yaw"], job["pitch"], collider=col), indent=1))
    finally:
        col.close()


if __name__ == "__main__":
    main()
