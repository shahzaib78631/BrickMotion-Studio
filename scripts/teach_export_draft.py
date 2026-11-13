"""Export a step that is not verified yet for the booklet-camera page's placement mode (?place=1).

Writes public/_booklet/<set>/step-NNNN.json (the verified model so far + the step's new parts at a placeholder
pose) and step-NNNN-cands.json: for each new part type, every distinct connection pose clear of the model so far
(column-major). The page picks among them by the red outline. Not added to index.json.

cd python && .venv/bin/python ../scripts/teach_export_draft.py 21065 1 8 up      (or: down = model turned over)
           [--with step-NNNN-placed.json]   also connect to these already-placed new parts (a second pass)
"""
import json
import sys
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "scripts"))


def main():
    import teach_booklet as T
    from booklet_mpd.solver.candidates import candidates
    from booklet_mpd.solver.place import distinct
    s, book, n, side = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    extra = []
    if "--with" in sys.argv:
        placed = json.loads(Path(sys.argv[sys.argv.index("--with") + 1]).read_text())
        extra = [(p["part"].replace(".dat", ""), int(p["color"]), np.asarray(p["matrix"], float).reshape(4, 4).T) for p in placed]
    out = ROOT / "public/_booklet" / s
    rgb, pts, _subs = T.picture(s, book, n - 1)
    k_scale = float(T.config(s).get("scale", {}).get(str(book), 1.0))
    base = T.model_before(s, book, n)
    want = Counter((p.replace(".dat", ""), int(c)) for p, c in T.step_parts(s, book)[n - 1]["parts"])
    lib, col = T.lib(), T.collider()
    col.set_model(base)
    types, placeholder = {}, []
    try:
        for (part, colour), count in want.items():
            cs = distinct(lib, part, candidates(lib, part, base) + (candidates(lib, part, base + extra) if extra else []))
            keep = [np.asarray(c["matrix"], float) for c in cs if not col.hits(part, np.asarray(c["matrix"], float))]
            print(f"{part}/{colour} x{count}: {len(cs)} candidates, {len(keep)} clear of the model", flush=True)
            if not keep:
                raise SystemExit(f"no candidate for {part}")
            types[f"{part}.dat|{colour}"] = [m.T.ravel().round(4).tolist() for m in keep]
            placeholder += [(part, colour, keep[i % len(keep)]) for i in range(count)]
    finally:
        col.close()
    name = f"step-{n:04d}"
    cv2.imwrite(str(out / f"{name}.png"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    parts = [{"part": p if p.endswith(".dat") else p + ".dat", "color": int(c),
              "matrix": np.asarray(m, float).T.ravel().round(5).tolist(), "new": i >= len(base)}
             for i, (p, c, m) in enumerate(base + placeholder)]
    (out / f"{name}.json").write_text(json.dumps({
        "step": n, "page": T.step_parts(s, book)[n - 1]["page"], "width": rgb.shape[1], "height": rgb.shape[0],
        "ptsPerPx": pts * k_scale if pts else None, "flipped": side == "down", "exploded": False, "draft": True,
        "parts": parts}))
    (out / f"{name}-cands.json").write_text(json.dumps({"types": types}))
    print(out / f"{name}.json", len(base), "base parts,", len(placeholder), "new")


if __name__ == "__main__":
    main()
