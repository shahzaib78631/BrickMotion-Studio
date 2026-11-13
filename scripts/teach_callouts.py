"""Contact sheet of a booklet's callouts next to the parts-list pictures they were read as (teacher check).

cd python && .venv/bin/python ../scripts/teach_callouts.py 21065 1 1 13      # book 1, steps 1..13
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))


def main():
    s, book, a, b = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    from booklet_mpd.solver.parts import element_index
    T = ROOT / ".cache/booklet-mpd/teach" / s
    cfg = json.loads((T / "config.json").read_text())
    f = Path(cfg["books"][book - 1]["extract"])
    data = json.loads((f / "extract.json").read_text())
    rows = json.loads((T / f"parts-{book}.json").read_text())
    idx = element_index()
    by_part = defaultdict(list)
    for e in data["inventory"]:
        r = idx.get(e["element"], {})
        by_part[(str(r.get("ldrawPart")), int(r.get("color", -1)))].append(e["crop"])
    H = 90
    lines = []
    for st, r in zip(data["steps"], rows):
        if not a <= st["number"] <= b:
            continue
        # callouts in order; parts list per callout = repeated `count` entries in order
        tiles, k = [], 0
        for c in st.get("callout", []):
            n = int(c.get("count", 1) or 1)
            part = r["parts"][k] if k < len(r["parts"]) else None
            k += n
            im = cv2.imread(str(f / c["crop"]))
            inv = None
            if part:
                key = (part[0].replace(".dat", ""), int(part[1]))
                crops = by_part.get(key) or [v for (p, col), v2 in by_part.items() for v in v2 if p == key[0] and col == key[1]]
                inv = cv2.imread(str(f / crops[0])) if crops else None
            pair = []
            for x in (im, inv):
                if x is None:
                    x = np.full((H, H, 3), 255, np.uint8)
                x = cv2.resize(x, (max(1, int(x.shape[1] * H / x.shape[0])), H))
                pair.append(x)
            t = np.concatenate([pair[0], np.full((H, 3, 3), 0, np.uint8), pair[1]], 1)
            lab = np.full((16, t.shape[1], 3), 255, np.uint8)
            cv2.putText(lab, f"{n}x {part[0] if part else '?'}/{part[1] if part else ''}", (2, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1)
            tiles.append(np.concatenate([lab, t], 0))
        if not tiles:
            continue
        head = np.full((tiles[0].shape[0], 60, 3), 230, np.uint8)
        cv2.putText(head, f"{st['number']}", (6, 40), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
        cv2.putText(head, f"x{r['repeat']}", (6, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 200), 1)
        row = np.concatenate([head] + [np.concatenate([t, np.full((t.shape[0], 8, 3), 255, np.uint8)], 1) for t in tiles], 1)
        lines.append(row)
    W = max(x.shape[1] for x in lines)
    lines = [np.concatenate([x, np.full((x.shape[0], W - x.shape[1], 3), 255, np.uint8)], 1) for x in lines]
    out = T / f"callouts-{book}-{a:04d}-{b:04d}.png"
    cv2.imwrite(str(out), np.concatenate(sum([[x, np.full((4, W, 3), 120, np.uint8)] for x in lines], []), 0))
    print(out)


if __name__ == "__main__":
    main()
