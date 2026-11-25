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
SIGMA_COLOUR = 18.0        # true CIELAB units (L* in [0,100]): smooth colour-match falloff (base-calibrated)
SIGMA_COLOUR_NEW = 26.0    # true CIELAB units: slightly wider falloff for colours unseen in base
PAPER_PENALTY = 1.6        # per rendered pixel falling on bare paper
UNEXPLAINED_PENALTY = 1.6  # per picture foreground pixel left uncovered by the model
EDGE_PREC_WEIGHT = 1.0     # per rendered edge pixel (smooth [-1, +1])
EDGE_REC_WEIGHT = 1.0      # per picture ink pixel (smooth [-1, +1])
RED_OUTLINE_WEIGHT = 1.5   # bonus per new-part edge pixel landing on a red new-part outline
CHANGE_WEIGHT = 0.7        # weight when previous-step difference mask is available

import re as _re
_PRINT_RE = _re.compile(r"^\d+[a-z]?(?:pr|p|pat|pb)[0-9a-z]+$")


def _is_printed(part: str) -> bool:
    return bool(_PRINT_RE.match(part.lower().removesuffix(".dat")))


def light_ink(rgb: np.ndarray) -> np.ndarray:
    """Thin light outlines drawn on dark/black parts (booklets outline black bricks in light grey)."""
    v = rgb.max(2).astype(np.uint8)
    w_hat = cv2.morphologyEx(v, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    around = cv2.GaussianBlur(v.astype(np.float32), (0, 0), 3.0)
    return (w_hat > 22) & (around < 95.0)


def combined_ink(rgb: np.ndarray) -> np.ndarray:
    """All part outlines in the picture: thin dark outlines (with solid black/dark brick
    interiors eroded away so black brick faces score as black colour rather than ink!)
    plus thin light-on-dark outlines drawn on dark/black parts."""
    dk = dark_ink(rgb)
    solid_inner = cv2.erode(dk.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    dk_thin = dk & ~solid_inner
    return dk_thin | light_ink(rgb)


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
    """True CIELAB (L* in [0, 100], a*, b* in [0, 255] centred at 128)."""
    arr = np.array([[rgb_tuple]], dtype=np.uint8)
    lab = cv2.cvtColor(arr, cv2.COLOR_RGB2LAB)[0, 0].astype(np.float32)
    lab[0] *= (100.0 / 255.0)
    return lab


def _edge_depth_map(lib, parts: list, view: View, depth: np.ndarray) -> np.ndarray:
    """(H, W) float64 map holding the visible edge depth of `parts` against `depth` (inf where none)."""
    segs = []
    for p, _c, m in parts:
        e = part_edges(lib, p)
        if len(e):
            m = np.asarray(m, float)
            w = e.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
            segs.append(view.project(w).reshape(-1, 2, 3))
    if not segs:
        return np.full(depth.shape, np.inf)
    all_segs = np.concatenate(segs, axis=0)
    from . import native_bridge
    fast = native_bridge.rasterize_edges(all_segs, depth, DEPTH_TOL, spacing=0.7, want_mask=False, want_depth=True)
    if fast is not None:
        return fast[1]
    ed = np.full(depth.shape, np.inf)
    vis = visible_points(sample_segments(all_segs), depth)
    if len(vis):
        ed[vis[:, 0], vis[:, 1]] = depth[vis[:, 0], vis[:, 1]]
    return ed


def _align_prev_picture(prev_rgb: np.ndarray, cur_pic: Picture,
                        prev_pts: float | None = None) -> np.ndarray | None:
    """Align `prev_rgb` (same camera section) to `cur_pic.rgb` by pure isotropic scale + translation;
    returns changed-pixel mask or None if alignment is unreliable or >65% of foreground changed.

    Critically: `prev_rgb` is NEVER stretched to match `cur_pic`'s bounding box (adding new parts
    grows the cropped image's dimensions!). Instead it is scaled isotropically by `prev_pts / cur_pic.pts_per_px`
    (or `cur_pic.factor`) and padded into a common canvas before phase correlation."""
    h, w = cur_pic.rgb.shape[:2]
    if prev_pts and cur_pic.pts_per_px:
        scale = float(prev_pts) / float(cur_pic.pts_per_px)
    else:
        scale = float(cur_pic.factor)
    if abs(scale - 1.0) > 1e-3:
        pw = max(1, int(round(prev_rgb.shape[1] * scale)))
        ph = max(1, int(round(prev_rgb.shape[0] * scale)))
        prev_scaled = cv2.resize(prev_rgb, (pw, ph), interpolation=cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR)
    else:
        prev_scaled = prev_rgb
    ph, pw = prev_scaled.shape[:2]
    # Pad both edge-magnitude maps to a common canvas so phase correlation measures exact translation
    ch = max(h, ph) + 32
    cw = max(w, pw) + 32
    def _grad_mag(img):
        g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32)
        gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
        return np.hypot(gx, gy)
    m1 = np.zeros((ch, cw), dtype=np.float32)
    m2 = np.zeros((ch, cw), dtype=np.float32)
    m1[:ph, :pw] = _grad_mag(prev_scaled)
    m2[:h, :w] = _grad_mag(cur_pic.rgb)
    # Phase correlation gives (dx, dy) shifting m1 onto m2
    (dx, dy), resp = cv2.phaseCorrelate(m1, m2)
    if resp < 0.12 or abs(dx) > cw * 0.45 or abs(dy) > ch * 0.45:
        return None
    M = np.array([[1.0, 0.0, dx], [0.0, 1.0, dy]], dtype=np.float32)
    bg = tuple(int(round(v)) for v in cur_pic.background)
    aligned = cv2.warpAffine(prev_scaled, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=bg)
    # Blur slightly before diff so 0.5-px anti-aliasing doesn't fire as changed
    a = cv2.GaussianBlur(cur_pic.rgb.astype(np.float32), (0, 0), 0.8)
    b = cv2.GaussianBlur(aligned.astype(np.float32), (0, 0), 0.8)
    diff = np.linalg.norm(a - b, axis=-1)
    fg_n = int((cur_pic.foreground & ~cur_pic.arrows).sum())
    if fg_n < 50:
        return None
    changed = (diff > 28.0) & ~cur_pic.arrows
    share = float((changed & cur_pic.foreground).sum()) / fg_n
    if share < 0.003 or share > 0.65:
        return None
    return changed


class ModelScorer:
    """Fast, exact fixed-camera completed-model scorer for one step.

    Pre-renders `base` once and builds per-colour Lab likelihood planes + bidirectional edge maps.
    Calling `score(added)` composites only `added` onto the base Z-buffer and evaluates the exact
    whole-model objective in ~0.3 ms.
    """

    def __init__(self, lib, base: list, picture: Picture, view: View, codes: list[int],
                 prev_rgb: np.ndarray | None = None, prev_pts: float | None = None):
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

        # Self-calibrated true-CIELAB colour score planes per code (L* scaled to [0, 100]!)
        pic_lab = cv2.cvtColor(picture.rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
        pic_lab[..., 0] *= (100.0 / 255.0)
        ink_dil = cv2.dilate(self.ink_all.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        clean = self.fg & ~ink_dil
        base_col_map = np.full(self.shape, -1, dtype=np.int32)
        if self.n_base:
            valid = self.base_label >= 0
            base_col_map[valid] = self.base_colour_idx[self.base_label[valid]]

        K = len(self.codes)
        self.base_col_map = base_col_map
        refs = []
        wLs = []
        calibrated = [False] * K
        for k, code in enumerate(self.codes):
            ref = _rgb_to_lab_single(colour_rgb(code))
            chroma = float(np.hypot(ref[1] - 128.0, ref[2] - 128.0))
            wL = 0.70 if chroma < 12.0 else 0.50
            # 1. Calibrate empirically from visible base pixels of this colour when available
            if self.n_base:
                mine = clean & (base_col_map == k)
                if int(mine.sum()) >= 30:
                    px = pic_lab[mine]
                    d0 = np.sqrt((wL * (px[:, 0] - ref[0])) ** 2 + (px[:, 1] - ref[1]) ** 2 + (px[:, 2] - ref[2]) ** 2)
                    inliers = px[d0 < 32.0]
                    if len(inliers) >= 20:
                        emp = np.median(inliers, axis=0)
                        ref = 0.7 * emp + 0.3 * ref
                        calibrated[k] = True
            refs.append(ref)
            wLs.append(wL)

        # 2. For colours NOT yet present in `base` (brand-new colours like pink nose / white flowers / gold),
        # calibrate empirically from clean foreground pixels whose nearest colour among `codes` is k!
        if K > 0 and any(not c for c in calibrated) and clean.any():
            cy, cx = np.nonzero(clean)
            cpx = pic_lab[cy, cx]
            dists_all = np.empty((K, len(cy)), dtype=np.float32)
            for k in range(K):
                r_k, w_k = refs[k], wLs[k]
                dists_all[k] = np.sqrt(
                    (w_k * (cpx[:, 0] - r_k[0])) ** 2 + (cpx[:, 1] - r_k[1]) ** 2 + (cpx[:, 2] - r_k[2]) ** 2
                )
            nearest = np.argmin(dists_all, axis=0)
            for k in range(K):
                if calibrated[k]:
                    continue
                sel = (nearest == k) & (dists_all[k] < 45.0)
                if int(sel.sum()) >= 15:
                    emp = np.median(cpx[sel], axis=0)
                    refs[k] = 0.75 * emp + 0.25 * refs[k]
                    calibrated[k] = True

        self.col_planes = np.zeros((K, H, W), dtype=np.float32)
        for k in range(K):
            ref, wL = refs[k], wLs[k]
            dl = wL * (pic_lab[..., 0] - ref[0])
            da = pic_lab[..., 1] - ref[1]
            db = pic_lab[..., 2] - ref[2]
            dist = np.sqrt(dl * dl + da * da + db * db)
            sig = SIGMA_COLOUR if calibrated[k] else SIGMA_COLOUR_NEW
            plane = 2.0 * np.exp(-0.5 * (dist / sig) ** 2) - 1.0
            plane[self.ink_all | self.arrows | self.red_outline] = 0.0
            plane[~self.fg & ~self.arrows] = -PAPER_PENALTY
            self.col_planes[k] = plane.astype(np.float32)

        # Previous-step difference mask (optional)
        self.changed = _align_prev_picture(prev_rgb, picture, prev_pts=prev_pts) if prev_rgb is not None else None
        if self.changed is not None:
            # For fast sprite pre-scoring: reward changed pixels strongly; do NOT heavily penalise unchanged
            # pixels since same-colour-on-same-colour parts leave interior RGB unchanged!
            self.chg_plane = np.ascontiguousarray(
                CHANGE_WEIGHT * (self.changed.astype(np.float32) - 0.15 * (~self.changed & ~self.arrows).astype(np.float32)),
                dtype=np.float32,
            )
        else:
            self.chg_plane = None
        self.base_score = self.score([])

    def score(self, added: list) -> float:
        """Score `base + added` under the fixed camera. Higher is better."""
        return self._score_impl(added, False)[0]

    def score_and_vis(self, added: list) -> tuple[float, list[int]]:
        """Return `(score, [visible_px_per_added_part])` under the fixed camera."""
        return self._score_impl(added, True)

    def _score_impl(self, added: list, want_vis: bool) -> tuple[float, list[int]]:
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
            add_printed = np.array([_is_printed(p) for p, _c, _m in added], dtype=bool)
        else:
            all_cidx = self.base_colour_idx
            add_printed = np.zeros(0, dtype=bool)

        total = 0.0
        if covered.any() and len(all_cidx):
            ys, xs = np.nonzero(covered)
            lab_vals = label[ys, xs]
            cidx = all_cidx[lab_vals]
            ok = cidx >= 0
            if ok.any():
                vals = self.col_planes[cidx[ok], ys[ok], xs[ok]]
                # Printed parts (eyes, belt tiles, faces) carry multi-colour artwork on valid foreground:
                # keep full paper penalty on background, but don't punish artwork pixels on foreground as wrong colour!
                if len(add_printed) and add_printed.any():
                    lv_ok = lab_vals[ok]
                    is_new_pr = (lv_ok >= self.n_base)
                    if is_new_pr.any():
                        pr_mask = np.zeros(len(lv_ok), dtype=bool)
                        pr_mask[is_new_pr] = add_printed[lv_ok[is_new_pr] - self.n_base]
                        if pr_mask.any():
                            fg_ok = self.fg[ys[ok], xs[ok]]
                            clamp = pr_mask & fg_ok
                            if clamp.any():
                                vals = vals.copy()
                                vals[clamp] = np.maximum(vals[clamp], -0.1)
                total += float(vals.sum())
        # Penalise unexplained picture foreground (recall!)
        unexplained_fg = int(np.count_nonzero(self.fg & ~covered))
        total -= UNEXPLAINED_PENALTY * unexplained_fg

        # 2. Bidirectional edge matching (precision + recall)
        # Base edges survive only where finite and not occluded by `added` (guard np.isfinite so
        # background pixels where both base_edge_depth and depth are np.inf are NEVER marked as edges!)
        e_ren = _label_edges(label)
        if self.n_base:
            e_ren |= np.isfinite(self.base_edge_depth) & (self.base_edge_depth <= depth + DEPTH_TOL)
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
            on_changed = int(np.count_nonzero(new_vis & self.changed))
            # Only penalise unchanged pixels where the new part has a DIFFERENT colour than the base behind it
            # (same-colour-on-same-colour parts leave interior pixels unchanged!)
            unch = new_vis & ~self.changed & ~self.arrows
            if unch.any():
                uy, ux = np.nonzero(unch)
                new_c = add_cidx[label[uy, ux] - self.n_base]
                old_c = self.base_col_map[uy, ux]
                on_unch_diff = int(np.count_nonzero((old_c >= 0) & (old_c != new_c)))
            else:
                on_unch_diff = 0
            missed_changed = int(np.count_nonzero(self.changed & self.fg & ~new_vis))
            total += CHANGE_WEIGHT * (on_changed - 0.5 * on_unch_diff - 0.6 * missed_changed)

        if want_vis and added:
            n_a = len(added)
            lv_new = label[label >= self.n_base] - self.n_base
            vis_counts = np.bincount(lv_new, minlength=n_a).tolist()[:n_a] if len(lv_new) else [0] * n_a
            return float(total), vis_counts
        return float(total), []

    def score_seated_in_next(self, added: list) -> float:
        """Precision-focused consistency score of step N's SEATED parts against step N+1's picture.

        Unlike `score()`, this NEVER computes global `EDGE_REC` over step N+1's extra bricks and
        tolerates step N+1 building new bricks on top of step N's seated parts, while strictly
        enforcing the physical silhouette invariant: step N's seated parts MUST project inside
        step N+1's foreground (heavy penalty for sticking out onto bare paper) and match its colour
        where visible."""
        if not added:
            return 0.0
        d_add, l_add = render(self.lib, added, self.view, self.shape)
        nearer = d_add < self.base_depth
        if not nearer.any():
            return 0.0
        ys, xs = np.nonzero(nearer)
        add_cidx = np.array([self.code_idx.get(c, -1) for _p, c, _m in added], dtype=np.int32)
        add_printed = np.array([_is_printed(p) for p, _c, _m in added], dtype=bool)
        lv = l_add[ys, xs]
        cidx = add_cidx[lv]
        fg_px = self.fg[ys, xs]
        arr_px = self.arrows[ys, xs]
        paper_px = ~fg_px & ~arr_px

        total = -2.5 * PAPER_PENALTY * float(np.count_nonzero(paper_px))
        # Reward covering previously unexplained foreground in step N+1
        base_empty = self.base_label[ys, xs] < 0
        total += UNEXPLAINED_PENALTY * float(np.count_nonzero(fg_px & base_empty))

        # Calibrated colour consistency on foreground pixels (gentle on mismatches since step N+1
        # may have placed a different-coloured brick in front of this part!)
        ok_fg = fg_px & (cidx >= 0)
        if ok_fg.any():
            vals = self.col_planes[cidx[ok_fg], ys[ok_fg], xs[ok_fg]].copy()
            if add_printed.any():
                pr = add_printed[lv[ok_fg]]
                if pr.any():
                    vals[pr] = np.maximum(vals[pr], -0.1)
            new_col_score = np.where(vals >= 0.0, vals, 0.35 * vals)
            old_c = self.base_col_map[ys[ok_fg], xs[ok_fg]]
            had_old = old_c >= 0
            old_col_score = np.zeros_like(new_col_score)
            if had_old.any():
                ov = self.col_planes[old_c[had_old], ys[ok_fg][had_old], xs[ok_fg][had_old]]
                old_col_score[had_old] = np.where(ov >= 0.0, ov, 0.35 * ov)
            total += float((new_col_score - old_col_score).sum())

        # Positive edge precision only (never penalise occluded edges or chase step N+1's extra ink)
        depth = np.where(nearer, d_add, self.base_depth)
        add_ed = _edge_depth_map(self.lib, added, self.view, depth)
        add_edge = np.isfinite(add_ed) & nearer
        if add_edge.any():
            total += 0.5 * EDGE_PREC_WEIGHT * float(np.maximum(self.edge_prec_map[add_edge], 0.0).sum())
        return float(total)
