"""Part classifier trained on synthetic shaded renders (stage 2).

Generates labelled images of LDraw parts (random view, colour, light), trains a
small CNN, and predicts a ranked part list for a tracked crop. Predictions come
with a softmax confidence; callers should treat low-confidence or low-margin
results as unidentified rather than trusting top-1.
"""
from __future__ import annotations

import multiprocessing as mp
import os
import random

import numpy as np

from brickheadz import part_render as pr
from brickheadz.image_spec import ldconfig_rgb
from brickheadz.part_match import CANDIDATES

_W: dict = {}


def vocabulary(lib, parts: list[str] | None = None) -> list[str]:
    seen, out = set(), []
    for p in parts or CANDIDATES:
        if p in seen:
            continue
        seen.add(p)
        name = p if p.endswith(".dat") else p + ".dat"
        if lib.find(name) is not None:
            out.append(p)
    return out


def _init_worker(root: str, vocab: list[str]):
    from assembly_model.ldraw import load_library

    lib = load_library(root)
    _W["meshes"] = {p: pr.PartMesh(lib, p) for p in vocab}
    _W["table"] = ldconfig_rgb(os.path.join(root, "LDConfig.ldr"))


def _video_like(img: np.ndarray, rng: random.Random, parts: list[str], meshes: dict, table: dict, ids: list[int]) -> np.ndarray:
    """Make a clean render look like a tracked video crop: a fragment of a neighbouring
    part, a side cut off by the frame or the blob box, blur and compression."""
    import cv2

    h, w = img.shape[:2]
    if rng.random() < 0.25:  # neighbour fragment (merged blob)
        other = pr.render(meshes[rng.choice(parts)], pr.random_view(rng), table[rng.choice(ids)], pr.random_light(rng),
                          size=rng.randint(48, 160), edge=img_edge(rng))
        if other is not None:
            oh, ow = other.shape[:2]
            H, W = max(h, oh) + oh // 2, max(w, ow) + ow // 2
            canvas = np.zeros((H, W, 3), np.uint8)
            y0, x0 = rng.randint(0, H - h), rng.randint(0, W - w)
            oy, ox = rng.choice([0, H - oh]), rng.choice([0, W - ow])
            canvas[oy : oy + oh, ox : ox + ow] = other
            sub = canvas[y0 : y0 + h, x0 : x0 + w]
            canvas[y0 : y0 + h, x0 : x0 + w] = np.where(img.max(2, keepdims=True) > 0, img, sub)
            # crop around the main part, keeping only a sliver of the neighbour
            m = max(4, int(0.25 * min(h, w)))
            img = canvas[max(0, y0 - m) : y0 + h + m, max(0, x0 - m) : x0 + w + m]
            h, w = img.shape[:2]
    if rng.random() < 0.15:  # cut off on one side
        f = rng.uniform(0.12, 0.35)
        side = rng.randrange(4)
        if side == 0:
            img = img[int(f * h) :]
        elif side == 1:
            img = img[: h - int(f * h)]
        elif side == 2:
            img = img[:, int(f * w) :]
        else:
            img = img[:, : w - int(f * w)]
    if rng.random() < 0.5:
        img = cv2.GaussianBlur(img, (0, 0), rng.uniform(0.4, 1.4))
    if rng.random() < 0.5:
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, rng.randint(30, 85)])
        if ok:
            img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    return img


def img_edge(rng: random.Random) -> float:
    """Outline strength: half the renders have none (the clips are smooth-shaded)."""
    return 0.0 if rng.random() < 0.5 else rng.uniform(0.3, 0.6)


def _make(args):
    part, seed, n, *rest = args
    if rest and rest[0] == "v2":
        return _make_v2(part, seed, n)
    rng = random.Random(seed)
    m, table = _W["meshes"][part], _W["table"]
    ids = [c for c in pr.COLOUR_IDS if c in table]
    imgs = []
    for _ in range(n):
        for _try in range(5):
            img = pr.render(m, pr.random_view(rng), table[rng.choice(ids)], pr.random_light(rng))
            if img is not None and min(img.shape[:2]) >= 6:
                imgs.append(pr.letterbox(img))
                break
        else:
            imgs.append(np.zeros((pr.INPUT, pr.INPUT, 3), np.uint8))
    return part, np.stack(imgs)


def _make_v2(part, seed, n):
    rng = random.Random(seed)
    meshes, table = _W["meshes"], _W["table"]
    parts = list(meshes)
    ids = [c for c in pr.COLOUR_IDS if c in table]
    imgs = []
    for _ in range(n):
        for _try in range(5):
            img = pr.render(meshes[part], pr.random_view(rng), table[rng.choice(ids)], pr.random_light(rng),
                            size=rng.randint(48, 160), edge=img_edge(rng))
            if img is not None and min(img.shape[:2]) >= 6:
                imgs.append(pr.letterbox(_video_like(img, rng, parts, meshes, table, ids)))
                break
        else:
            imgs.append(np.zeros((pr.INPUT, pr.INPUT, 3), np.uint8))
    return part, np.stack(imgs)


