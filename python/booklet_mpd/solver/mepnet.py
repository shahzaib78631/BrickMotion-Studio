"""Clean adapter for the MEPNet evaluation datasets (synthetic_test, classics, architecture).

Reads only plain files: `{ds}_lpub3d/{set}/model.ldr` (LDraw, root STEPs = MEPNet operations) and the
renders `{ds}/{set}/{k:03d}.png` (state after operation k, fixed camera). The `.pkl` files are never
opened. A root step line that references `submodel_N.ldr` is a submodule operation: the solver
places single parts only, so those count as misses.

Teacher-forced (MEPNet's component-wise / stepwise protocol): the true model before operation k and
the new parts' types and colours are given. The pixel scale is measured once per set on the step-0
render (the camera does not change within a set), so steps k >= 1 are scored; step 0 only fixes the
frame and is excluded, as in the booklet benchmark.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

DATA = Path("/Users/mac/Projects/BrickMotion-Data/mepnet/extracted/data/eval_datasets")
DATASETS = ("synthetic_test", "classics", "architecture")


@dataclass
class Op:
    index: int
    parts: list           # [(part, colour, 4x4)] flattened new parts
    submodules: int       # submodel references in this op
    image: Path


def _matrix(v: list[float]) -> np.ndarray:
    x, y, z, a, b, c, d, e, f, g, h, i = v
    return np.array([[a, b, c, x], [d, e, f, y], [g, h, i, z], [0, 0, 0, 1.0]])


def parse_mpd(text: str) -> dict[str, list[list[tuple[str, int, np.ndarray]]]]:
    """{file name: [steps: [(ref, colour, 4x4)]]}"""
    files: dict = {}
    current = None
    for raw in text.splitlines():
        tok = raw.split()
        if not tok:
            continue
        if tok[:2] == ["0", "FILE"]:
            current = " ".join(tok[2:]).lower()
            files[current] = [[]]
        elif tok[:2] == ["0", "NOFILE"]:
            current = None
        elif current is None:
            continue
        elif tok[:2] == ["0", "STEP"]:
            files[current].append([])
        elif tok[0] == "1" and len(tok) >= 15:
            ref = " ".join(tok[14:]).lower()
            files[current][-1].append((ref, int(tok[1]), _matrix([float(t) for t in tok[2:14]])))
    for name in files:
        while files[name] and not files[name][-1]:
            files[name].pop()
    return files


def flatten(files: dict, ref: str, matrix: np.ndarray, colour: int = 16) -> list:
    if ref in files:
        out = []
        for step in files[ref]:
            for r, c, m in step:
                out += flatten(files, r, matrix @ m, colour if c == 16 else c)
        return out
    return [(ref[:-4] if ref.endswith(".dat") else ref, colour, matrix)]


def operations(dataset: str, set_name: str) -> list[Op]:
    files = parse_mpd((DATA / f"{dataset}_lpub3d" / set_name / "model.ldr").read_text())
    root = next(iter(files))
    ops = []
    for k, step in enumerate(files[root]):
        parts, subs = [], 0
        for ref, colour, m in step:
            if ref in files:
                subs += 1
            parts += flatten(files, ref, m, colour)
        ops.append(Op(k, parts, subs, DATA / dataset / set_name / f"{k:03d}.png"))
    return ops


def sets(dataset: str) -> list[str]:
    return sorted(p.name for p in (DATA / f"{dataset}_lpub3d").iterdir() if (p / "model.ldr").exists())


def load_rgb(path: Path) -> np.ndarray | None:
    import cv2
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    if img.shape[2] == 4:
        alpha = img[..., 3:4].astype(float) / 255
        img = (img[..., :3] * alpha + 255 * (1 - alpha)).astype(np.uint8)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def pixel_scale(lib, parts: list, rgb: np.ndarray) -> float | None:
    """Pixels per LDU of a render, from its silhouette and the parts it shows (best view fit)."""
    from .picture import Picture
    from .register import rank_views
    from .step import _scale_from_extent
    views = rank_views(lib, parts, rgb, None, None, top=1)
    if not views:
        return None
    _iou, oi, yaw, pitch = views[0]
    return _scale_from_extent(lib, parts, oi, yaw, pitch, Picture.from_rgb(rgb, None, None))
