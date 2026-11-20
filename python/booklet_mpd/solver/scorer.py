"""Fixed-camera, bidirectional (precision + recall) completed-model scorer for Gate 4s & Gate 4b.

Fixes the structural biases of `register.Aligner`:
  1. Fixed camera (never re-optimises translation per candidate layout).
  2. Un-normalized additive objective (never divides by rendered area, so hiding or shrinking
     parts cannot inflate the score).
  3. Bidirectional silhouette + self-calibrated CIELAB colour likelihood (penalises both painting
     over bare paper AND leaving real picture foreground unexplained; calibrates each colour's
     empirical Lab centroid from the visible base model in the same picture).
  4. Bidirectional smooth edge matching (precision: rendered visible LDraw + boundary edges on
     picture ink; recall: picture ink explained by rendered edges), including BOTH dark outlines
     and light-on-dark outlines (for black/dark parts).
  5. Incremental rendering over the pre-rendered base model (~50-100x faster than re-rendering
     the whole model for every candidate layout).
"""
from __future__ import annotations

import cv2
import numpy as np

from .edges import DEPTH_TOL, ink as dark_ink, part_edges, sample_segments, visible_points
from .picture import Picture, colour_rgb
from .render import View, render, world_triangles

SIGMA_EDGE = 1.25          # px: Gaussian width for smooth edge precision & recall
SIGMA_COLOUR = 22.0        # Lab units: smooth colour-match falloff
PAPER_PENALTY = 1.6        # per rendered pixel falling on bare paper
UNEXPLAINED_PENALTY = 1.6  # per picture foreground pixel left uncovered by the model
EDGE_PREC_WEIGHT = 1.0     # per rendered edge pixel (smooth [-1, +1])
EDGE_REC_WEIGHT = 1.0      # per picture ink pixel (smooth [-1, +1])
RED_OUTLINE_WEIGHT = 1.5   # bonus per new-part edge pixel landing on a red new-part outline
CHANGE_WEIGHT = 1.2        # weight when previous-step difference mask is available