def generate(root: str, vocab: list[str], per_part: int, seed: int, workers: int | None = None,
             style: str = "v1") -> tuple[np.ndarray, np.ndarray]:
    """Return (N,64,64,3 uint8 BGR, N int labels). style "v2" adds video-like degradations
    (no outlines, neighbour fragments, cut-offs, blur, JPEG) to the clean renders."""
    jobs = []
    chunk = 50
    for pi, part in enumerate(vocab):
        for c in range(0, per_part, chunk):
            jobs.append((part, seed * 1_000_003 + pi * 1009 + c, min(chunk, per_part - c), style))
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers or max(1, (os.cpu_count() or 2) - 1), initializer=_init_worker, initargs=(root, vocab)) as pool:
        results = pool.map(_make, jobs)
    idx = {p: i for i, p in enumerate(vocab)}
    xs = np.concatenate([r[1] for r in results])
    ys = np.concatenate([np.full(len(r[1]), idx[r[0]], np.int64) for r in results])
    return xs, ys


# ---- model --------------------------------------------------------------------------

def build_model(n_classes: int, width: int = 192):
    import torch.nn as nn

    def block(i, o):
        return nn.Sequential(nn.Conv2d(i, o, 3, padding=1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True),
                             nn.Conv2d(o, o, 3, padding=1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True), nn.MaxPool2d(2))

    return nn.Sequential(block(3, 32), block(32, 64), block(64, 128), block(128, width),
                         nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Dropout(0.3), nn.Linear(width, n_classes))


def to_tensor(x_bgr: np.ndarray):
    import torch

    t = torch.from_numpy(x_bgr[..., ::-1].copy()).permute(0, 3, 1, 2).float() / 255.0
    return t


def augment(x):
    """Torch batch augmentation: brightness/contrast, noise, blur, random occlusion."""
    import torch
    import torch.nn.functional as F

    b = x.shape[0]
    dev = x.device
    gain = 0.75 + 0.5 * torch.rand(b, 1, 1, 1, device=dev)
    bias = 0.06 * (torch.rand(b, 1, 1, 1, device=dev) - 0.5)
    mask = (x.max(1, keepdim=True).values > 0.02).float()
    x = (x * gain + bias * mask).clamp(0, 1)
    x = x + 0.02 * torch.randn_like(x) * mask
    k = torch.tensor([[1, 2, 1], [2, 4, 2], [1, 2, 1]], device=dev, dtype=x.dtype) / 16
    blur = F.conv2d(x, k.expand(3, 1, 3, 3).contiguous(), padding=1, groups=3)
    sel = (torch.rand(b, 1, 1, 1, device=dev) < 0.5).float()
    x = sel * blur + (1 - sel) * x
    # random rectangular occlusion on 30% of samples (mimics overlapping parts / banner)
    for i in torch.nonzero(torch.rand(b, device=dev) < 0.3).flatten().tolist():
        h, w = int(torch.randint(8, 24, (1,))), int(torch.randint(8, 24, (1,)))
        y0, x0 = int(torch.randint(0, 64 - h, (1,))), int(torch.randint(0, 64 - w, (1,)))
        x[i, :, y0 : y0 + h, x0 : x0 + w] = 0
    return x


def train(xs, ys, vx, vy, n_classes: int, epochs: int = 20, batch: int = 128, device: str = "mps", log=print,
          width: int = 192):
    import torch
    import torch.nn.functional as F

    model = build_model(n_classes, width).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
    steps = epochs * ((len(xs) + batch - 1) // batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=steps)
    # keep images as uint8 and convert per batch (float copies of 100k+ images do not fit)
    X, Y = torch.from_numpy(np.ascontiguousarray(xs)), torch.from_numpy(ys)
    VY = torch.from_numpy(vy).to(device)
    best, best_state = 0.0, None
    for ep in range(epochs):
        model.train()
        perm = torch.randperm(len(X))
        tot = 0.0
        for i in range(0, len(X), batch):
            idx = perm[i : i + batch]
            xb, yb = augment(to_tensor(X[idx].numpy()).to(device)), Y[idx].to(device)
            loss = F.cross_entropy(model(xb), yb, label_smoothing=0.05)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            tot += float(loss) * len(idx)
        model.eval()
        with torch.no_grad():
            logits = torch.cat([model(to_tensor(vx[i : i + 512]).to(device)) for i in range(0, len(vx), 512)])
        top1 = float((logits.argmax(1) == VY).float().mean())
        top3 = float((logits.topk(3, 1).indices == VY[:, None]).any(1).float().mean())
        log(f"epoch {ep + 1:2d}/{epochs} loss={tot / len(X):.3f} val top1={top1:.3f} top3={top3:.3f}")
        if top1 >= best:
            best, best_state = top1, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    return model.cpu().eval(), best


def predict(model, vocab: list[str], crops_bgr: list[np.ndarray], top: int = 5) -> list[list[dict]]:
    import torch

    batch = np.stack([pr.letterbox(c) for c in crops_bgr])
    with torch.no_grad():
        p = torch.softmax(model(to_tensor(batch)), 1)
    out = []
    for row in p:
        v, i = row.topk(min(top, len(vocab)))
        out.append([{"part": vocab[int(j)], "p": round(float(s), 3)} for s, j in zip(v, i)])
    return out
