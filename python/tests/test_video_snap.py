"""Video snapping: among exact snap poses, the colour score picks the one the frames show."""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
cv2 = pytest.importorskip("cv2")

from brickheadz import connectors as cg  # noqa: E402

LIB = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "public", "ldraw")
pytestmark = pytest.mark.skipif(not (os.path.isdir(LIB) and os.path.exists(os.path.join(cg.DEFAULT_DIR, "labels.json.xz"))),
                                reason="LDraw library or BrickNet catalogue not present")


def test_colour_score_picks_the_true_snap():
    from assembly_model.ldraw import load_library
    from brickheadz import video_snap as vs
    from brickheadz.part_render import PartMesh
    from brickheadz.video_place import silhouette_at
    from brickheadz.video_synth import VCam

    lib = load_library(LIB)
    base = np.eye(4)
    g = cg.build_graph(["3958"], [0], [base])  # 6x6 plate
    cands = cg.snap_candidates("3024", cg.free_connectors(g, [base]))
    assert len(cands) >= 36
    true = next(c["matrix"] for c in cands if np.allclose(c["matrix"][:3, 3], (10, -8, -30)))
    mesh = PartMesh(lib, "3024")
    cams = [VCam(yaw=20 + 30 * i, pitch=28, scale=4.0, ox=320, oy=320) for i in range(4)]
    mm = {}
    for f, c in enumerate(cams):
        tm, u0, v0 = silhouette_at(mesh, true, c)
        M = np.zeros((640, 640), np.float32)
        u0, v0 = int(round(u0)), int(round(v0))
        M[v0:v0 + tm.shape[0], u0:u0 + tm.shape[1]] = tm
        mm[f] = M
    S = vs.colour_scores(mesh, [c["matrix"] for c in cands], cams, mm)
    best = cands[int(np.argmax(S))]["matrix"]
    assert np.allclose(best[:3, 3], true[:3, 3])
    assert S.max() > 0.9