def light_ink(rgb: np.ndarray) -> np.ndarray:
    """Thin light outlines drawn on dark/black parts (booklets outline black bricks in light grey)."""
    v = rgb.max(2).astype(np.uint8)
    w_hat = cv2.morphologyEx(v, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    around = cv2.GaussianBlur(v.astype(np.float32), (0, 0), 3.0)
    return (w_hat > 22) & (around < 95.0)


def combined_ink(rgb: np.ndarray) -> np.ndarray:
    """All part outlines in the picture: dark ink + light-on-dark ink."""
    return dark_ink(rgb) | light_ink(rgb)


def red_outline_mask(rgb: np.ndarray, arrows: np.ndarray) -> np.ndarray:
    """Thin red outline strokes drawn around newly added parts (excluding red arrows and solid red faces)."""
    p = rgb.astype(np.float32)
    r, g, b = p[..., 0], p[..., 1], p[..., 2]
    red = ((r > 155) & (g < 95) & (b < 115) & (r - g > 85)).astype(np.uint8)
    # Remove large solid red brick faces; keep thin 1-3 px strokes
    blobs = cv2.morphologyEx(red, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    thin = (red & ~blobs).astype(bool)
    return thin & ~arrows


def _label_edges(label: np.ndarray) -> np.ndarray:
    e = np.zeros(label.shape, bool)
    e[:, 1:] |= label[:, 1:] != label[:, :-1]
    e[1:, :] |= label[1:, :] != label[:-1, :]
    fg = label >= 0
    return (e & fg) | _silhouette_edges(fg)


def _silhouette_edges(fg: np.ndarray) -> np.ndarray:
    e = np.zeros(fg.shape, bool)
    e[:, 1:] |= fg[:, 1:] != fg[:, :-1]
    e[1:, :] |= fg[1:, :] != fg[:-1, :]
    return e & fg


def _rgb_to_lab_single(rgb_tuple: tuple[int, int, int]) -> np.ndarray:
    arr = np.array([[rgb_tuple]], dtype=np.uint8)
    return cv2.cvtColor(arr, cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32)


def _edge_depth_map(lib, parts: list, view: View, depth: np.ndarray) -> np.ndarray:
    """(H, W) float64 map holding the visible edge depth of `parts` against `depth` (inf where none)."""
    ed = np.full(depth.shape, np.inf)
    pts = []
    for p, _c, m in parts:
        e = part_edges(lib, p)
        if len(e):
            m = np.asarray(m, float)
            w = e.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
            pts.append(sample_segments(view.project(w).reshape(-1, 2, 3)))
    if pts:
        allp = np.concatenate(pts)
        vis = visible_points(allp, depth)
        if len(vis):
            ed[vis[:, 0], vis[:, 1]] = depth[vis[:, 0], vis[:, 1]]
    return ed


def _align_prev_picture(prev_rgb: np.ndarray, cur_pic: Picture) -> np.ndarray | None:
    """Align `prev_rgb` (same camera section) to `cur_pic.rgb` by translation; returns changed-pixel mask
    or None if alignment is unreliable or >60% of foreground changed."""
    h, w = cur_pic.rgb.shape[:2]
    if prev_rgb.shape[:2] != (h, w):
        prev_rgb = cv2.resize(prev_rgb, (w, h), interpolation=cv2.INTER_AREA)
    # Use grayscale gradient correlation for translation alignment (robust to brightness shift)
    g1 = cv2.cvtColor(prev_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    g2 = cv2.cvtColor(cur_pic.rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    gx1, gy1 = cv2.Sobel(g1, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g1, cv2.CV_32F, 0, 1, ksize=3)
    gx2, gy2 = cv2.Sobel(g2, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g2, cv2.CV_32F, 0, 1, ksize=3)
    m1 = np.hypot(gx1, gy1)
    m2 = np.hypot(gx2, gy2)
    # Phase correlation on edge magnitude
    (dx, dy), resp = cv2.phaseCorrelate(m1, m2)
    if resp < 0.15 or abs(dx) > w * 0.45 or abs(dy) > h * 0.45:
        return None
    M = np.array([[1.0, 0.0, dx], [0.0, 1.0, dy]], dtype=np.float32)
    bg = tuple(int(round(v)) for v in cur_pic.background)
    aligned = cv2.warpAffine(prev_rgb, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=bg)
    # Blur slightly before diff so 0.5-px anti-aliasing doesn't fire as changed
    a = cv2.GaussianBlur(cur_pic.rgb.astype(np.float32), (0, 0), 0.8)
    b = cv2.GaussianBlur(aligned.astype(np.float32), (0, 0), 0.8)
    diff = np.linalg.norm(a - b, axis=-1)
    fg_n = int((cur_pic.foreground & ~cur_pic.arrows).sum())
    if fg_n < 50:
        return None
    changed = (diff > 28.0) & ~cur_pic.arrows
    share = float((changed & cur_pic.foreground).sum()) / fg_n
    if share < 0.005 or share > 0.65:
        return None
    return changed


class ModelScorer:
    """Fast, exact fixed-camera completed-model scorer for one step.

    Pre-renders `base` once and builds per-colour Lab likelihood planes + bidirectional edge maps.
    Calling `score(added)` composites only `added` onto the base Z-buffer and evaluates the exact
    whole-model objective in ~1-3 ms.
    """

    def __init__(self, lib, base: list, picture: Picture, view: View, codes: list[int],
                 prev_rgb: np.ndarray | None = None):
        self.lib = lib
        self.base = list(base)
        self.n_base = len(self.base)
        self.picture = picture
        self.view = view
        self.shape = picture.rgb.shape[:2]
        self.codes = list(codes)
        self.code_idx = {c: i for i, c in enumerate(self.codes)}

        # Pre-render base model once
        self.base_depth, self.base_label = render(lib, self.base, view, self.shape)
        self.base_edge_depth = _edge_depth_map(lib, self.base, view, self.base_depth)
        self.base_colour_idx = np.array([self.code_idx.get(c, -1) for _p, c, _m in self.base], dtype=np.int32)

        # Picture masks & ink distance
        self.fg = picture.foreground & ~picture.arrows
        self.arrows = picture.arrows
        self.ink_all = combined_ink(picture.rgb) & ~self.arrows
        self.ink_fg = self.ink_all & cv2.dilate(self.fg.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        self.red_outline = red_outline_mask(picture.rgb, self.arrows)

        d_pic = cv2.distanceTransform((~self.ink_all).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        self.edge_prec_map = (2.0 * np.exp(-0.5 * (d_pic / SIGMA_EDGE) ** 2) - 1.0).astype(np.float32)

        # Tight ROI covering foreground + base render (for fast distance transforms)
        roi_mask = self.fg | (self.base_label >= 0) | self.ink_fg
        ys, xs = np.nonzero(roi_mask)
        H, W = self.shape
        if len(xs):
            self.roi = (max(0, int(ys.min()) - 16), min(H, int(ys.max()) + 17),
                        max(0, int(xs.min()) - 16), min(W, int(xs.max()) + 17))
        else:
            self.roi = (0, H, 0, W)

        # Self-calibrated CIELAB colour score planes per code
        pic_lab = cv2.cvtColor(picture.rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
        ink_dil = cv2.dilate(self.ink_all.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        clean = self.fg & ~ink_dil
        base_col_map = np.full(self.shape, -1, dtype=np.int32)
        if self.n_base:
            valid = self.base_label >= 0
            base_col_map[valid] = self.base_colour_idx[self.base_label[valid]]

        K = len(self.codes)
        self.col_planes = np.zeros((K, H, W), dtype=np.float32)
        for k, code in enumerate(self.codes):
            ref = _rgb_to_lab_single(colour_rgb(code))
            chroma = float(np.hypot(ref[1] - 128.0, ref[2] - 128.0))
            wL = 0.85 if chroma < 12.0 else 0.45
            # Calibrate empirically from visible base pixels of this colour when available
            if self.n_base:
                mine = clean & (base_col_map == k)
                if int(mine.sum()) >= 30:
                    px = pic_lab[mine]
                    d0 = np.sqrt((wL * (px[:, 0] - ref[0])) ** 2 + (px[:, 1] - ref[1]) ** 2 + (px[:, 2] - ref[2]) ** 2)
                    inliers = px[d0 < 38.0]
                    if len(inliers) >= 25:
                        emp = np.median(inliers, axis=0)
                        ref = 0.7 * emp + 0.3 * ref
            dl = wL * (pic_lab[..., 0] - ref[0])
            da = pic_lab[..., 1] - ref[1]
            db = pic_lab[..., 2] - ref[2]
            dist = np.sqrt(dl * dl + da * da + db * db)
            plane = 2.0 * np.exp(-0.5 * (dist / SIGMA_COLOUR) ** 2) - 1.0
            plane[self.ink_all | self.arrows] = 0.0
            plane[~self.fg & ~self.arrows] = -PAPER_PENALTY
            self.col_planes[k] = plane.astype(np.float32)

        # Previous-step difference mask (optional)
        self.changed = _align_prev_picture(prev_rgb, picture) if prev_rgb is not None else None
        self.base_score = self.score([])

    def score(self, added: list) -> float:
        """Score `base + added` under the fixed camera. Higher is better."""
        H, W = self.shape
        if added:
            d_add, l_add = render(self.lib, added, self.view, self.shape)
            nearer = d_add < self.base_depth
            depth = np.where(nearer, d_add, self.base_depth)
            label = np.where(nearer, l_add + self.n_base, self.base_label)
        else:
            depth = self.base_depth
            label = self.base_label
            nearer = np.zeros(self.shape, bool)

        # 1. Silhouette + calibrated colour likelihood (fixed denominator: whole image!)
        covered = label >= 0
        if added:
            add_cidx = np.array([self.code_idx.get(c, -1) for _p, c, _m in added], dtype=np.int32)
            all_cidx = np.concatenate([self.base_colour_idx, add_cidx]) if self.n_base else add_cidx
        else:
            all_cidx = self.base_colour_idx

        total = 0.0
        if covered.any() and len(all_cidx):
            ys, xs = np.nonzero(covered)
            cidx = all_cidx[label[ys, xs]]
            ok = cidx >= 0
            if ok.any():
                total += float(self.col_planes[cidx[ok], ys[ok], xs[ok]].sum())
        # Penalise unexplained picture foreground (recall!)
        unexplained_fg = int(np.count_nonzero(self.fg & ~covered))
        total -= UNEXPLAINED_PENALTY * unexplained_fg

        # 2. Bidirectional edge matching (precision + recall)
        # Base edges survive only where not occluded by `added`
        e_ren = _label_edges(label)
        if self.n_base:
            e_ren |= (self.base_edge_depth <= depth + DEPTH_TOL)
        if added:
            add_ed = _edge_depth_map(self.lib, added, self.view, depth)
            add_edge = np.isfinite(add_ed)
            e_ren |= add_edge
            if self.red_outline.any():
                new_bound = _label_edges(np.where(label >= self.n_base, label, -1))
                total += RED_OUTLINE_WEIGHT * float(np.count_nonzero((add_edge | new_bound) & self.red_outline))

        # Precision: every rendered edge pixel scored on smooth distance to picture ink
        if e_ren.any():
            total += EDGE_PREC_WEIGHT * float(self.edge_prec_map[e_ren].sum())

        # Recall: every foreground picture ink pixel scored on smooth distance to rendered edges
        r0, r1, c0, c1 = self.roi
        e_roi = e_ren[r0:r1, c0:c1]
        ink_roi = self.ink_fg[r0:r1, c0:c1]
        if ink_roi.any():
            if e_roi.any():
                d_ren = cv2.distanceTransform((~e_roi).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
                d_vals = d_ren[ink_roi]
                total += EDGE_REC_WEIGHT * float((2.0 * np.exp(-0.5 * (d_vals / SIGMA_EDGE) ** 2) - 1.0).sum())
            else:
                total -= EDGE_REC_WEIGHT * float(ink_roi.sum())

        # 3. Previous-step picture difference evidence (when available)
        if self.changed is not None and added:
            new_vis = label >= self.n_base
            # Reward new visible pixels on changed regions; penalise new visible pixels on unchanged regions
            on_changed = int(np.count_nonzero(new_vis & self.changed))
            on_unchanged = int(np.count_nonzero(new_vis & ~self.changed & ~self.arrows))
            missed_changed = int(np.count_nonzero(self.changed & self.fg & ~new_vis))
            total += CHANGE_WEIGHT * (on_changed - on_unchanged - 0.5 * missed_changed)

        return float(total)
