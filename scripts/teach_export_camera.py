"""Export verified teacher steps for the three.js booklet-camera page (booklet-camera.html).

Per step: the booklet picture at its native resolution (step-NNNN.png) and the model so far with the step's
new parts marked (step-NNNN.json), in public/_booklet/<set>/, plus index.json.

cd python && .venv/bin/python ../scripts/teach_export_camera.py 21065 1
"""
import json
import hashlib
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "scripts"))


def main():
    import teach_booklet as T
    s, book = sys.argv[1], int(sys.argv[2])
    out = ROOT / "public/_booklet" / s
    out.mkdir(parents=True, exist_ok=True)
    v = T.verified(s)
    k_scale = float(T.config(s).get("scale", {}).get(str(book), 1.0))
    index = []
    for k in sorted(v):
        b, n = map(int, k.split(":"))
        if b != book:
            continue
        rgb, pts, _subs = T.picture(s, book, n - 1)
        if rgb is None:
            continue
        base = T.model_before(s, book, n)
        new = T.as_parts(v[k]["parts"])
        name = f"step-{n:04d}"
        cv2.imwrite(str(out / f"{name}.png"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        parts = [{"part": p if p.endswith(".dat") else p + ".dat", "color": int(c),
                  "matrix": np.asarray(m, float).T.ravel().round(5).tolist(), "new": i >= len(base)}
                 for i, (p, c, m) in enumerate(base + new)]
        (out / f"{name}.json").write_text(json.dumps({
            "step": n, "page": T.step_parts(s, book)[n - 1]["page"], "width": rgb.shape[1], "height": rgb.shape[0],
            "ptsPerPx": pts * k_scale if pts else None, "flipped": bool((v[k].get("edit") or {}).get("flipped")),
            "parts": parts, **({"exploded": bool(v[k]["exploded"])} if "exploded" in v[k] else {})}))
        index.append({"step": n, "name": name, "parts": len(parts), "new": len(new)})
    (out / "index.json").write_text(json.dumps({"set": s, "book": book, "teacherSha256": hashlib.sha256((T.folder(s) / "verified.json").read_bytes()).hexdigest(), "steps": index}, indent=1))
    print(out, len(index), "steps")


if __name__ == "__main__":
    main()
