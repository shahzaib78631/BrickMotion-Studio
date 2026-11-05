"""Path-B learning: a numpy-trained placement scorer.

The solver's failure modes are same-colour instance confusion and mutual
occlusion. A hand-tuned IoU can't separate those; a small learned model over
image + physical features can. Training data is self-supervised: the procedural
generator produces grid-posed figures, so we render instruction-style step images
with exact ground-truth poses and label candidate poses true/false.

Features (all computable at inference):
  iou        candidate silhouette vs the step's colour mask
  precision  |cand ∩ mask| / |cand|
  recall     |cand ∩ mask| / |mask|
  builtOver  fraction of the candidate hidden behind already-built parts
  collision  fraction of the candidate's cells already occupied
  supported  1 if the candidate rests on built parts or the ground
  sizeRatio  candidate area / colour-mask area

Model: L2-regularised logistic regression (pure numpy), standardised features.
"""
from __future__ import annotations

import json

import numpy as np

from brickheadz.builder import rot_matrix
from brickheadz.instruction_place import (
    CUBE_ROTATIONS,
    Camera,
    colour_mask,
    fill_polygon,
    fit_camera,
    grid_matrix,
    plane_hull,
    render_pieces,
    world_points,
)
from brickheadz.parts import info

FEATURES = ["iou", "precision", "recall", "builtOver", "collision", "supported", "sizeRatio",
            "compPrec", "compRec", "compSize"]


def rgb_of(palette, c):
    """Colour RGB for code `c`, with a deterministic fallback for codes the
    parsed LDConfig subset doesn't cover (so training never stalls)."""
    if c in palette:
        return tuple(palette[c])
    rng = np.random.default_rng(int(c))
    return tuple(int(x) for x in rng.integers(40, 230, 3))


def _sil(lib, part, m, cam, size):
    u, v, _ = cam.project(world_points(lib, part, m))
    mk = np.zeros((size, size), bool)
    fill_polygon(mk, plane_hull(np.stack([u, v], 1)))
    return mk


def features(lib, part, x, y, z, R, cam, size, mask, builtm, occupied):
    from brickheadz.instruction_place import components

    m, fw, fd = grid_matrix(lib, part, x, y, z, R)
    cand = _sil(lib, part, m, cam, size)
    inter = int((cand & mask).sum())
    iou = inter / max(1, int((cand | mask).sum()))
    prec = inter / max(1, int(cand.sum()))
    rec = inter / max(1, int(mask.sum()))
    built_over = int((cand & builtm).sum()) / max(1, int(cand.sum()))
    h = info(lib, part).h
    foot = [(cx, cz) for cx in range(x, x + fw) for cz in range(z, z + fd)]
    coll = sum(1 for cx, cz in foot for cy in range(y, y + h) if (cx, cz, cy) in occupied)
    coll_frac = coll / max(1, fw * fd * h)
    sup = 1.0 if (y == 0 or any((cx, cz, y - 1) in occupied for cx, cz in foot)) else 0.0
    size_ratio = int(cand.sum()) / max(1, int(mask.sum()))
    # instance-exclusive features: how well the candidate alone explains the
    # largest unclaimed blob (the thing that disambiguates same-colour parts).
    comps = components(mask)
    comp = comps[0] if comps else np.zeros_like(mask)
    cint = int((cand & comp).sum())
    comp_prec = cint / max(1, int(cand.sum()))
    comp_rec = cint / max(1, int(comp.sum()))
    comp_size = int(cand.sum()) / max(1, int(comp.sum()))
    return np.array([iou, prec, rec, built_over, coll_frac, sup, size_ratio,
                     comp_prec, comp_rec, comp_size], float), m


def _cells_of(lib, part, x, y, z, R):
    m, fw, fd = grid_matrix(lib, part, x, y, z, R)
    h = info(lib, part).h
    return m, [(cx, cz, cy) for cx in range(x, x + fw) for cz in range(z, z + fd) for cy in range(y, y + h)]


def build_dataset(lib, palette, models, size=160, steps_per_model=8, parts_per_step=4,
                  neg_per_part=10, seed=0):
    rng = np.random.default_rng(seed)
    X, Y = [], []
    for model in models:
        gp = sorted(
            [p for p in model.pieces if p.grid and not p.raw],
            key=lambda p: (p.grid[1], p.grid[0], p.grid[2]),
        )
        if len(gp) < 4:
            continue
        pts = np.concatenate([world_points(lib, p.part, p.matrix) for p in gp])
        cam = fit_camera(pts, 30, 25, size)
        chunks = [gp[i: i + parts_per_step] for i in range(0, len(gp), parts_per_step)][:steps_per_model]
        built, occupied = [], set()
        for step in chunks:
            entries = [(p.part, rgb_of(palette, p.color), p.matrix, False) for p in built]
            entries += [(p.part, rgb_of(palette, p.color), p.matrix, True) for p in step]
            rgb, _ = render_pieces(lib, entries, cam, size)
            builtm = np.zeros((size, size), bool)
            for p in built:
                builtm |= _sil(lib, p.part, p.matrix, cam, size)
            for p in step:
                mask = colour_mask(rgb, rgb_of(palette, p.color))
                if not mask.any():
                    continue
                x, y, z, rot = p.grid
                R = rot_matrix(rot)
                f, _m = features(lib, p.part, x, y, z, R, cam, size, mask, builtm, occupied)
                X.append(f); Y.append(1)
                for _ in range(neg_per_part):
                    if rng.random() < 0.5:  # near miss (x/z/y perturbed)
                        nx, ny, nz = x + int(rng.integers(-1, 2)), y + int(rng.integers(-1, 2)), z + int(rng.integers(-1, 2))
                        nR = R
                    else:  # far random orientation/position
                        nx, ny, nz = int(rng.integers(-8, 9)), int(rng.integers(0, 14)), int(rng.integers(-8, 9))
                        nR = CUBE_ROTATIONS[int(rng.integers(0, len(CUBE_ROTATIONS)))]
                    try:
                        f, _m = features(lib, p.part, nx, ny, nz, nR, cam, size, mask, builtm, occupied)
                    except Exception:
                        continue
                    X.append(f); Y.append(0)
            for p in step:
                occupied.update(_cells_of(lib, p.part, *p.grid[:3], rot_matrix(p.grid[3]))[1])
            built += step
    return np.asarray(X, float), np.asarray(Y, float)


def train(X, Y, epochs=3000, lr=0.5, l2=1e-3, seed=0):
    mu, sd = X.mean(0), X.std(0) + 1e-8
    Z = (X - mu) / sd
    w = np.zeros(Z.shape[1]); b = 0.0
    n = len(Y)
    for _ in range(epochs):
        p = 1.0 / (1.0 + np.exp(-(Z @ w + b)))
        g = (p - Y)
        w -= lr * (Z.T @ g / n + l2 * w)
        b -= lr * g.mean()
    return {"w": w.tolist(), "b": float(b), "mu": mu.tolist(), "sd": sd.tolist(), "features": FEATURES}


def score(model, x):
    w = np.asarray(model["w"]); b = model["b"]
    mu = np.asarray(model["mu"]); sd = np.asarray(model["sd"])
    z = (np.asarray(x, float) - mu) / sd
    return float(1.0 / (1.0 + np.exp(-(z @ w + b))))


def save(model, path):
    with open(path, "w") as f:
        json.dump(model, f, indent=1)


def load(path):
    with open(path) as f:
        return json.load(f)
