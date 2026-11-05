"""Path-B spatial verifier: a small CNN that scores a *candidate pose* for a part.

Where the numpy scorer used 10 scalars, this sees a local patch: the step image,
the part's colour mask, the candidate's rendered silhouette, and the already-built
silhouette. That spatial context is what separates same-colour instances.

Training candidates are generated the way the solver generates them — from the
colour mask's connected components (cross-instance negatives), plus local
perturbations and random poses — so train and inference share a distribution.
"""
from __future__ import annotations

import numpy as np

from brickheadz.builder import rot_matrix
from brickheadz.instruction_place import (
    CUBE_ROTATIONS,
    colour_mask,
    components,
    fill_polygon,
    grid_matrix,
    plane_hull,
    solve_xz,
    world_points,
)
from brickheadz.place_learn import rgb_of

PATCH = 48
CHANNELS = 4  # grey, colour mask, candidate mask, built mask


def _sil(lib, part, m, cam, size):
    u, v, _ = cam.project(world_points(lib, part, m))
    mk = np.zeros((size, size), bool)
    fill_polygon(mk, plane_hull(np.stack([u, v], 1)))
    return mk


def _pose_eq(a, b):
    return a[0] == b[0] and a[1] == b[1] and a[2] == b[2] and np.allclose(a[3], b[3])


def candidates_for_part(lib, part, cam, size, mask, true_grid, rng, neg=12):
    """Solver-style candidate poses + labels (1 for the true pose)."""
    tx, ty, tz, trot = true_grid
    true_R = rot_matrix(trot)
    cands = [((tx, ty, tz, true_R), 1)]
    comps = components(mask)[:4]
    for cm in comps:
        ys, xs = np.where(cm)
        if not len(xs):
            continue
        sxz = solve_xz(lib, part, cam, (float(xs.mean()), float(ys.mean())), ty, true_R)
        if sxz:
            cands.append(((int(round(sxz[0])), ty, int(round(sxz[1])), true_R), 0))
    for _ in range(neg // 2):
        d = rng.integers(-1, 2, 3)
        cands.append(((tx + int(d[0]), ty + int(d[1]), tz + int(d[2]), true_R), 0))
    for _ in range(neg // 2):
        R = CUBE_ROTATIONS[int(rng.integers(0, len(CUBE_ROTATIONS)))]
        cands.append(((int(rng.integers(-8, 9)), int(rng.integers(0, 14)), int(rng.integers(-8, 9)), R), 0))
    # de-duplicate, relabel exact matches
    seen, out = set(), []
    for pose, label in cands:
        key = (pose[0], pose[1], pose[2], tuple(np.asarray(pose[3]).ravel().astype(int)))
        if key in seen:
            continue
        seen.add(key)
        out.append((pose, 1 if _pose_eq(pose, (tx, ty, tz, true_R)) else label))
    return out


def patch_for(lib, part, pose, cam, size, gray, mask, builtm):
    x, y, z, R = pose
    m, _fw, _fd = grid_matrix(lib, part, x, y, z, R)
    cand = _sil(lib, part, m, cam, size).astype(float)
    u, v, _ = cam.project(world_points(lib, part, m))
    cu, cv = float(u.mean()), float(v.mean())
    pad = PATCH // 2
    maps = [gray, mask.astype(float), cand, builtm.astype(float)]
    out = []
    for mp in maps:
        mp = np.pad(mp, pad, mode="constant")
        yy = min(max(int(round(cv)) + pad, pad), size + pad)
        xx = min(max(int(round(cu)) + pad, pad), size + pad)
        out.append(mp[yy - pad: yy + pad, xx - pad: xx + pad])
    return np.stack(out, 0).astype(np.float32)


def build_dataset(lib, palette, models, size=160, steps_per_model=6, parts_per_step=4, neg=12, seed=0):
    rng = np.random.default_rng(seed)
    X, Y = [], []
    for model in models:
        gp = sorted([p for p in model.pieces if p.grid and not p.raw], key=lambda p: (p.grid[1], p.grid[0], p.grid[2]))
        if len(gp) < 4:
            continue
        from brickheadz.instruction_place import fit_camera, render_pieces
        cam = fit_camera(np.concatenate([world_points(lib, p.part, p.matrix) for p in gp]), 30, 25, size)
        built = []
        for step in [gp[i: i + parts_per_step] for i in range(0, len(gp), parts_per_step)][:steps_per_model]:
            entries = [(p.part, rgb_of(palette, p.color), p.matrix, False) for p in built]
            entries += [(p.part, rgb_of(palette, p.color), p.matrix, True) for p in step]
            rgb, _ = render_pieces(lib, entries, cam, size)
            gray = rgb.mean(2) / 255.0
            builtm = np.zeros((size, size), bool)
            for p in built:
                builtm |= _sil(lib, p.part, p.matrix, cam, size)
            for p in step:
                mask = colour_mask(rgb, rgb_of(palette, p.color))
                if not mask.any():
                    continue
                for pose, label in candidates_for_part(lib, p.part, cam, size, mask, p.grid, rng, neg):
                    try:
                        X.append(patch_for(lib, p.part, pose, cam, size, gray, mask, builtm))
                        Y.append(label)
                    except Exception:
                        continue
            built += step
    return np.asarray(X, np.float32), np.asarray(Y, np.float32)


def make_net():
    import torch.nn as nn

    return nn.Sequential(
        nn.Conv2d(CHANNELS, 16, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        nn.Conv2d(16, 32, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        nn.Conv2d(32, 32, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        nn.Flatten(), nn.Linear(32 * (PATCH // 8) * (PATCH // 8), 64), nn.ReLU(), nn.Linear(64, 1),
    )


def train(X, Y, epochs=20, batch=128, lr=1e-3, seed=0):
    import torch
    import torch.nn as nn

    torch.manual_seed(seed)
    net = make_net()
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    lossf = nn.BCEWithLogitsLoss()
    xt = torch.tensor(X); yt = torch.tensor(Y).unsqueeze(1)
    n = len(X)
    for ep in range(epochs):
        perm = torch.randperm(n)
        tot = 0.0
        for i in range(0, n, batch):
            idx = perm[i: i + batch]
            opt.zero_grad()
            out = net(xt[idx])
            loss = lossf(out, yt[idx])
            loss.backward(); opt.step()
            tot += float(loss) * len(idx)
        if (ep + 1) % 5 == 0 or ep == 0:
            print(f"  epoch {ep+1:2d} loss {tot/n:.4f}")
    return net


def predict(net, X):
    import torch

    net.eval()
    with torch.no_grad():
        return torch.sigmoid(net(torch.tensor(X))).numpy().ravel()


def save(net, path):
    import torch

    torch.save(net.state_dict(), path)


def load(path):
    import torch

    net = make_net()
    net.load_state_dict(torch.load(path, map_location="cpu"))
    net.eval()
    return net
