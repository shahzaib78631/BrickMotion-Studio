"""Centre-vote shortlist: which legal poses are worth scoring.

Each legal candidate pose has a box centre; where it projects is its *site*. A new pixel predicts the offset to
where its part's centre is drawn (`labels.centre_targets`), so `pixel + offset * scale` is a vote for a site. Votes
are soft (Gaussian in image px) and shared between step types of the same part by colour. A site the known model
would hide entirely at the voting pixel gets no vote from it. A centre cannot tell rotations about it apart (a 2x4
along x or z), so a site keeps all of its legal rotations: the shortlist of a type is every pose at its top sites.
"""
from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

from . import labels
from .camera import project
from .lattice import PoseTable


def half_uv(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Full-resolution pixel centre of half-resolution pixel (x, y): full-res pixel (2x, 2y), centre + 0.5."""
    return np.stack([2 * np.asarray(xs) + 0.5, 2 * np.asarray(ys) + 0.5], 1).astype(float)


def _colour_share(rgb: np.ndarray, keys: list, colours: dict, sigma: float) -> dict:
    share: dict = {}
    for part in {k[0] for k in keys}:
        same = [k for k in keys if k[0] == part and colours.get(k) is not None]
        if len(same) < 2:
            continue
        logit = np.stack([-((rgb - colours[k]) ** 2).sum(1) / (2 * sigma ** 2) for k in same])
        logit -= logit.max(0)
        p = np.exp(logit)
        p /= p.sum(0)
        share.update({k: p[i] for i, k in enumerate(same)})
    return share


def shortlist(uv, offset, weight, rgb, cam, centre, poses: dict, colours: dict, need: dict, depth=None,
              sigma_px: float = 3.0, sites_per_part: int = 3, extra_sites: int = 4, colour_sigma: float = 40.0,
              depth_tol: float = 4.0) -> tuple[dict, dict]:
    """Candidates per step type as (pose, site score) -- every rotation at a site shares its score; non-axis poses
    (`PoseTable.fallback`) are listed with score 0 -- and per-type info (sites, sites voted, kept, top scores).

    uv [N,2] full-res pixel centres; offset [N,2] (px / cam.scale); weight [N]; rgb [N,3]; depth [N] of the known
    model at those pixels (inf where empty). `poses`: legal poses per (part, colour). A type keeps its
    `sites_per_part * need + extra_sites` best sites."""
    uv = np.asarray(uv, float)
    target = uv + np.asarray(offset, float) * cam.scale
    weight = np.asarray(weight, float)
    rgb = np.asarray(rgb, float)
    share = _colour_share(rgb, list(poses), colours, colour_sigma)
    radius = 3.0 * sigma_px
    out: dict = {}
    info: dict = {}
    for key, plist in poses.items():
        table = PoseTable.build(key[0], plist)
        cand = list(table.poses)
        if not cand:
            out[key] = [(m, 0.0) for m in table.fallback]
            info[key] = dict(sites=0, voted=0, kept=len(table.fallback), top_scores=[])
            continue
        cw, ext = zip(*(labels.pose_centre_extent(key[0], m) for m in cand))
        cw, ext = np.array(cw), np.array(ext)
        cuv, cz = project(cam, centre, cw)
        # sites: candidates whose centres project to the same place (within 0.25 px) and lie at the same depth
        site_key = np.round(np.c_[cuv * 4, cz], 0)
        sites, site_of = np.unique(site_key, axis=0, return_inverse=True)
        site_of = site_of.ravel()
        n_site = len(sites)
        s_uv = np.zeros((n_site, 2))
        s_z = np.zeros(n_site)
        s_half = np.zeros(n_site)
        np.add.at(s_uv, site_of, cuv)
        np.add.at(s_z, site_of, cz)
        cnt = np.bincount(site_of, minlength=n_site)
        s_uv /= cnt[:, None]
        s_z /= cnt
        np.maximum.at(s_half, site_of, ext.max(1) / 2)
        w = weight * (share[key] if key in share else 1.0)
        score = np.zeros(n_site)
        tree = cKDTree(s_uv)
        hits = tree.query_ball_point(target, r=radius)
        for i, near in enumerate(hits):
            if not near:
                continue
            near = np.asarray(near)
            if depth is not None:
                # the known model hides the whole part at this pixel: its nearest point is behind the surface
                near = near[s_z[near] - s_half[near] <= depth[i] + depth_tol]
                if not len(near):
                    continue
            d2 = ((s_uv[near] - target[i]) ** 2).sum(1)
            score[near] += w[i] * np.exp(-d2 / (2 * sigma_px ** 2))
        keep_n = sites_per_part * int(need.get(key, 1)) + extra_sites
        top = [s for s in np.argsort(-score)[:keep_n] if score[s] > 0]
        chosen = set(top)
        kept = [(m, float(score[s])) for m, s in zip(cand, site_of) if s in chosen] + \
            [(m, 0.0) for m in table.fallback]
        out[key] = kept
        info[key] = dict(sites=int(n_site), voted=int((score > 0).sum()), kept=len(kept),
                         top_scores=[round(float(score[s]), 1) for s in top])
    return out, info


def consistency(part: str, pose, xs, ys, target, weight, newmask, base_depth, cam, centre, sigma_px: float = 3.0,
                depth_tol: float = 2.0) -> dict:
    """How well a candidate's drawn outline explains the pixels that voted for its centre (half resolution).

    The candidate is rendered alone at half resolution (depth only); a pixel of it is *visible* where its surface is
    in front of the known model there (`base_depth`, half-res, inf where empty). precision: share of the visible
    outline on new pixels. recall: weighted share of the pixels voting for this centre that the visible outline
    covers -- so a line-of-sight twin hidden under the base collects the votes but explains none of them.
    xs, ys: half-res new pixels; target [N,2]: their predicted centres (full-res px)."""
    from . import render as R
    h, w = newmask.shape
    half = cam.with_(scale=cam.scale / 2, cx=cam.cx / 2, cy=cam.cy / 2)
    d = R.gbuffer(*R.scene([(part, 0, np.asarray(pose, float))]), half, centre, w, h).depth
    vis = np.isfinite(d) & (d <= base_depth + depth_tol)
    precision = float((vis & newmask).sum() / max(vis.sum(), 1))
    c, _ext = labels.pose_centre_extent(part, pose)
    (cuv,), _z = project(cam, centre, c[None])
    near = ((np.asarray(target) - cuv) ** 2).sum(1) < (3 * sigma_px) ** 2
    wt = np.asarray(weight, float)[near]
    inside = vis[np.asarray(ys)[near], np.asarray(xs)[near]]
    recall = float((wt * inside).sum() / max(wt.sum(), 1e-9))
    return dict(precision=precision, recall=recall, voters=int(near.sum()), outline=int(vis.sum()))


def accepted(c: dict, min_precision: float = 0.8, min_recall: float = 0.6) -> bool:
    """A candidate explains its voters: most of its outline is new, and it covers most of the pixels that voted."""
    return c["precision"] >= min_precision and c["recall"] >= min_recall
