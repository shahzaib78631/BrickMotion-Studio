"""Build the placement dataset from generated figures, train the scorer, report hold-out accuracy."""
import os
import random
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))

from assembly_model.ldraw import load_library
from brickheadz import place_learn as PL
from brickheadz.builder import build_figure
from brickheadz.export import normalize
from brickheadz.image_spec import ldconfig_rgb
from brickheadz.spec import random_spec

LIB = os.path.join(HERE, "..", "public", "ldraw")
LDCONFIG = os.path.join(LIB, "LDConfig.ldr")
OUT = os.path.join(HERE, "..", ".cache", "brickheadz", "placement-model.json")


def make_models(lib, n, seed):
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        try:
            out.append(normalize(build_figure(lib, random_spec(rng)).model))
        except Exception:
            continue
    return out


def top1_accuracy(lib, palette, models, model):
    """Among solver-style candidates for each part, is the true pose ranked #1?
    Compares the learned scorer against the hand-tuned IoU baseline."""
    from brickheadz.builder import rot_matrix
    from brickheadz.instruction_place import colour_mask, fit_camera, render_pieces, world_points

    correct = correct_iou = total = 0
    size = 160
    for m in models:
        gp = sorted([p for p in m.pieces if p.grid and not p.raw], key=lambda p: (p.grid[1], p.grid[0], p.grid[2]))
        if len(gp) < 4:
            continue
        cam = fit_camera(np.concatenate([world_points(lib, p.part, p.matrix) for p in gp]), 30, 25, size)
        built, occupied = [], set()
        for step in [gp[i: i + 4] for i in range(0, len(gp), 4)]:
            entries = [(p.part, PL.rgb_of(palette, p.color), p.matrix, False) for p in built]
            entries += [(p.part, PL.rgb_of(palette, p.color), p.matrix, True) for p in step]
            rgb, _ = render_pieces(lib, entries, cam, size)
            builtm = np.zeros((size, size), bool)
            for p in built:
                u, v, _ = cam.project(world_points(lib, p.part, p.matrix))
                from brickheadz.instruction_place import fill_polygon, plane_hull
                mk = np.zeros((size, size), bool); fill_polygon(mk, plane_hull(np.stack([u, v], 1))); builtm |= mk
            for p in step:
                mask = colour_mask(rgb, PL.rgb_of(palette, p.color))
                x, y, z, rot = p.grid
                R = rot_matrix(rot)
                learn, iou = [], []
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        for dz in (-1, 0, 1):
                            f, _ = PL.features(lib, p.part, x + dx, y + dy, z + dz, R, cam, size, mask, builtm, occupied)
                            learn.append((PL.score(model, f), (dx, dy, dz)))
                            iou.append((f[0], (dx, dy, dz)))
                correct += int(max(learn)[1] == (0, 0, 0))
                correct_iou += int(max(iou)[1] == (0, 0, 0))
                total += 1
            for p in step:
                occupied.update(PL._cells_of(lib, p.part, *p.grid[:3], rot_matrix(p.grid[3]))[1])
            built += step
    return correct / max(1, total), correct_iou / max(1, total), total


def main():
    lib = load_library(LIB)
    palette = ldconfig_rgb(LDCONFIG)
    train_models = make_models(lib, 40, seed=1)
    test_models = make_models(lib, 12, seed=99)
    print(f"train models {len(train_models)}  test models {len(test_models)}")
    X, Y = PL.build_dataset(lib, palette, train_models, size=160, seed=0)
    print(f"dataset X={X.shape} positives={int(Y.sum())} negatives={int((1-Y).sum())}")
    model = PL.train(X, Y, epochs=4000, lr=0.7, l2=1e-3)
    acc, iou_acc, n = top1_accuracy(lib, palette, test_models, model)
    print(f"hold-out top-1 local pose accuracy: learned {acc:.3f}  |  iou baseline {iou_acc:.3f}  over {n} parts")
    w = dict(zip(PL.FEATURES, [round(v, 3) for v in model["w"]]))
    print("learned weights:", w)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    PL.save(model, OUT)
    print("saved", OUT)


if __name__ == "__main__":
    main()
