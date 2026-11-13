"""Connection candidates for each new part of an exported booklet-camera step, for the page to score.

Each new part gets every distinct pose where it connects to the model so far or to the step's other new parts
(at their current poses) and does not overlap the model so far. The booklet-camera page (?cands=1) renders
each one with the held camera and keeps the one that matches the picture: a part on the side the camera
cannot see changes nothing in the render, so it loses to the pose that fills the red outline.

cd python && .venv/bin/python ../scripts/teach_cands.py ../public/_booklet/21065/step-0005.json
   -> step-0005-cands.json next to it: {"parts": [[column-major 16, ...] per new part]}
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))


def main():
    from assembly_model.ldraw import load_library
    from booklet_mpd.solver.candidates import candidates
    from booklet_mpd.solver.collide import Collider
    from booklet_mpd.solver.place import distinct
    src = Path(sys.argv[1])
    d = json.loads(src.read_text())
    lib = load_library(str(ROOT / "public/ldraw"))
    rows = [(p["part"], p["color"], np.asarray(p["matrix"], float).reshape(4, 4).T) for p in d["parts"]]
    base = [r for r, p in zip(rows, d["parts"]) if not p["new"]]
    new = [r for r, p in zip(rows, d["parts"]) if p["new"]]
    col = Collider(lib, use_oracle=True)
    col.set_model(base)
    out = []
    try:
        for k, (part, _c, _m) in enumerate(new):
            others = [r for j, r in enumerate(new) if j != k]
            cs = distinct(lib, part, candidates(lib, part, base) + candidates(lib, part, base + others))
            keep = [np.asarray(c["matrix"], float) for c in cs if not col.hits(part, np.asarray(c["matrix"], float))]
            out.append([m.T.ravel().round(4).tolist() for m in keep])
            print(part, len(cs), "candidates,", len(keep), "clear of the model")
    finally:
        col.close()
    dst = src.with_name(src.stem + "-cands.json")
    dst.write_text(json.dumps({"parts": out}))
    print(dst)


if __name__ == "__main__":
    main()
