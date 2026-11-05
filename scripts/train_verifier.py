"""Train the CNN candidate-verifier and report hold-out top-1 vs the IoU baseline."""
import os
import random
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "python"))

from assembly_model.ldraw import load_library
from brickheadz import verify_learn as VL
from brickheadz.builder import build_figure
from brickheadz.export import normalize
from brickheadz.image_spec import ldconfig_rgb
from brickheadz.instruction_place import colour_mask, fit_camera, render_pieces, world_points
from brickheadz.place_learn import rgb_of
from brickheadz.spec import random_spec

LIB = os.path.join(HERE, "..", "public", "ldraw")
LDCONFIG = os.path.join(LIB, "LDConfig.ldr")
OUT = os.path.join(HERE, "..", ".cache", "brickheadz", "verifier.pt")


def make_models(lib, n, seed):
    rng = random.Random(seed)
    out = []
    for _ in range(n):
        try:
            out.append(normalize(build_figure(lib, random_spec(rng)).model))
        except Exception:
            continue
    return out


def eval_top1(lib, palette, models, net, size=160):
    from brickheadz.builder import rot_matrix
    from brickheadz.instruction_place import grid_matrix

    rng = np.random.default_rng(7)
    correct = iou_correct = total = 0
    for m in models:
        gp = sorted([p for p in m.pieces if p.grid and not p.raw], key=lambda p: (p.grid[1], p.grid[0], p.grid[2]))
        if len(gp) < 4:
            continue
        cam = fit_camera(np.concatenate([world_points(lib, p.part, p.matrix) for p in gp]), 30, 25, size)
        built = []
        for step in [gp[i: i + 4] for i in range(0, len(gp), 4)]:
            entries = [(p.part, rgb_of(palette, p.color), p.matrix, False) for p in built]
            entries += [(p.part, rgb_of(palette, p.color), p.matrix, True) for p in step]
            rgb, _ = render_pieces(lib, entries, cam, size)
            gray = rgb.mean(2) / 255.0
            builtm = np.zeros((size, size), bool)
            for p in built:
                builtm |= VL._sil(lib, p.part, p.matrix, cam, size)
            for p in step:
                mask = colour_mask(rgb, rgb_of(palette, p.color))
                cands = VL.candidates_for_part(lib, p.part, cam, size, mask, p.grid, rng, neg=12)
                patches, labels, ious = [], [], []
                for pose, label in cands:
                    patches.append(VL.patch_for(lib, p.part, pose, cam, size, gray, mask, builtm))
                    labels.append(label)
                    mm, _fw, _fd = grid_matrix(lib, p.part, pose[0], pose[1], pose[2], pose[3])
                    mk = VL._sil(lib, p.part, mm, cam, size)
                    ious.append(int((mk & mask).sum()) / max(1, int((mk | mask).sum())))
                if not patches:
                    continue
                probs = VL.predict(net, np.asarray(patches, np.float32))
                labels = np.asarray(labels)
                correct += int(labels[int(np.argmax(probs))] == 1)
                iou_correct += int(labels[int(np.argmax(ious))] == 1)
                total += 1
            built += step
    return correct / max(1, total), iou_correct / max(1, total), total


def main():
    lib = load_library(LIB)
    palette = ldconfig_rgb(LDCONFIG)
    train_models = make_models(lib, 40, seed=1)
    test_models = make_models(lib, 12, seed=99)
    print(f"train models {len(train_models)}  test models {len(test_models)}")
    X, Y = VL.build_dataset(lib, palette, train_models, size=160, seed=0)
    print(f"dataset X={X.shape} positives={int(Y.sum())} negatives={int((1 - Y).sum())}")
    net = VL.train(X, Y, epochs=20, lr=1e-3)
    acc, iou_acc, n = eval_top1(lib, palette, test_models, net)
    print(f"hold-out top-1: CNN {acc:.3f}  |  IoU baseline {iou_acc:.3f}  over {n} parts")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    VL.save(net, OUT)
    print("saved", OUT)


if __name__ == "__main__":
    main()
