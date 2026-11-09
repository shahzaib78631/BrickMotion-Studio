"""Render a model of real parts and score the picture against a caption with CLIP.

Each part's LDraw triangles (studs included) are sampled into points about SP LDU apart, each with
its triangle's normal, and cached. A model is drawn as point splats with a z-buffer, Lambert shading
(two-sided, since LDraw winding is not reliable) and the part's LDConfig colour, from above at a
three-quarter angle, scaled to fill the frame. CLIP ViT-B/32 embeds the views and the caption; a
model's score is the mean cosine between its views and the caption.
"""
from __future__ import annotations

from functools import lru_cache

import numpy as np

from .world import _file, _triangles

SIZE = 224
SP = 2.0
BG = 0.94
YAWS = (0.8, np.pi - 0.8)
LIGHT = np.array([0.35, 0.8, 0.48]) / np.linalg.norm([0.35, 0.8, 0.48])
MEAN = np.array([0.48145466, 0.4578275, 0.40821073])
STD = np.array([0.26862954, 0.26130258, 0.27577711])
CLIP_NAME = 'openai/clip-vit-base-patch32'


@lru_cache(maxsize=1)
def palette() -> dict[int, np.ndarray]:
    import re
    from omr.reader import LIB
    out = {}
    for line in (LIB / 'LDConfig.ldr').read_text(errors='ignore').splitlines():
        m = re.search(r'CODE\s+(\d+)\s+VALUE\s+#([0-9A-Fa-f]{6})', line)
        if m:
            h = m.group(2)
            out[int(m.group(1))] = np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)]) / 255
    return out


@lru_cache(maxsize=None)
def part_points(stem: str) -> tuple[np.ndarray, np.ndarray]:
    """Surface points and their normals, in the part's own frame (empty when the part is unknown)."""
    tris: list = []
    if _file(stem + '.dat'):
        _triangles(stem + '.dat', np.eye(4), tris, studs=True)
    if not tris:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.float32)
    pts, nrm = [], []
    for a, b, c in tris:
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n)
        if ln < 1e-9:
            continue
        k = int(np.ceil(max(np.linalg.norm(b - a), np.linalg.norm(c - a), np.linalg.norm(c - b)) / SP))
        k = max(1, min(k, 200))
        i, j = np.meshgrid(np.arange(k + 1), np.arange(k + 1), indexing='ij')
        keep = (i + j) <= k
        u, v = i[keep] / k, j[keep] / k
        p = a + np.outer(u, b - a) + np.outer(v, c - a)
        pts.append(p)
        nrm.append(np.repeat((n / ln)[None], len(p), 0))
    return np.concatenate(pts).astype(np.float32), np.concatenate(nrm).astype(np.float32)


def render(stems, colours, poses, yaw: float, pitch: float = 0.5, size: int = SIZE) -> np.ndarray:
    """size x size x 3 picture (0..1) of the parts at their poses (LDraw frame, y down)."""
    img = np.full((size, size, 3), BG)
    P, N, C = [], [], []
    pal = palette()
    for stem, col, m in zip(stems, colours, poses):
        p, n = part_points(stem)
        if not len(p):
            continue
        m = np.asarray(m, dtype=np.float64)
        P.append(p @ m[:3, :3].T + m[:3, 3])
        N.append(n @ m[:3, :3].T)
        C.append(np.repeat(pal.get(int(col), np.array([0.6, 0.6, 0.6]))[None], len(p), 0))
    if not P:
        return img
    P, N, C = np.concatenate(P), np.concatenate(N), np.concatenate(C)
    P[:, 1] *= -1  # y up
    N[:, 1] *= -1
    P -= (P.min(0) + P.max(0)) / 2
    cy, sy, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
    rot = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    tilt = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    R = tilt @ rot  # x right, y up, z towards the viewer
    Q, Nv = P @ R.T, N @ R.T
    nl = Nv / np.maximum(np.linalg.norm(Nv, axis=1, keepdims=True), 1e-9)
    shade = 0.35 + 0.65 * np.abs(nl @ (R @ LIGHT))
    col = np.clip(C * shade[:, None], 0, 1)
    span = max(np.ptp(Q[:, 0]), np.ptp(Q[:, 1]), 1e-6)
    scale = size * 0.88 / span
    px = np.round((Q[:, 0] - (Q[:, 0].max() + Q[:, 0].min()) / 2) * scale + size / 2).astype(int)
    py = np.round(-(Q[:, 1] - (Q[:, 1].max() + Q[:, 1].min()) / 2) * scale + size / 2).astype(int)
    r = max(1, int(np.ceil(scale * SP * 0.6)))
    off = np.arange(-r // 2, r - r // 2)
    dx, dy = np.meshgrid(off, off, indexing='ij')
    X = (px[:, None] + dx.ravel()[None]).ravel()
    Y = (py[:, None] + dy.ravel()[None]).ravel()
    ok = (X >= 0) & (X < size) & (Y >= 0) & (Y < size)
    D = np.repeat(Q[:, 2], dx.size)[ok]
    src = np.repeat(np.arange(len(Q)), dx.size)[ok]
    pix = (Y * size + X)[ok]
    order = np.lexsort((-D, pix))
    first = np.r_[True, pix[order][1:] != pix[order][:-1]]
    keep = order[first]
    img.reshape(-1, 3)[pix[keep]] = col[src[keep]]
    return img


def views(stems, colours, poses) -> list[np.ndarray]:
    return [render(stems, colours, poses, yaw) for yaw in YAWS]


class Scorer:
    """CLIP ViT-B/32 text and image embeddings (unit length) and render-caption match."""

    def __init__(self, device: str | None = None):
        import torch
        from transformers import CLIPTextModelWithProjection, CLIPTokenizerFast, CLIPVisionModelWithProjection
        self.torch = torch
        self.dev = device or ('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')
        self.tok = CLIPTokenizerFast.from_pretrained(CLIP_NAME)
        self.tm = CLIPTextModelWithProjection.from_pretrained(CLIP_NAME).to(self.dev).eval()
        self.vm = CLIPVisionModelWithProjection.from_pretrained(CLIP_NAME).to(self.dev).eval()

    def text(self, texts: list[str]) -> np.ndarray:
        with self.torch.no_grad():
            t = self.tok(texts, padding=True, truncation=True, max_length=77, return_tensors='pt').to(self.dev)
            e = self.tm(**t).text_embeds
        return (e / e.norm(dim=-1, keepdim=True)).float().cpu().numpy()

    def images(self, imgs: list[np.ndarray], batch: int = 64) -> np.ndarray:
        out = []
        for i in range(0, len(imgs), batch):
            x = (np.stack(imgs[i:i + batch]) - MEAN) / STD
            x = self.torch.tensor(x.transpose(0, 3, 1, 2), dtype=self.torch.float32, device=self.dev)
            with self.torch.no_grad():
                e = self.vm(pixel_values=x).image_embeds
            out.append((e / e.norm(dim=-1, keepdim=True)).float().cpu().numpy())
        return np.concatenate(out) if out else np.zeros((0, 512), np.float32)

    def score(self, models, text_vec: np.ndarray) -> np.ndarray:
        """models: (stems, colours, poses) each -> mean cosine of its views with text_vec."""
        imgs = [im for st, co, po in models for im in views(st, co, po)]
        e = self.images(imgs).reshape(len(models), len(YAWS), -1)
        return (e @ np.asarray(text_vec, dtype=np.float32)).mean(1)
